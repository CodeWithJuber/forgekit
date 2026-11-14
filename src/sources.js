// Private per-working-tree evidence snapshots. Epoch names order competing syncs: an older
// fetch can finish last, but can never republish over a newer attempt (including a denial).
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "./secrets.js";
import { eligibleLocalRows, readLocalSource } from "./source_local.js";
import { fetchRemoteSource, remoteScope } from "./source_remote.js";
import { contentHash, userStateDir } from "./util.js";

const MAX_SOURCES = 12;
const MAX_CHUNKS = 1200;
const MAX_PACK = 12 * 1024 * 1024;
const HEADER_BYTES = 128 * 1024;
const BUCKETS = 128;
const MAX_QUERY_TERMS = 20;
const STOP = new Set(
  "a an the is it of to for and or in with from as i we you this that be please how should kya hai ko ka ki ke kar karo".split(
    " ",
  ),
);
const within = (dir, path) => {
  const rel = relative(dir, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
const tokenList = (value) =>
  (
    String(value)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((t) => t.length <= 80 && !STOP.has(t));
function bucket(term) {
  let h = 0;
  for (const ch of term) h = (31 * h + ch.charCodeAt(0)) | 0;
  return (h >>> 0) % BUCKETS;
}
function jsonFile(path, max) {
  if (statSync(path).size > max) throw new Error("Evidence metadata exceeds the read limit");
  return JSON.parse(readFileSync(path, "utf8"));
}
/** Canonical working tree for repository-scoped evidence; keep standalone folders distinct. */
export function sourceWorkspaceRoot(root) {
  const tree = realpathSync(root);
  // Agent hook cwd may be a package folder. A linked worktree has a .git file.
  for (let dir = tree; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return tree;
  }
}
function configPathFor(root) {
  const tree = sourceWorkspaceRoot(root);
  const state = resolve(userStateDir(), "sources");
  // A custom FORGE_HOME inside a checkout must not turn private files into tracked inputs.
  if (within(tree, state))
    throw new Error("Set FORGE_HOME outside the working tree for private source caches");
  return join(state, contentHash(tree), "config.json");
}

/** Create a private config once. Re-running preserves local edits. */
export function initSources(root) {
  const configPath = configPathFor(root);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(configPath, '{\n  "sources": []\n}\n', { flag: "wx", mode: 0o600 });
    return { configPath, created: true };
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return { configPath, created: false };
  }
}

function configuration(root) {
  const configPath = configPathFor(root);
  if (!existsSync(configPath)) return { configPath, sources: [] };
  const { sources } = jsonFile(configPath, 64 * 1024);
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES)
    throw new Error(`Expected sources array (up to ${MAX_SOURCES})`);
  const ids = new Set();
  for (const source of sources) {
    if (
      typeof source?.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(source.id) ||
      ids.has(source.id)
    )
      throw new Error(
        "Source IDs must be unique, 1–64 alphanumeric, dash or underscore characters",
      );
    ids.add(source.id);
    if (!["local", "jira", "confluence", "gitlab"].includes(source.provider))
      throw new Error("Unknown source provider");
    if (
      source.provider === "local" &&
      (typeof source.root !== "string" || !isAbsolute(source.root))
    )
      throw new Error(`Set an absolute local root for ${source.id}`);
    if (
      source.ttlSeconds !== undefined &&
      (!Number.isSafeInteger(source.ttlSeconds) ||
        source.ttlSeconds < 1 ||
        source.ttlSeconds > 86400)
    )
      throw new Error("ttlSeconds must be an integer from 1 to 86400");
  }
  return { configPath, sources };
}

function selected(sources, id) {
  if (id === undefined) return sources;
  const source = sources.find((s) => s.id === id);
  if (!source) throw new Error("Unknown configured source ID");
  return [source];
}
/** Resolve a trusted source by ID; provider credentials stay in the process environment. */
export function getSource(root, id) {
  if (typeof id !== "string") throw new Error("Expected a source ID");
  return selected(configuration(root).sources, id)[0];
}

function identity(source) {
  return source.provider === "local"
    ? contentHash(JSON.stringify(["local", realpathSync(source.root)]))
    : remoteScope(source);
}
const sourceDir = (configPath, source) => join(dirname(configPath), `source-${source.id}`);
function generations(dir) {
  try {
    return readdirSync(dir)
      .filter((n) => /^g-\d{12}$/.test(n))
      .sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
function reserve(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 16; attempt++) {
    const old = generations(dir);
    const seq = Number(old.at(-1)?.slice(2) ?? 0) + 1;
    const generation = `g-${String(seq).padStart(12, "0")}`;
    try {
      mkdirSync(join(dir, generation), { mode: 0o700 });
      return { generation, old };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error("Concurrent source refreshes; retry");
}
/** @returns {{id:string,provider:string,status:string,reason?:string,cachedAt?:string,
 * chunks?:number,partial?:boolean,warnings?:string[],pack?:string}} */
function metadata(configPath, source, now = Date.now()) {
  const base = { id: source.id, provider: source.provider };
  const dir = sourceDir(configPath, source);
  const g = generations(dir).at(-1);
  if (!g) return { ...base, status: "missing" };
  const manifest = join(dir, g, "result.json");
  try {
    const scope = identity(source);
    if (!existsSync(manifest))
      return {
        ...base,
        status: "unavailable",
        reason: "Refresh unfinished; run sources sync to retry",
      };
    const m = jsonFile(manifest, 32 * 1024);
    if (m.scope !== scope)
      return { ...base, status: "missing", reason: "Source or credentials changed" };
    if (m.error) return { ...base, status: "unavailable", reason: m.error };
    if (m.version !== 1 || !Number.isFinite(m.at)) throw new Error("Unsupported snapshot");
    const age = now - m.at;
    const expired =
      age < 0 || (source.provider !== "local" && age >= (source.ttlSeconds ?? 900) * 1000);
    return {
      ...base,
      status: expired ? "expired" : "ready",
      cachedAt: new Date(m.at).toISOString(),
      chunks: m.chunks,
      partial: !!m.partial,
      warnings: m.warnings ?? [],
      pack: join(dir, g, "evidence.pack"),
    };
  } catch (e) {
    return { ...base, status: "unavailable", reason: e.message };
  }
}
/** Show source readiness without reading stored source text or making network calls. */
export function sourcesStatus(root) {
  const { configPath, sources } = configuration(root);
  return {
    configPath,
    sources: sources.map((source) => {
      const { pack, ...s } = metadata(configPath, source);
      return s;
    }),
  };
}

// File layout: 4-byte header length; JSON offsets; 128 term-posting buckets; length-addressed JSON rows.
// A query reads only buckets for its terms, and the rows from which it takes snippets.
function makePack(rows) {
  const postings = Array.from({ length: BUCKETS }, () => new Map());
  const parts = [],
    lengths = [],
    addresses = [];
  let size = 0;
  for (const [i, row] of rows.entries()) {
    const body = JSON.stringify(row);
    const bytes = Buffer.from(body);
    if (bytes.length > 64 * 1024) throw new Error("Individual evidence row exceeds size limit");
    size += bytes.length;
    if (size > MAX_PACK)
      throw new Error("Source exceeds private index limit; narrow the source folder or project");
    const fields = tokenList(`${row.path} ${row.title ?? ""} ${row.locator}`);
    const terms = [...fields, ...fields, ...tokenList(row.text)];
    lengths.push(terms.length);
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      const b = postings[bucket(term)];
      if (!b.has(term)) b.set(term, []);
      b.get(term).push(i, tf);
    }
    parts.push(bytes);
  }
  let offset = 0;
  const buckets = postings.map((b) => {
    const bytes = Buffer.from(JSON.stringify(Object.fromEntries(b)));
    const at = offset;
    offset += bytes.length;
    return { bytes, range: [at, bytes.length] };
  });
  for (const bytes of parts) {
    addresses.push([offset, bytes.length]);
    offset += bytes.length;
  }
  const header = Buffer.from(
    JSON.stringify({ b: buckets.map((b) => b.range), r: addresses, l: lengths }),
  );
  if (header.length > HEADER_BYTES || header.length + offset + 4 > MAX_PACK)
    throw new Error("Source exceeds private index limit; narrow the source folder or project");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, ...buckets.map((b) => b.bytes), ...parts]);
}

function readAt(fd, pos, len) {
  if (
    !Number.isSafeInteger(pos) ||
    pos < 0 ||
    !Number.isSafeInteger(len) ||
    len < 0 ||
    len > MAX_PACK ||
    pos + len > MAX_PACK
  )
    throw new Error("Invalid source index offset");
  const b = Buffer.alloc(len);
  let count = 0;
  while (count < len) {
    const bytes = readSync(fd, b, count, len - count, pos + count);
    if (!bytes) throw new Error("Incomplete source index");
    count += bytes;
  }
  return b;
}
function openIndex(path) {
  const fd = openSync(path, "r");
  try {
    if (fstatSync(fd).size > MAX_PACK) throw new Error("Oversized source index");
    const len = readAt(fd, 0, 4).readUInt32BE();
    if (len > HEADER_BYTES) throw new Error("Invalid source index header");
    const header = JSON.parse(readAt(fd, 4, len).toString());
    if (
      !Array.isArray(header.r) ||
      header.r.length > MAX_CHUNKS ||
      header.r.length !== header.l?.length ||
      header.b?.length !== BUCKETS
    )
      throw new Error("Invalid source index");
    const read = ([offset, n]) => JSON.parse(readAt(fd, 4 + len + offset, n).toString());
    return { header, read, close: () => closeSync(fd) };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

function remoteRows(documents, sourceId) {
  const rows = [];
  for (const doc of documents) {
    const text = redactSecrets(String(doc.text || doc.title));
    for (let start = 0; start < text.length; start += 1800) {
      if (rows.length >= MAX_CHUNKS)
        throw new Error("Too many remote chunks; narrow the source project or space");
      rows.push({
        sourceId,
        path: doc.url,
        title: redactSecrets(doc.title),
        recordId: doc.recordId,
        locator: `record ${doc.recordId}, chars ${start + 1}-${Math.min(start + 1800, text.length)}`,
        text: text.slice(start, start + 1800),
        updatedAt: doc.updatedAt,
      });
    }
  }
  return rows;
}
function previousRows(pack) {
  if (!pack) return [];
  let index;
  try {
    index = openIndex(pack);
    return index.header.r.map(index.read);
  } catch {
    return [];
  } finally {
    index?.close();
  }
}

function publish(dir, generation, name, bytes) {
  // Stage outside the generation: if superseded while writing, the removed generation
  // cannot accidentally be recreated. Keep all data and temporary files user-only.
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(tmp, join(dir, generation, name));
  } finally {
    rmSync(tmp, { force: true });
  }
}
async function refresh(configPath, source) {
  const dir = sourceDir(configPath, source);
  const previous = source.provider === "local" ? metadata(configPath, source) : null;
  const { generation, old } = reserve(dir);
  let scope;
  try {
    scope = identity(source);
    let rows,
      warnings = [],
      partial = false;
    if (source.provider === "local") {
      const local = await readLocalSource(source, {
        maxChunks: MAX_CHUNKS,
        previousChunks: previous?.status === "ready" ? previousRows(previous.pack) : [],
      });
      rows = local.chunks;
      warnings = local.warnings;
      partial = local.truncated || warnings.length > 0;
    } else {
      rows = remoteRows((await fetchRemoteSource(source)).documents, source.id);
    }
    if (rows.length > MAX_CHUNKS) throw new Error("Source chunk limit exceeded");
    if (identity(source) !== scope) throw new Error("Source or credentials changed during refresh");
    warnings = warnings.slice(0, 24).map((w) => redactSecrets(String(w)).slice(0, 350));
    publish(dir, generation, "evidence.pack", makePack(rows));
    publish(
      dir,
      generation,
      "result.json",
      JSON.stringify({ version: 1, at: Date.now(), scope, chunks: rows.length, partial, warnings }),
    );
    return { id: source.id, ok: true, chunks: rows.length, partial, warnings };
  } catch (e) {
    const error = redactSecrets(String(e.message)).slice(0, 480);
    try {
      publish(dir, generation, "result.json", JSON.stringify({ scope, error }));
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // A newer refresh already removed this generation.
      return { id: source.id, ok: false, error: "Refresh superseded by a later sync" };
    }
    return { id: source.id, ok: false, error };
  } finally {
    for (const name of old) rmSync(join(dir, name), { recursive: true, force: true });
  }
}
/** Explicit full reconciliation. A failed sync hides the last generation for that ID. */
export async function syncSources(root, { sourceId = undefined } = {}) {
  const cfg = configuration(root);
  const sources = [];
  for (const source of selected(cfg.sources, sourceId))
    sources.push(await refresh(cfg.configPath, source));
  return { configPath: cfg.configPath, ok: sources.every((s) => s.ok), sources };
}

/** An explicitly requested live API read. A denial also invalidates any cached snapshot.
 * This does not copy a single updated record into a full, potentially older snapshot. */
export async function readSourceRecord(root, id, recordId, { offset = 0, limit = 8000 } = {}) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16000
  )
    throw new Error("Set a nonnegative UTF-16 offset and a limit of 1–16000 code units");
  const cfg = configuration(root);
  if (typeof id !== "string") throw new Error("Select a configured remote source");
  const [source] = selected(cfg.sources, id);
  if (source.provider === "local") throw new Error("Select a configured remote source");
  const { fetchRemoteRecord } = await import("./source_remote.js");
  const scope = identity(source);
  try {
    const record = await fetchRemoteRecord(source, recordId);
    const full = redactSecrets(record.text);
    if (offset > full.length) throw new Error("Offset beyond the current redacted record length");
    const end = Math.min(full.length, offset + limit);
    return {
      ...record,
      title: redactSecrets(record.title).slice(0, 600),
      text: full.slice(offset, end),
      offset,
      nextOffset: end < full.length ? end : null,
      totalChars: full.length,
    };
  } catch (e) {
    if ([401, 403, 404, 410].includes(e.status)) {
      const dir = sourceDir(cfg.configPath, source);
      const { generation, old } = reserve(dir);
      const error =
        "Live provider access failed. Sync the source to reconcile access and deletions.";
      try {
        publish(dir, generation, "result.json", JSON.stringify({ scope, error }));
      } finally {
        for (const name of old) rmSync(join(dir, name), { recursive: true, force: true });
      }
    }
    throw e;
  }
}

function matchingIndex(pack, terms) {
  const index = openIndex(pack);
  try {
    const buckets = new Map();
    const postings = new Map();
    for (const term of terms) {
      const n = bucket(term);
      if (!buckets.has(n)) buckets.set(n, index.read(index.header.b[n]));
      const dict = buckets.get(n);
      if (Object.hasOwn(dict, term)) postings.set(term, dict[term]);
    }
    return { ...index, postings };
  } catch (e) {
    index.close();
    throw e;
  }
}

/** Search fresh private snapshots offline. BM25 uses global DF across selected snapshots.
 *  The rendered citation + JSON-quoted text stays within the chars/3.6 token estimate. */
export function searchSources(root, query, { budget = 600, sourceId = undefined } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8192)
    throw new Error("Set budget to 1–8192 estimated tokens");
  const cfg = configuration(root);
  const terms = [...new Set(tokenList(String(query ?? "").slice(0, 4000)))].slice(
    0,
    MAX_QUERY_TERMS,
  );
  const sources = selected(cfg.sources, sourceId);
  const indexes = [],
    warnings = [],
    hits = [],
    lines = [];
  const df = new Map();
  let docs = 0,
    totalLength = 0;
  try {
    for (const source of sources) {
      const meta = metadata(cfg.configPath, source);
      if (meta.status !== "ready") {
        warnings.push(`${source.id}: ${meta.status}, ${meta.reason ?? "sync this source"}`);
        continue;
      }
      if (meta.partial)
        warnings.push(`${source.id}: partial snapshot; see sources status for details`);
      if (!terms.length) continue;
      try {
        const index = matchingIndex(meta.pack, terms);
        indexes.push({ source, meta, index });
        docs += index.header.l.length;
        totalLength += index.header.l.reduce((a, b) => a + b, 0);
        for (const [term, list] of index.postings)
          df.set(term, (df.get(term) ?? 0) + list.length / 2);
      } catch (e) {
        warnings.push(`${source.id}: ${e.message}; run sources sync`);
      }
    }
    const best = [];
    const avg = totalLength / docs || 1;
    for (const entry of indexes) {
      const { index } = entry;
      const scores = new Map();
      for (const [term, list] of index.postings) {
        const freq = df.get(term);
        const idf = Math.log(1 + (docs - freq + 0.5) / (freq + 0.5));
        for (let i = 0; i < list.length; i += 2) {
          const row = list[i],
            tf = list[i + 1];
          const weight = (tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * index.header.l[row]) / avg));
          scores.set(row, (scores.get(row) ?? 0) + idf * weight);
        }
      }
      for (const [row, score] of scores) best.push({ entry, row, score });
    }
    best.sort(
      (a, b) =>
        b.score - a.score || a.entry.source.id.localeCompare(b.entry.source.id) || a.row - b.row,
    );
    // Revalidate local hits in batches per source, including git-ignore changes. When
    // the original file changed or became inaccessible, its cached text is unusable.
    const candidates = best.slice(0, 64).map(({ entry, row, score }) => ({
      entry,
      score,
      r: entry.index.read(entry.index.header.r[row]),
    }));
    const allowed = new Map();
    for (const { source } of indexes) {
      if (source.provider !== "local") continue;
      const rows = candidates.filter((c) => c.entry.source.id === source.id).map((c) => c.r);
      if (!rows.length) continue;
      const paths = eligibleLocalRows(source, rows);
      allowed.set(source.id, paths);
      if (rows.some((r) => !paths.has(r.path)))
        warnings.push(
          `${source.id}: skipped files changed or no longer accessible; run sources sync`,
        );
    }
    let left = Math.floor(budget * 3.6);
    for (const { entry, r, score } of candidates) {
      if (entry.source.provider === "local" && !allowed.get(entry.source.id)?.has(r.path)) continue;
      // JSON strings keep source newlines/control characters inside the quoted evidence.
      const label = JSON.stringify([entry.source.id, r.path, r.locator, entry.meta.cachedAt]);
      const room = left - label.length - 4 - (lines.length ? 1 : 0);
      if (room < 12) continue;
      const lower = r.text.toLowerCase();
      const first =
        terms
          .map((t) => lower.indexOf(t))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, first - 90);
      let text = r.text.slice(start, start + Math.min(500, room));
      let quoted = JSON.stringify(text);
      while (quoted.length > room && text.length) {
        text = text.slice(0, Math.max(0, text.length - Math.ceil((quoted.length - room) / 2)));
        quoted = JSON.stringify(text);
      }
      if (!text) continue;
      const line = `${label} ${quoted}`;
      left -= line.length + (lines.length ? 1 : 0);
      lines.push(line);
      hits.push({
        sourceId: entry.source.id,
        path: r.path,
        locator: r.locator,
        title: r.title,
        updatedAt: r.updatedAt,
        recordId: r.recordId,
        cachedAt: entry.meta.cachedAt,
        text,
        score,
      });
      if (hits.length >= 12) break;
    }
    const text = lines.join("\n");
    return { hits, warnings, text, estimatedTokens: Math.ceil(text.length / 3.6) };
  } finally {
    for (const { index } of indexes) index.close();
  }
}
