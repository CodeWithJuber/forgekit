// Compare native paths on both sides: Windows 8.3 names and junctions, and
// macOS /var and /tmp aliases, can give the same location different spellings.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
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

export function readBounded(path, limit) {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > limit || realpathSync.native(path) !== path)
      throw new Error("Verification input must be a bounded regular file");
    const bytes = Buffer.alloc(st.size);
    let pos = 0;
    while (pos < bytes.length) {
      const n = readSync(fd, bytes, pos, bytes.length - pos, null);
      if (!n) throw new Error("File changed during verification");
      pos += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null))
      throw new Error("File changed during verification");
    return { bytes, mode: st.mode & 0o111 ? 0o555 : 0o444 };
  } finally {
    closeSync(fd);
  }
}
