// Workspace-scoped agent state lives outside the checkout and is never emitted by sync.

import { join } from "node:path";
import { outsideWorkspace } from "./private_paths.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { contentHash, userStateDir } from "./util.js";

export function privateMemoryDir(root, kind) {
  const workspace = sourceWorkspaceRoot(root);
  return outsideWorkspace(
    workspace,
    join(userStateDir(), "workspace-memory", contentHash(workspace), kind),
    "Private memory requires a state directory outside this checkout.",
  );
}
