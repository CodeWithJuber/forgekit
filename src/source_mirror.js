// These calls read exactly one configured, valid snapshot. SQL runs in a separate,
// time-bounded SQLite process. Neither tool accepts a filesystem database path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eligibleLocalRows, relationalTable } from "./source_local.js";
import { getSource, openSourceMirror } from "./sources.js";

const worker = fileURLToPath(new URL("./mirror_sql.py", import.meta.url));

function page(rows, offset = 0, limit = 20) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Set a nonnegative offset and a limit of 1–100");
  const slice = rows.slice(offset, offset + limit);
  return {
    entries: slice,
    total: rows.length,
    nextOffset: offset + slice.length < rows.length ? offset + slice.length : null,
  };
}

function stamp(snapshot) {
  return {
    source: snapshot.source.id,
    fetchedAt: snapshot.meta.cachedAt,
    partial: snapshot.partial,
    lastReconciled: snapshot.meta.lastReconciled,
  };
}

function summary(item) {
  return {
    id: item.id,
    path: item.path,
    title: item.title,
    kind: item.kind,
    status: item.status,
    version: item.version,
    updatedAt: item.updatedAt,
    chunkCount: item.passages.length,
    complete: item.complete,
    sizeBytes: item.sizeBytes,
    sha256: item.hash,
  };
}

/** @param {string} root @param {string} sourceId
 * @param {{id?:string,chunk?:number,offset?:number,limit?:number}} [options] */
export function mirrorGet(root, sourceId, { id, chunk, offset, limit } = {}) {
  const snapshot = openSourceMirror(root, sourceId);
  try {
    let result;
    if (id === undefined) {
      if (chunk !== undefined) throw new Error("Specify the item ID for a chunk");
      result = page(snapshot.items.map(summary), offset, limit);
    } else {
      const item = snapshot.items.find((r) => r.id === id);
      if (!item) throw new Error("Item unavailable in this source snapshot");
      if (chunk === undefined) {
        result = {
          item: { ...summary(item), structure: item.structure },
          ...page(
            item.passages.map(([, locator], ordinal) => ({ ordinal, locator })),
            offset,
            limit,
          ),
        };
      } else {
        if (offset !== undefined || limit !== undefined)
          throw new Error("Use chunk or pagination separately");
        if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk >= item.passages.length)
          throw new Error("Chunk unavailable in this item");
        const [at, locator] = item.passages[chunk];
        result = { item: summary(item), ordinal: chunk, locator, text: snapshot.read(at).text };
      }
    }
    snapshot.confirm();
    return { ...stamp(snapshot), ...result };
  } finally {
    snapshot.close();
  }
}

function sqlProcess(mode, payload, path = undefined) {
  const bin = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(bin, ["-I", "-B", worker, mode, ...(path ? [path] : [])], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT")
    throw new Error("Mirror SQL requires Python 3 with sqlite3 on PATH");
  if (result.error || result.status !== 0)
    throw new Error("Mirror SQL worker unavailable or exceeded its limit");
  const reply = JSON.parse(result.stdout);
  if (reply.error) throw new Error(reply.error);
  return reply;
}

function tables(snapshot) {
  const items = [],
    chunks = [];
  for (const item of snapshot.items) {
    items.push([
      item.id,
      item.path,
      item.title,
      item.kind,
      item.status,
      item.updatedAt,
      snapshot.meta.cachedAt,
      snapshot.source.id,
      item.passages.length,
    ]);
    for (const [ordinal, [at, locator]] of item.passages.entries())
      chunks.push([item.id, ordinal, locator, snapshot.read(at).text]);
  }
  return { items, chunks };
}

/** Run one size-capped SELECT. Each immutable remote generation can reuse its private SQLite
 * projection. Local file grants may change between calls, so only eligible rows enter an
 * ephemeral local database. SQLite has no other data attached or filesystem SQL functions.
 */
export function mirrorSql(root, sourceId, sql, { tables: selected = undefined } = {}) {
  if (typeof sql !== "string" || !sql.trim() || sql.length > 8192)
    throw new Error("Supply a SELECT query up to 8192 characters");
  if (selected !== undefined) return queryTables(root, sourceId, sql, selected);
  const snapshot = openSourceMirror(root, sourceId);
  try {
    let result;
    if (snapshot.source.provider === "local") {
      result = sqlProcess("memory", { ...tables(snapshot), sql });
    } else {
      const db = join(snapshot.dir, "mirror-v1.sqlite");
      if (!existsSync(db)) {
        const staging = mkdtempSync(join(snapshot.dir, ".sql-"));
        try {
          const temp = join(staging, "mirror.sqlite");
          sqlProcess("build", tables(snapshot), temp);
          try {
            renameSync(temp, db);
          } catch (err) {
            if (!existsSync(db)) throw err;
          }
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      }
      result = sqlProcess("query", { sql }, db);
    }
    snapshot.confirm();
    return { ...stamp(snapshot), ...result };
  } finally {
    snapshot.close();
  }
}

// Cross-file joins use the selected complete input bytes, not truncated mirror excerpts.
async function queryTables(root, sourceId, sql, descriptors) {
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 4)
    throw new Error("Supply one to four local SQL tables");
  const source = getSource(root, sourceId);
  if (source.provider !== "local") throw new Error("Table SQL requires a configured local source");
  const seen = new Set(),
    tables = [],
    inputs = [];
  for (const desc of descriptors) {
    if (
      !desc ||
      typeof desc.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(desc.name) ||
      desc.name.startsWith("sqlite_") ||
      seen.has(desc.name) ||
      Object.keys(desc).some((k) => !["name", "path", "sheet"].includes(k))
    )
      throw new Error("Supply unique SQL table names and explicit relative paths");
    seen.add(desc.name);
    const { columns, rows, path, sheet, fileVersion, sha256 } = await relationalTable(source, desc);
    tables.push({ name: desc.name, columns, rows });
    inputs.push({ name: desc.name, path, sheet, fileVersion, sha256, rows: rows.length });
  }
  const result = sqlProcess("table_data", { tables, sql });
  const current = getSource(root, sourceId);
  if (
    current.provider !== "local" ||
    current.root !== source.root ||
    inputs.some((r) => !eligibleLocalRows(current, [r]).has(r.path))
  )
    throw new Error("Source or table changed during query; retry");
  return {
    ...result,
    source: sourceId,
    fetchedAt: new Date().toISOString(),
    partial: false,
    inputs: inputs.map(({ fileVersion, ...rest }) => rest),
  };
}
