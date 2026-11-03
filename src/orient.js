// SessionStart orientation — the always-on block a session gets even on a fresh repo.
//
// Every other SessionStart block (lessons, goal, handoff state, repo history) is empty until
// the repo has history with us, so a plugin install used to start in silence: no sign the
// plugin was active, and none of the workflow rules (global/CLAUDE.md is a template the
// plugin does not install). This block fills that gap in ~1.5 KB, well under the SessionStart
// cap in hooks/budget.json. Kill switch: FORGE_ORIENT=0.
import { BRAND } from "./brand.js";
import { TOOLS } from "./mcp_tools.js";

/** MCP tools the orientation names, by when to reach for them. Names are filtered against the
 *  live registry, so a renamed tool drops out instead of being advertised (and the test fails).
 *  @type {Array<[string, string[]]>} */
export const ORIENT_TOOLS = [
  ["memory", ["forge_ledger_query", "cortex_lessons", "forge_remember"]],
  ["before editing", ["preflight_check", "substrate_check", "predict_impact", "collide_check"]],
  ["on a repeating failure", ["forge_diagnose"]],
];

/** Crew agents the plugin ships (.claude-plugin/plugin.json `agents`), with when to use each.
 *  @type {Array<[string, string]>} */
export const ORIENT_CREW = [
  [
    "scout",
    "broad “how/where does X work” investigation, so exploration stays out of this context",
  ],
  ["verifier", "independent review of a non-trivial diff before you call it done"],
  [
    "independent-reviewer",
    "last-gate review from the diff, spec and test results only, before merge",
  ],
  [
    "frontend-verifier",
    "screenshots + accessibility check after any UI change (give it a running URL)",
  ],
  ["doc-sync", "update stale docs after multi-file changes or renames"],
];

/** True when the user turned the orientation off (`FORGE_ORIENT=0`, `false`, `off`, `no`). */
export function orientDisabled(env = process.env) {
  return /^(0|false|off|no)$/i.test(String(env.FORGE_ORIENT ?? "").trim());
}

/** The orientation block (Markdown), or "" when disabled. Pure: no I/O beyond the env read. */
export function orientationBlock(env = process.env) {
  if (orientDisabled(env)) return "";
  const known = new Set(TOOLS.map((t) => t.name));
  const toolRows = ORIENT_TOOLS.flatMap(([when, names]) => {
    const live = names.filter((n) => known.has(n));
    return live.length ? [`- ${when}: ${live.join(", ")}`] : [];
  });
  return [
    `## ${BRAND.brand} is active (${BRAND.pkg})`,
    "Workflow for this session:",
    "- Explore → plan → code → verify. Plan first for multi-file or unfamiliar changes; skip it for one-line fixes.",
    "- Never call work done without a check you ran (tests, build exit code, linter, diff). Show the command and its result.",
    "- Fix root causes; never suppress an error to make a check pass. Match the repo's conventions and libraries.",
    "- Ask before force-push, history rewrite, `rm -rf`, dropping tables, or touching production. Never write secrets.",
    "Crew agents (own context):",
    ...ORIENT_CREW.map(([name, when]) => `- ${name} — ${when}`),
    ...(toolRows.length ? [`MCP tools (${BRAND.cli}-cortex server):`, ...toolRows] : []),
    "Guards run as hooks: protected paths, secret redaction, doom-loop and cost warnings, a completion gate at Stop.",
    "`FORGE_ORIENT=0` hides this block.",
    "",
  ].join("\n");
}
