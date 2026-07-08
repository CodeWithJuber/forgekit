// Gemini CLI reads GEMINI.md by default and only reads AGENTS.md when
// settings.json context.fileName lists it. Merge that opt-in without a 2nd copy.
import { join } from "node:path";

export default {
  tool: "Gemini CLI",
  emit(ctx) {
    const path = join(ctx.targetRoot, ".gemini/settings.json");
    let settings = {};
    const existing = ctx.shared.readIfExists(path);
    if (existing) {
      try {
        settings = JSON.parse(existing);
      } catch {
        return {
          tool: this.tool,
          target: ".gemini/settings.json",
          action: "skipped",
          note: "existing settings.json is invalid JSON — left as-is",
        };
      }
    }
    const context = settings.context || (settings.context = {});
    const current = Array.isArray(context.fileName)
      ? context.fileName
      : context.fileName
        ? [context.fileName]
        : [];
    const had = current.includes("AGENTS.md");
    context.fileName = [...new Set([...current, "AGENTS.md"])];
    settings._forge = ctx.shared.markerString(ctx.hash);
    const action = ctx.shared.writeIfChanged(path, `${JSON.stringify(settings, null, 2)}\n`);
    return {
      tool: this.tool,
      target: ".gemini/settings.json",
      action,
      note: had ? "AGENTS.md already in context.fileName" : "added AGENTS.md to context.fileName",
    };
  },
};
