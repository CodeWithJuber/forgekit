// Windsurf/Devin auto-discovers AGENTS.md but caps combined rules at ~12k chars.
// The rules dir is mid-rebrand (.windsurf -> .devin); detect which exists.
import { existsSync } from "node:fs";
import { join } from "node:path";

const CHAR_CAP = 12 * 1024;

export default {
  tool: "Windsurf/Devin",
  emit(ctx) {
    const dir = existsSync(join(ctx.targetRoot, ".devin")) ? ".devin" : ".windsurf";
    const over = ctx.chars > CHAR_CAP;
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: over ? "warn" : "relies-on-agents",
      note: over
        ? `${ctx.chars} chars exceeds ~12k cap — trim rules`
        : `native (${dir}; ${ctx.chars} chars)`,
    };
  },
};
