import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { outsideWorkspace } from "./private_paths.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { userStateDir } from "./util.js";
export function privateWorkspaceFile(root, category) {
  const workspace = realpathSync.native(sourceWorkspaceRoot(root));
  const parent = outsideWorkspace(
    workspace,
    resolve(userStateDir(), category),
    "Keep FORGE_HOME outside the worktree for private workspace settings",
  );
  const key = createHash("sha256").update(workspace).digest("hex");
  return join(parent, `${key}.json`);
}
