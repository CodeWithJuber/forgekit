// Compare native paths on both sides: Windows 8.3 names and junctions, and
// macOS /var and /tmp aliases, can give the same location different spellings.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function physicalPath(path) {
  const target = resolve(path);
  let ancestor = target;
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), relative(ancestor, target));
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      // A dangling symlink is not a new directory that can be safely created later.
      if (lstatSync(ancestor, { throwIfNoEntry: false })) throw error;
      ancestor = dirname(ancestor);
    }
  }
}

export function containsPath(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export function outsideWorkspace(root, path, reason) {
  const physical = physicalPath(path);
  if (
    containsPath(realpathSync.native(root), physical) ||
    containsPath(resolve(root), resolve(path))
  ) {
    throw new Error(reason);
  }
  return physical;
}
