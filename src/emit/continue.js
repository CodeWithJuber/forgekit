// Continue does NOT read AGENTS.md — it loads .continue/rules/*.md (verified 2026-07).
// So emit the canonical rules there, so Continue gets the same single source as
// every other tool. Never clobber a user's own unmanaged rules file.
import { join } from "node:path";

export default {
  tool: "Continue",
  emit(ctx) {
    const rel = ".continue/rules/00-forge.md";
    const path = join(ctx.targetRoot, ".continue", "rules", "00-forge.md");
    const existing = ctx.shared.readIfExists(path);
    if (existing !== null && !ctx.shared.isManaged(existing)) {
      return {
        tool: this.tool,
        target: rel,
        action: "skipped",
        note: "existing unmanaged rules file",
      };
    }
    const action = ctx.shared.writeManaged(path, ctx.shared.mdHeader(ctx.hash), ctx.canonical);
    return {
      tool: this.tool,
      target: rel,
      action,
      note: ".continue/rules/ (no AGENTS.md)",
    };
  },
};
