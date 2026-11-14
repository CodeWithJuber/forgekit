import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sourceWorkspaceRoot } from "./sources.js";
import { userStateDir } from "./util.js";
export function privateWorkspaceFile(root, category) {
  const workspace = realpathSync.native(sourceWorkspaceRoot(root));
  const parent = resolve(userStateDir(), category);
  // Resolve even a partially existing parent before checking isolation, including /tmp aliases.
  let ancestor = parent;
  for (;;) {
    try {
      const physical = join(realpathSync.native(ancestor), relative(ancestor, parent));
      const rel = relative(workspace, physical);
      if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
        throw new Error("Keep FORGE_HOME outside the worktree for private workspace settings");
      const key = createHash("sha256").update(workspace).digest("hex");
      return join(physical, `${key}.json`);
    } catch (e) {
      if (e.code !== "ENOENT" || dirname(ancestor) === ancestor) throw e;
      ancestor = dirname(ancestor);
    }
  }
}
