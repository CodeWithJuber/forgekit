// SessionStart orientation — the always-on block a session gets even on a fresh repo.
//
// Every other SessionStart block (lessons, goal, handoff state, repo history) is empty until
// the repo has history with us, so a plugin install used to start in silence: no sign the
// plugin was active, and none of the workflow rules (global/CLAUDE.md is a template the
// plugin does not install). This block fills that gap in under 900 bytes — it is paid on every
// startup and /clear, so it says only what Claude Code does not already show (agent and tool
// descriptions are in their own lists; names plus a few words of "when" are enough). A resumed
// session skips it: its transcript already carries the block. Kill switch: FORGE_ORIENT=0.
import { BRAND } from "./brand.js";
import { TOOLS } from "./mcp_tools.js";

/** Byte ceiling for the block; the test holds it. */
export const ORIENT_MAX_BYTES = 900;

/** MCP tools the orientation names, by when to reach for them. Names are filtered against the
 *  live registry, so a renamed tool drops out instead of being advertised (and the test fails).
 *  @type {Array<[string, string[]]>} */
export const ORIENT_TOOLS = [
  ["memory", ["forge_ledger_query", "cortex_lessons", "forge_remember"]],
  ["before edits", ["preflight_check", "substrate_check", "predict_impact", "collide_check"]],
  ["repeat failure", ["forge_diagnose"]],
];

/** Crew agents the plugin ships (.claude-plugin/plugin.json `agents`), with when to use each.
 *  @type {Array<[string, string]>} */
export const ORIENT_CREW = [
  ["scout", "broad search"],
  ["verifier", "non-trivial diff"],
  ["independent-reviewer", "pre-merge"],
  ["frontend-verifier", "UI changes"],
  ["doc-sync", "stale docs"],
];

/** True when the user turned the orientation off (`FORGE_ORIENT=0`, `false`, `off`, `no`). */
export function orientDisabled(env = process.env) {
  return /^(0|false|off|no)$/i.test(String(env.FORGE_ORIENT ?? "").trim());
}

/** The orientation block (Markdown), or "" when disabled or on a resume (the resumed transcript
 *  already holds it). `source` is the SessionStart payload's `source`. Pure: no I/O. */
export function orientationBlock(env = process.env, { source = "" } = {}) {
  if (orientDisabled(env) || source === "resume") return "";
  const known = new Set(TOOLS.map((t) => t.name));
  const tools = ORIENT_TOOLS.flatMap(([when, names]) => {
    const live = names.filter((n) => known.has(n));
    return live.length ? [`${when}: ${live.join(", ")}`] : [];
  });
  return [
    `## ${BRAND.brand} active (${BRAND.pkg})`,
    "- Explore → plan → code → verify; plan first only for multi-file or unfamiliar work.",
    "- Never claim done without a check you ran; show the command and its result.",
    "- Fix root causes; never suppress an error to pass a check. Ask before destructive or production actions.",
    `- Delegate: ${ORIENT_CREW.map(([name, when]) => `${name} (${when})`).join(", ")}.`,
    ...(tools.length ? [`- ${BRAND.cli}-cortex MCP — ${tools.join("; ")}.`] : []),
    "Off: FORGE_ORIENT=0.",
    "",
  ].join("\n");
}
