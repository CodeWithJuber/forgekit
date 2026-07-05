// Aider loads extra context only via `read:` in .aider.conf.yml. Emit a managed
// conf that reads AGENTS.md; never clobber a user's own unmanaged conf.
import { join } from "node:path";

export default {
  tool: "Aider",
  emit(ctx) {
    const path = join(ctx.targetRoot, ".aider.conf.yml");
    const existing = ctx.shared.readIfExists(path);
    if (existing !== null && !ctx.shared.isManaged(existing)) {
      return {
        tool: this.tool,
        target: ".aider.conf.yml",
        action: "skipped",
        note: "existing conf — add `read: AGENTS.md` yourself",
      };
    }
    const body = ["read:", "  - AGENTS.md"].join("\n");
    const action = ctx.shared.writeManaged(path, ctx.shared.yamlHeader(ctx.hash), body);
    return { tool: this.tool, target: ".aider.conf.yml", action, note: "read: AGENTS.md" };
  },
};
