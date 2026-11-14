// Read-only, explicitly selected local roots. Git supplies ignore semantics for both
// repositories and standalone folders. Conversion is bounded and never uses a shell.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./secrets.js";
import { CODE_EXT, contentHash, IGNORE_DIRS, toPosix, userStateDir } from "./util.js";

const MAX_BYTES = 8 * 1024 * 1024;
const TABLE = /\.(?:csv|tsv|xlsx?)$/i;
const TEXT = /\.(?:txt|rst|mdx|sql|sh|kt|kts|scala|swift|zig|exs?|lua|tf|xml|properties|proto)$/i;
const SECRET_NAME =
  /^(?:credentials?(?:[._-]|$)|secrets?(?:[._-]|$)|id_rsa|id_ed25519)|\.(?:key|pem|pfx|p12|kdbx)$/i;
const READER = fileURLToPath(new URL("./source_table.py", import.meta.url));
const PARSER_VERSION = "source-local-v1";

function safePath(rel) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in filesystem citations.
  if (!rel || isAbsolute(rel) || /[\\\u0000-\u001f]/.test(rel)) return false;
  return rel
    .split("/")
    .every((s) => s && !s.startsWith(".") && !IGNORE_DIRS.has(s) && !SECRET_NAME.test(s));
}

function limit(value, fallback, ceiling) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new Error("invalid local source limit");
  return value;
}

// An empty index makes even an accidentally tracked, ignored credential file ineligible.
// Standalone folders get a disposable empty Git directory, leaving the source untouched.
function listFiles(root, only = null, timeout = 8000) {
  const state = resolve(userStateDir());
  let privateDir = state;
  try {
    privateDir = realpathSync(state);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const inState = (path) => {
    const rel = toPosix(relative(privateDir, path));
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
  };
  if (inState(root)) throw new Error("Forge private state cannot be used as a source");
  const temp = mkdtempSync(join(tmpdir(), "forge-source-"));
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(temp, "index"),
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
    ])
      delete env[key];
    const run = (args) =>
      spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      });
    const probe = run(["rev-parse", "--is-inside-work-tree"]);
    if (probe.error) throw new Error("local sources require Git on PATH");
    let work = [];
    if (probe.stdout?.trim() !== "true") {
      // A denied or corrupt repository must never silently change to standalone-folder
      // rules: that would drop .git/info/exclude and ancestor ignore semantics.
      if (probe.status !== 128 || !probe.stderr.includes("not a git repository")) {
        throw new Error("Git could not verify this source's working-tree scope");
      }
      const dir = join(temp, "empty.git");
      if (run(["init", "--quiet", "--bare", "--template=", dir]).status !== 0)
        throw new Error("could not initialize local ignore filter");
      work = ["--git-dir", dir, "--work-tree", root];
    }
    const result = run([
      ...work,
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...(only ?? ["."]),
    ]);
    if (result.status !== 0 || result.error)
      throw new Error("file discovery failed or exceeded its limit; select a smaller folder");
    return result.stdout
      .split("\0")
      .filter((path) => safePath(path) && !inState(resolve(root, path)));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function rootDir(source) {
  if (typeof source?.root !== "string" || !isAbsolute(source.root))
    throw new Error("local source requires an absolute root");
  const path = await realpath(source.root);
  if (!(await lstat(path)).isDirectory()) throw new Error("local source root must be a directory");
  return path;
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function version(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join("/");
}

async function readBytes(root, rel, maxBytes) {
  const path = resolve(root, rel);
  if ((await realpath(path)) !== path) throw new Error("symlinked source path skipped");
  const before = await lstat(path);
  if (!before.isFile() || before.size > maxBytes)
    throw new Error("not a regular file or exceeds the file byte limit");
  const handle = await open(path, READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size > maxBytes ||
      (await realpath(path)) !== path
    ) {
      throw new Error("source changed during discovery; retry");
    }
    // A growing file must not defeat the stat-based byte limit.
    const buf = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error("source changed during reading; retry");
    return { bytes: buf.subarray(0, offset), fileVersion: version(after) };
  } finally {
    await handle.close();
  }
}

function table(mode, ext, bytes, opts) {
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, ["-I", READER, mode, ext, JSON.stringify(opts)], {
    input: bytes,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT")
    throw new Error("table extraction requires Python 3 on PATH");
  if (result.error || result.status !== 0)
    throw new Error("table extraction exceeded limits or failed");
  const output = JSON.parse(result.stdout);
  if (output.error) throw new Error(output.error);
  return output;
}

function passages(parts, isPdf, cap) {
  const chunks = [];
  for (const [i, raw] of parts.entries()) {
    const lines = raw.split(/\r?\n/);
    let group = [],
      start = 1,
      length = 0;
    function flush(end) {
      const text = group.join("\n").trim();
      const locator = isPdf ? `page ${i + 1} / lines ${start}-${end}` : `lines ${start}-${end}`;
      if (text) chunks.push({ text, locator });
      group = [];
      length = 0;
    }
    for (const [n, line] of lines.entries()) {
      if (group.length && (length + line.length > 1600 || group.length >= 30)) flush(n);
      if (chunks.length >= cap) return { chunks, truncated: true };
      if (!group.length) start = n + 1;
      // One long line may contain the entire payload (minified JS, JSON, or PDF text).
      if (line.length > 1600) {
        for (let k = 0; k < line.length; k += 1600) {
          if (chunks.length >= cap) return { chunks, truncated: true };
          chunks.push({
            text: line.slice(k, k + 1600),
            locator: `${isPdf ? `page ${i + 1} / ` : ""}line ${n + 1} / chars ${k + 1}-${Math.min(line.length, k + 1600)}`,
          });
        }
      } else {
        group.push(line);
        length += line.length + 1;
      }
    }
    flush(lines.length);
  }
  return { chunks, truncated: false };
}

function convert(rel, bytes, cap) {
  const ext = extname(rel).toLowerCase();
  if (TABLE.test(rel)) {
    const result = table("index", ext, bytes, { limit: cap });
    // Table structure separates assignment names from values. Mask known credential
    // columns in the Python reader; redact known tokens in every other cell.
    for (const row of result.chunks) row.text = redactSecrets(row.text);
    return result;
  }
  let text;
  if (ext === ".pdf") {
    const result = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
      input: bytes,
      timeout: 12000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    if (result.error && "code" in result.error && result.error.code === "ENOENT")
      throw new Error("PDF extraction requires Poppler pdftotext on PATH");
    if (result.error || result.status !== 0)
      throw new Error("PDF is unreadable or exceeded conversion limits");
    text = result.stdout;
    if (!text.trim()) throw new Error("PDF has no extractable text; OCR required");
  } else {
    if (bytes.includes(0)) throw new Error("binary or unsupported text encoding");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  // Mask full multiline material before splitting while keeping original page/line locations.
  text = text.replace(
    /-----BEGIN [\s\S]*?(?:-----END [^\n-]*-----|$)/gi,
    (m) => `[REDACTED]${m.replace(/[^\n\f]/g, "")}`,
  );
  text = redactSecrets(text);
  return passages(
    ext === ".pdf" ? text.replace(/\f$/, "").split("\f") : [text],
    ext === ".pdf",
    cap,
  );
}

/** Build a bounded source snapshot. Reuse conversion from a complete same-scope previous
 * snapshot only after hashing current bytes and checking every ordinal. Deleted/ignored
 * files are absent, and renamed files receive new locators.
 * @param {{id:string,root:string}} source
 * @param {{maxFiles?:number,maxBytesPerFile?:number,maxChunks?:number,previousChunks?:any[]}} options */
export async function readLocalSource(source, options = {}) {
  const root = await rootDir(source);
  const maxFiles = limit(options.maxFiles, 256, 4096);
  const maxBytes = limit(options.maxBytesPerFile, MAX_BYTES, MAX_BYTES);
  const maxChunks = limit(options.maxChunks, 1200, 4096);
  const paths = listFiles(root).filter(
    (p) => TABLE.test(p) || /\.pdf$/i.test(p) || CODE_EXT.test(p) || TEXT.test(p),
  );
  const previous = new Map();
  for (const row of options.previousChunks ?? []) {
    if (row?.sourceId === source.id && row.complete) {
      if (!previous.has(row.path)) previous.set(row.path, []);
      previous.get(row.path).push(row);
    }
  }
  const chunks = [],
    warnings = [];
  let truncated = paths.length > maxFiles,
    reusedFiles = 0;
  for (const rel of paths.slice(0, maxFiles)) {
    const cap = maxChunks - chunks.length;
    if (!cap) {
      truncated = true;
      break;
    }
    try {
      const { bytes, fileVersion } = await readBytes(root, rel, maxBytes);
      const hash = createHash("sha256").update(PARSER_VERSION).update(bytes).digest("hex");
      const old = previous.get(rel);
      if (
        old?.length &&
        old.every((r, i) => r.hash === hash && r.ordinal === i && r.total === old.length)
      ) {
        const fits = old.length <= cap;
        chunks.push(...old.slice(0, cap).map((r) => ({ ...r, fileVersion, complete: fits })));
        truncated ||= !fits;
        reusedFiles++;
        continue;
      }
      const result = convert(rel, bytes, cap);
      truncated ||= result.truncated;
      const total = result.chunks.length;
      for (const [ordinal, row] of result.chunks.entries()) {
        chunks.push({
          id: contentHash(JSON.stringify([source.id, rel, row.locator])),
          sourceId: source.id,
          path: rel,
          locator: redactSecrets(row.locator),
          text: row.text,
          hash,
          fileVersion,
          ordinal,
          total,
          complete: !result.truncated,
        });
      }
    } catch (error) {
      warnings.push(`${rel}: ${error.code ? "source unavailable" : error.message}`);
    }
  }
  return { chunks, warnings, truncated, reusedFiles };
}

/** Compute an aggregate from the complete current table, independently of the snippet cache.
 * @param {{id:string,root:string}} source
 * @param {{path:string,sheet?:string,column?:string,groupBy?:string,operation:string}} options */
export async function aggregateLocalTable(source, options) {
  const rel = options?.path;
  if (typeof rel !== "string" || !safePath(rel) || !TABLE.test(rel))
    throw new Error("expected a relative CSV, TSV, XLS or XLSX path in the source");
  const root = await rootDir(source);
  if (!listFiles(root, [rel]).includes(rel))
    throw new Error("table is ignored or unavailable in this source");
  const { bytes } = await readBytes(root, rel, MAX_BYTES);
  const { path: _path, ...settings } = options;
  const result = table("aggregate", extname(rel).toLowerCase(), bytes, settings);
  for (const row of result.groups)
    if (typeof row.group === "string") row.group = redactSecrets(row.group);
  return { path: toPosix(rel), ...result };
}

/** Recheck the current permission/ignore scope and exact file version before a cached
 * local chunk is delivered. Batches only the ranked candidates. No content conversion,
 * network, or full-tree traversal occurs on this path.
 * @param {{root:string}} source @param {Array<{path:string,fileVersion?:string}>} rows
 * @returns {Set<string>} */
export function eligibleLocalRows(source, rows) {
  const eligible = new Set();
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 64) return eligible;
  try {
    const root = realpathSync(source.root);
    const files = new Map(
      rows
        .filter((r) => typeof r?.path === "string" && safePath(r.path) && r.fileVersion)
        .map((r) => [r.path, r.fileVersion]),
    );
    if (!files.size) return eligible;
    for (const rel of listFiles(root, [...files.keys()], 1000)) {
      if (!files.has(rel)) continue;
      const path = resolve(root, rel);
      let fd;
      try {
        if (realpathSync(path) !== path) continue;
        fd = openSync(path, READ_FLAGS);
        const stat = fstatSync(fd);
        if (stat.isFile() && version(stat) === files.get(rel) && realpathSync(path) === path)
          eligible.add(rel);
      } catch {
        // Files can disappear, become inaccessible, be replaced, or move during search.
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  } catch {
    // Failure to establish eligibility suppresses every path from this source.
    eligible.clear();
  }
  return eligible;
}
