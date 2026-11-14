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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { itemIndex } from "./mirror_items.js";
import { outsideWorkspace } from "./private_paths.js";
import { redactSecrets } from "./secrets.js";
import { eligibleLocalRows, readLocalSource } from "./source_local.js";
import {
  fetchRemoteRecord,
  fetchRemoteSource,
  putConfluencePage,
  remoteScope,
} from "./source_remote.js";
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
  const state = outsideWorkspace(
    tree,
    resolve(userStateDir(), "sources"),
    "Set FORGE_HOME outside the working tree for private source caches",
  );
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
 * chunks?:number,partial?:boolean,warnings?:string[],pack?:string,checkpoint?:string,lastReconciled?:string,retryAt?:number}} */
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
    if (m.error)
      return {
        ...base,
        status: "unavailable",
        reason: m.error,
        retryAt: Number.isFinite(m.retryAt) ? m.retryAt : undefined,
      };
    if (m.version !== 1 || !Number.isFinite(m.at)) throw new Error("Unsupported snapshot");
    const age = now - m.at;
    const expired =
      age < 0 || (source.provider !== "local" && age >= (source.ttlSeconds ?? 900) * 1000);
    return {
      ...base,
      status: expired ? "expired" : "ready",
      cachedAt: new Date(m.at).toISOString(),
      checkpoint: m.checkpoint,
      lastReconciled: m.lastReconciled,
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
        ordinal: start / 1800,
        kind: doc.kind,
        version: doc.version,
        status: typeof doc.status === "string" ? redactSecrets(doc.status).slice(0, 160) : null,
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
// A permission-scoped ID walk validates unchanged rows; a watermark alone cannot
// detect deletions, revocations, newly visible old records or back-dated updates.
async function remoteRefresh(source, previous) {
  if (!previous?.checkpoint || !previous.pack)
    return { ...(await fetchRemoteSource(source)), rows: undefined };
  const old = previousRows(previous.pack);
  if (old.length !== previous.chunks)
    return { ...(await fetchRemoteSource(source)), rows: undefined };
  const delta = await fetchRemoteSource(source, { since: previous.checkpoint });
  const ids = await fetchRemoteSource(source, { idsOnly: true });
  const modified = new Map(delta.documents.map((d) => [d.recordId, d]));
  const prior = new Map(old.map((r) => [r.recordId, r.updatedAt]));
  const visible = new Set(ids.documents.map((d) => d.recordId));
  // A missing/newer timestamp can arise when access is granted mid-window. Rebuild
  // a bounded full snapshot rather than issuing N single-record requests.
  for (const d of ids.documents) {
    if (
      !modified.has(d.recordId) &&
      (!prior.has(d.recordId) || (d.updatedAt && prior.get(d.recordId) !== d.updatedAt))
    )
      return { ...(await fetchRemoteSource(source)), rows: undefined };
    const newer = modified.get(d.recordId);
    if (newer && d.updatedAt && d.updatedAt !== newer.updatedAt)
      return { ...(await fetchRemoteSource(source)), rows: undefined };
  }
  const rows = old.filter((r) => visible.has(r.recordId) && !modified.has(r.recordId));
  rows.push(
    ...remoteRows(
      delta.documents.filter((d) => visible.has(d.recordId)),
      source.id,
    ),
  );
  return { ...delta, rows };
}

function publishSnapshot(dir, generation, rows, manifest) {
  if (rows.length > MAX_CHUNKS) throw new Error("Source chunk limit exceeded");
  publish(dir, generation, "evidence.pack", makePack(rows));
  const items = JSON.stringify(itemIndex(rows));
  if (Buffer.byteLength(items) > MAX_PACK)
    throw new Error("Source manifest exceeds its size limit");
  publish(dir, generation, "items.json", items);
  publish(
    dir,
    generation,
    "result.json",
    JSON.stringify({ ...manifest, version: 1, chunks: rows.length }),
  );
}

async function refresh(configPath, source, full = false) {
  const dir = sourceDir(configPath, source);
  const previous = metadata(configPath, source);
  if (previous.retryAt > Date.now())
    return { id: source.id, ok: false, error: previous.reason, retryAt: previous.retryAt };
  const { generation, old } = reserve(dir);
  let scope;
  try {
    scope = identity(source);
    let checkpoint, lastReconciled, mode;
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
      const validPrevious =
        ["ready", "expired"].includes(previous.status) && !full ? previous : null;
      const data = await remoteRefresh(source, validPrevious);
      rows = data.rows ?? remoteRows(data.documents, source.id);
      checkpoint = data.checkpoint;
      lastReconciled = new Date().toISOString();
      mode = data.mode;
    }
    if (identity(source) !== scope) throw new Error("Source or credentials changed during refresh");
    warnings = warnings.slice(0, 24).map((w) => redactSecrets(String(w)).slice(0, 350));
    publishSnapshot(dir, generation, rows, {
      at: Date.now(),
      scope,
      partial,
      warnings,
      checkpoint,
      lastReconciled,
    });
    return {
      id: source.id,
      ok: true,
      chunks: rows.length,
      partial,
      warnings,
      mode,
      lastReconciled,
    };
  } catch (e) {
    const error = redactSecrets(String(e.message)).slice(0, 480);
    try {
      for (const file of ["evidence.pack", "items.json"])
        rmSync(join(dir, generation, file), { force: true });
      publish(dir, generation, "result.json", JSON.stringify({ scope, error, retryAt: e.retryAt }));
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // A newer refresh already removed this generation.
      return { id: source.id, ok: false, error: "Refresh superseded by a later sync" };
    }
    return { id: source.id, ok: false, error, retryAt: e.retryAt };
  } finally {
    for (const name of old) rmSync(join(dir, name), { recursive: true, force: true });
  }
}
/** Explicit full reconciliation. A failed sync hides the last generation for that ID. */
export async function syncSources(root, { sourceId = undefined, full = false } = {}) {
  const cfg = configuration(root);
  const sources = [];
  for (const source of selected(cfg.sources, sourceId))
    sources.push(await refresh(cfg.configPath, source, full));
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
  const record = await observedRecord(cfg, source, recordId);
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
}

function invalidateSource(cfg, source, scope, error) {
  const dir = sourceDir(cfg.configPath, source);
  const { generation, old } = reserve(dir);
  try {
    publish(dir, generation, "result.json", JSON.stringify({ scope, error }));
  } finally {
    for (const n of old) rmSync(join(dir, n), { recursive: true, force: true });
  }
}

async function observedRecord(cfg, source, id) {
  const scope = identity(source);
  try {
    return await fetchRemoteRecord(source, id);
  } catch (e) {
    if ([401, 403, 404, 410].includes(e.status))
      invalidateSource(
        cfg,
        source,
        scope,
        "Live provider access failed. Sync the source to reconcile access and deletions.",
      );
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
      const paths = eligibleLocalRows(source, rows, sourceWorkspaceRoot(root));
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
        itemId: r.recordId ?? r.path,
        chunk: Number.isSafeInteger(r.ordinal) ? r.ordinal : undefined,
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

/** A mirror session pins one complete, identity-checked generation, including its authorization
 * decisions. Re-check the configuration and generation before returning an answer. */
export function openSourceMirror(root, id) {
  if (typeof id !== "string") throw new Error("Select a configured source");
  const cfg = configuration(root);
  const [source] = selected(cfg.sources, id);
  const meta = metadata(cfg.configPath, source);
  if (meta.status !== "ready") throw new Error(`Mirror ${meta.status}; run sources sync`);
  const dir = dirname(meta.pack);
  const path = join(dir, "items.json");
  const index = openIndex(meta.pack);
  try {
    // Backward compatibility for pre-manifest snapshots. They still respect current permissions.
    const items = existsSync(path)
      ? jsonFile(path, MAX_PACK)
      : itemIndex(index.header.r.map(index.read));
    if (!Array.isArray(items) || items.length > MAX_CHUNKS) throw new Error("Invalid mirror index");
    const allowed = new Set();
    if (source.provider === "local")
      for (let i = 0; i < items.length; i += 64)
        for (const p of eligibleLocalRows(
          source,
          items.slice(i, i + 64),
          sourceWorkspaceRoot(root),
        ))
          allowed.add(p);
    const visible = source.provider === "local" ? items.filter((r) => allowed.has(r.path)) : items;
    return {
      meta,
      source,
      dir,
      items: visible,
      partial: !!meta.partial || visible.length < items.length,
      read: (ordinal) => index.read(index.header.r[ordinal]),
      close: index.close,
      confirm() {
        const current = getSource(root, id);
        const latest = metadata(cfg.configPath, current);
        if (latest.status !== "ready" || latest.pack !== meta.pack)
          throw new Error("Source changed during the mirror read; retry");
        if (current.provider === "local") {
          for (let i = 0; i < visible.length; i += 64) {
            const group = visible.slice(i, i + 64);
            if (eligibleLocalRows(current, group, sourceWorkspaceRoot(root)).size !== group.length)
              throw new Error("Local permissions or content changed during the mirror read; retry");
          }
        }
      },
    };
  } catch (err) {
    index.close();
    throw err;
  }
}

// Replace just the freshly observed page in the current generation. Retain the
// original snapshot timestamp and checkpoint: nothing reauthorized its neighbors.
function cacheLivePage(cfg, source, scope, doc) {
  const meta = metadata(cfg.configPath, source);
  if (meta.status !== "ready" || identity(source) !== scope) return false;
  const index = openIndex(meta.pack);
  let rows;
  try {
    rows = index.header.r.map(index.read).filter((r) => r.recordId !== doc.recordId);
  } finally {
    index.close();
  }
  const dir = sourceDir(cfg.configPath, source);
  rows.push(...remoteRows([doc], source.id));
  const { generation, old } = reserve(dir);
  try {
    publishSnapshot(dir, generation, rows, {
      at: Date.parse(meta.cachedAt),
      scope,
      partial: meta.partial,
      warnings: meta.warnings,
      checkpoint: meta.checkpoint,
      lastReconciled: meta.lastReconciled,
    });
  } finally {
    for (const name of old) rmSync(join(dir, name), { recursive: true, force: true });
  }
  return true;
}

/** Explicit Confluence CAS. A changed baseline aborts before PUT. An ambiguous
 * network result is re-read once and never automatically retried. */
export async function writeSourcePage(
  root,
  sourceId,
  recordId,
  { expectedVersion, title, storage },
) {
  const source = getSource(root, sourceId);
  if (source.provider !== "confluence" || source.allowWrites !== true)
    throw new Error("Confluence requires allowWrites:true in this user's private source config");
  if (
    typeof recordId !== "string" ||
    !/^\d{1,128}$/.test(recordId) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  )
    throw new Error("Supply a numeric page ID and the observed positive version");
  const cfg = configuration(root);
  const scope = identity(source);
  const { mirrorGet } = await import("./source_mirror.js");
  const entry = mirrorGet(root, sourceId, { id: recordId });
  if (!("item" in entry)) throw new Error("Missing cached page metadata");
  const cached = entry.item;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 255 ||
    typeof storage !== "string" ||
    !storage.trim() ||
    Buffer.byteLength(storage) > 1024 * 1024
  )
    throw new Error("Provide a title and storage-format body up to 1 MiB");
  if (cached.version !== expectedVersion)
    return {
      ok: false,
      status: "conflict",
      expectedVersion,
      currentVersion: cached.version,
      written: false,
    };
  const before = await observedRecord(cfg, source, recordId);
  const currentSource = getSource(root, sourceId);
  if (
    identity(currentSource) !== scope ||
    currentSource.allowWrites !== true ||
    before.kind !== "page"
  )
    throw new Error("Source permissions or configuration changed; restart the update");
  if (before.version !== expectedVersion || before.updatedAt !== cached.updatedAt) {
    cacheLivePage(cfg, source, scope, before);
    return {
      ok: false,
      status: "conflict",
      expectedVersion,
      currentVersion: before.version,
      written: false,
    };
  }
  let putError;
  try {
    const ack = await putConfluencePage(source, recordId, { expectedVersion, title, storage });
    if (String(ack?.id) !== recordId || ack?.version?.number !== expectedVersion + 1)
      putError = "unconfirmed";
  } catch (err) {
    if (err.status && err.status !== 409 && err.status < 500) {
      if ([401, 403, 404, 410].includes(err.status))
        invalidateSource(cfg, source, scope, "Provider rejected page update; sync the source");
      throw err;
    }
    putError = err.status === 409 ? "conflict" : "unconfirmed";
  }
  // A conflict, a lost response, or a successful PUT each get exactly one
  // reconciliation read. Only a confirmed PUT + exact live revision is success.
  try {
    const current = await observedRecord(cfg, source, recordId);
    const updated = cacheLivePage(cfg, source, scope, current);
    if (putError === "conflict")
      return {
        ok: false,
        status: "conflict",
        written: false,
        currentVersion: current.version,
        mirrored: updated,
      };
    if (putError || current.version !== expectedVersion + 1 || current.title !== title || !updated)
      return {
        ok: false,
        status: putError ? "unconfirmed" : "applied_unverified",
        written: putError ? null : true,
        currentVersion: current.version,
        mirrored: updated,
      };
    return {
      ok: true,
      status: "verified",
      written: true,
      currentVersion: current.version,
      mirrored: true,
    };
  } catch {
    // Removing visibility is safer than leaving an older version as a ready answer.
    if (identity(source) === scope && metadata(cfg.configPath, source).status === "ready")
      invalidateSource(cfg, source, scope, "Page update could not be reconciled; sync the source");
    return {
      ok: false,
      status: putError ?? "applied_unverified",
      written: putError === "conflict" ? false : putError ? null : true,
      mirrored: false,
    };
  }
}
