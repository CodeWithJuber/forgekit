// Cursor reads AGENTS.md natively; a legacy root .cursorrules can shadow it.
import { join } from "node:path";

export default {
  tool: "Cursor",
  emit(ctx) {
    const legacy = join(ctx.targetRoot, ".cursorrules");
    if (ctx.shared.readIfExists(legacy) !== null) {
      return {
        tool: this.tool,
        target: "AGENTS.md",
        action: "warn",
        note: "legacy .cursorrules present — remove it so AGENTS.md wins",
      };
    }
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: "relies-on-agents",
      note: "native (+ .cursor/rules/*.mdc for scoping)",
    };
  },
};
