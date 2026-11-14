// npm scripts prepend writable checkout directories to PATH. A Python shim in
// such a directory must never receive private harness state or inherited credentials.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";

function outside(workspace, path) {
  const rel = relative(workspace, path);
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
}

/** Child-only PATH excludes relative entries and aliases into a writable tree. */
export function harnessChildPath(root, additionalRoots = []) {
  const workspaces = [root, ...additionalRoots].map((r) => realpathSync.native(r));
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => {
      if (!isAbsolute(dir)) return false;
      try {
        const real = realpathSync.native(dir);
        return workspaces.every((w) => outside(w, real) && outside(w, dir));
      } catch {
        return false;
      }
    })
    .join(delimiter);
}

/** Resolve only outside all participating worktrees. PATH directories can be
 * lexical aliases, so check both the candidate and its canonical target. */
export function installedHarnessProgram(root, program, additionalRoots = []) {
  if (!["git", "python3", "python", "podman", "docker"].includes(program))
    throw new Error("Unknown harness runtime");
  const workspaces = [root, ...additionalRoots].map((r) => realpathSync.native(r));
  const name = process.platform === "win32" ? `${program}.exe` : program;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      const binary = realpathSync.native(candidate);
      if (
        !workspaces.every((w) => outside(w, binary) && outside(w, candidate)) ||
        !statSync(binary).isFile()
      )
        continue;
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {
      // Continue to the next installed executable.
    }
  }
  throw new Error(`Install ${program} outside the checkout and add it to PATH`);
}

export function installedHarnessPython(root) {
  try {
    return installedHarnessProgram(root, process.platform === "win32" ? "python" : "python3");
  } catch {
    throw new Error("Install Python 3 with SQLite outside the checkout and add it to PATH");
  }
}
