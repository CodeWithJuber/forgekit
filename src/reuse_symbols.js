// Advisory pointers for the prompt hook. Verify a small shortlist against the current
// file's atlas hash, so an old line number never gets presented as current evidence.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { ATLAS_VERSION, CODE_EXTS, indexedText } from "./atlas.js";
import { INTENT_STOP, intentGrams } from "./intent.js";
import { setOverlap } from "./math.js";

const MAX_ATLAS_BYTES = 12 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_PROBES = 10;
const STOP = new Set([
  ...INTENT_STOP,
  ..."add fix change implement build code function method class new existing create find get set use update refactor helper".split(
    " ",
  ),
]);

function concepts(text) {
  const words = text.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/([a-z\d])([A-Z])/g, "$1 $2");
  return intentGrams(words, STOP);
}

// The path must refer to ordinary bytes under the canonical root. A fixed-size read
// keeps the bound even when a different process appends to a file during the read.
export function readWorkspaceText(root, rel, maxBytes) {
  let fd;
  try {
    if (rel.split(/[\\/]/).includes("..") || isAbsolute(rel)) return null;
    const path = join(root, rel);
    if (realpathSync(path) !== path) return null;
    const before = lstatSync(path);
    if (!before.isFile() || before.size > maxBytes) return null;
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      realpathSync(path) !== path
    )
      return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) return null;
      offset += read;
    }
    const after = fstatSync(fd);
    return after.size === stat.size &&
      after.mtimeMs === stat.mtimeMs &&
      after.ctimeMs === stat.ctimeMs
      ? bytes.toString("utf8")
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Look up cached declarations related to the task. An absent or unusable atlas is a miss.
 * @param {string} root @param {string} task
 * @returns {{file:string, line:number, name:string}[]}
 */
export function symbolCandidates(root, task) {
  if (typeof task !== "string" || !task.trim()) return [];
  const input = task.slice(0, 4000);
  const terms = concepts(input);
  if (!terms.size) return [];
  const named = new Set(input.toLowerCase().match(/[\w$]+/g) ?? []);
  let atlas;
  let base;
  try {
    base = realpathSync(root);
    atlas = JSON.parse(readWorkspaceText(base, ".forge/atlas.json", MAX_ATLAS_BYTES) ?? "null");
  } catch {
    return [];
  }
  if (atlas?.version !== ATLAS_VERSION || !Array.isArray(atlas.symbols) || !atlas.fileHashes)
    return [];

  const ranked = [];
  for (const symbol of atlas.symbols.slice(0, 20000)) {
    const { file, line, name } = symbol ?? {};
    if (
      typeof name !== "string" ||
      !/^[A-Za-z_$][\w$]{0,127}[!?=]?$/.test(name) ||
      typeof file !== "string" ||
      file.length > 400 ||
      !/^[\p{L}\p{M}\p{N}_@.()/[\] $-]+$/u.test(file) ||
      file.split("/").some((part) => !part || part.startsWith(".")) ||
      !CODE_EXTS.has(extname(file)) ||
      !Number.isSafeInteger(line) ||
      line < 1
    )
      continue;
    const words = concepts(name);
    const overlap = setOverlap(terms, words);
    if (!overlap) continue;
    const score = (named.has(name.toLowerCase()) ? 2 : 0) + overlap;
    ranked.push({ file, line, name, score });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line,
  );
  const checkedFiles = new Map();
  const results = [];
  for (const { file, line, name } of ranked.slice(0, MAX_PROBES)) {
    if (!checkedFiles.has(file)) {
      const text = readWorkspaceText(base, file, MAX_SOURCE_BYTES);
      checkedFiles.set(
        file,
        text !== null && indexedText(atlas, file, text) ? text.split("\n") : [],
      );
    }
    if (!checkedFiles.get(file)[line - 1]?.includes(name)) continue;
    if (results.some((item) => item.file === file && item.line === line && item.name === name))
      continue;
    results.push({ file, line, name });
    if (results.length === 3) break;
  }
  return results;
}
