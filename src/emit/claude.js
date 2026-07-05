// Claude Code reads CLAUDE.md, not AGENTS.md. Emit a thin CLAUDE.md that imports
// the shared source via @AGENTS.md (first line, Windows-safe). Never clobber a
// user's own unmanaged CLAUDE.md.
import { join } from "node:path";

export default {
  tool: "Claude Code",
  emit(ctx) {
    const path = join(ctx.targetRoot, "CLAUDE.md");
    const existing = ctx.shared.readIfExists(path);
    if (existing !== null && !ctx.shared.isManaged(existing)) {
      return {
        tool: this.tool,
        target: "CLAUDE.md",
        action: "skipped",
        note: "existing unmanaged CLAUDE.md left as-is",
      };
    }
    const content = [
      "@AGENTS.md",
      "",
      ctx.shared.mdHeader(ctx.hash),
      "",
      "> Claude reads the shared rules via the import above. Add Claude-only or repo-specific notes below.",
      "",
    ].join("\n");
    const action = ctx.shared.writeIfChanged(path, content);
    return { tool: this.tool, target: "CLAUDE.md", action, note: "@AGENTS.md import" };
  },
};
