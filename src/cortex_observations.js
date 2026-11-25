// Provisional correction receipts are local to this checkout and never enter a
// project ledger, host context, or workspace cloud export.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withConfigLock } from "./repo_config.js";
import { contentHash } from "./util.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const directory = (root) =>
  privateWorkspaceFile(root, "cortex-corrections-v2").replace(/\.json$/, "");
const pathFor = (root, id) => join(directory(root), `${contentHash(id)}.json`);
const status = (path) => lstatSync(path, { throwIfNoEntry: false });
function inspect(path, dir = false) {
  const st = status(path);
  if (!st) return false;
  if (
    (dir ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) ||
    (process.platform !== "win32" && (st.uid !== process.getuid() || st.mode & 0o077))
  )
    throw new Error("Correction observations require private user-owned files");
  return true;
}
function read(path) {
  if (!inspect(path)) return { version: 2, lesson: null, published: false, observations: {} };
  const row = JSON.parse(readFileSync(path, "utf8"));
  if (row.version !== 2 || !row.observations || typeof row.observations !== "object")
    throw new Error("Unreadable correction history");
  return row;
}

export function withCorrection(root, id, fn) {
  const dir = directory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  inspect(dir, true);
  const path = pathFor(root, id);
  return withConfigLock(path, () => {
    const row = read(path);
    const previous = JSON.stringify(row);
    const result = fn(row);
    if (JSON.stringify(row) === previous) return result;
    const temp = join(dir, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(row), { flag: "wx", mode: 0o600, flush: true });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    return result;
  });
}

export function pendingCorrections(root) {
  const dir = directory(root);
  if (!existsSync(dir)) return [];
  inspect(dir, true);
  return readdirSync(dir)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      const row = read(join(dir, name));
      return row.lesson && !row.published
        ? [
            {
              ...row.lesson,
              review: {
                episodes: Object.keys(row.observations).length,
                operatorRequired: Boolean(row.needsReview),
              },
            },
          ]
        : [];
    });
}
