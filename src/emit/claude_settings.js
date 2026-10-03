// Claude Code's project settings — `.claude/settings.json`. The one key Forge owns there is
// `advisorModel` (src/advisor.js): when the repo's `.forge/forge.config.json` names an advisor,
// sync writes it; when it says `off`, sync removes it; when it says nothing, this emitter stays
// silent (no row) and the file is never touched. Every other key is preserved byte for byte, so
// a team's own permissions and hooks ride along untouched. The user-level file
// (`~/.claude/settings.json`) is never written from sync — `forge advisor set --global` does
// that, with the same GLOBAL disclosure `forge init` gives.
import { join } from "node:path";
import { ADVISOR_SETTINGS_KEY, resolveAdvisor, writeAdvisorSetting } from "../advisor.js";

const TARGET = ".claude/settings.json";

export default {
  tool: "Claude Code",
  emit(ctx) {
    // Only the PROJECT layer decides what the project file holds: a global advisor belongs in
    // the user settings file, not in a committed one.
    const state = resolveAdvisor(ctx.targetRoot, {
      layers: { global: {}, project: ctx.config ?? {} },
      env: {},
    });
    if (!state.forgeConfigured) return null;
    const path = join(ctx.targetRoot, TARGET);
    const res = writeAdvisorSetting(path, state.model);
    if (res.action === "error")
      return { tool: this.tool, target: TARGET, action: "skipped", note: res.reason };
    const note = state.model
      ? `${ADVISOR_SETTINGS_KEY}: ${state.model}${res.action === "unchanged" ? " (already set)" : ""}`
      : res.action === "unchanged"
        ? `no ${ADVISOR_SETTINGS_KEY} (advisor off)`
        : `${ADVISOR_SETTINGS_KEY} removed (advisor off)`;
    const action = res.action === "unchanged" ? "unchanged" : "written";
    return { tool: this.tool, target: TARGET, action, note };
  },
};
