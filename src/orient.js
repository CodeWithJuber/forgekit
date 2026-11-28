// SessionStart orientation — the always-on block a session gets even on a fresh repo.
//
// Every other SessionStart block (lessons, goal, handoff state, repo history) is empty until
// the repo has history with us, so a plugin install used to start in silence: no sign the
// plugin was active, and none of the workflow rules (global/CLAUDE.md is a template the
// plugin does not install). This block fills that gap in under 900 bytes — it is paid on every
// startup, /clear and compaction (the summary drops what a hook injected earlier), so it says
// only what Claude Code does not already show (agent and tool descriptions are in their own
// lists; names plus a few words of "when" are enough). A resumed session skips it: its
// transcript already carries the block. Kill switch: FORGE_ORIENT=0.
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

/** Skills tied to a moment in the session rather than to a kind of prompt (the protocol cards
 *  in intent.js name those). A host that lists a skill by name only gives no other "when".
 *  @type {Array<[string, string]>} */
export const ORIENT_SKILLS = [
  ["catchup", "resuming"],
  ["cognitive-substrate", "unclear or multi-file edit"],
  ["atlas", "where is X"],
  ["recall", "remember this"],
  ["handoff", "pausing"],
];

/** When to use every tool the cortex server registers: the server's MCP `instructions`.
 *  "auto" tools read, advise, or keep this repo's own notes (forge_remember and
 *  forge_diagnose write under .forge/). "ask" tools install something, propose a ledger
 *  change or start a run, so the model is not told to reach for them unprompted. The first
 *  three labels are ORIENT_TOOLS' own. The test holds that each registered tool appears once.
 *  @type {Array<[string, string[], "auto" | "ask"]>} */
export const MCP_TOOL_GUIDE = [
  [
    "memory",
    [
      "forge_ledger_query",
      "cortex_lessons",
      "forge_remember",
      "forge_brain",
      "forge_hikmah_recall",
      "forge_memory_decide",
    ],
    "auto",
  ],
  [
    "before edits",
    [
      "preflight_check",
      "substrate_check",
      "predict_impact",
      "collide_check",
      "assumption_gate",
      "scope_files",
      "rank_code",
    ],
    "auto",
  ],
  ["repeat failure", ["forge_diagnose"], "auto"],
  ["planning", ["forge_evidence", "forge_develop", "forge_team_plan", "route_task"], "auto"],
  ["before adding a package or tool", ["dep_check", "forge_tool_find"], "auto"],
  [
    "connected sources and tables",
    [
      "forge_source_search",
      "forge_source_read",
      "forge_source_route",
      "forge_mirror_get",
      "forge_mirror_sql",
      "forge_table_aggregate",
    ],
    "auto",
  ],
  [
    "status and cost",
    [
      "cortex_status",
      "forge_doctor",
      "forge_cost",
      "forge_dash_summary",
      "forge_dash_data",
      "forge_provider_status",
    ],
    "auto",
  ],
  ["installing a reviewed tool", ["forge_tool_install"], "ask"],
  ["proposing a ledger change", ["forge_ledger_ratify", "forge_ledger_retract"], "ask"],
  ["supervised runs", ["forge_harness_run", "forge_harness_status"], "ask"],
];

/** `when: tool, tool` phrases for the tools of `groups` found in `names`, so a renamed or
 *  unlisted tool is never advertised.
 *  @param {string[]} names
 *  @param {Array<[string, string[], ...unknown[]]>} [groups] */
function toolHints(names, groups = ORIENT_TOOLS) {
  const known = new Set(names);
  return groups.flatMap(([when, tools]) => {
    const live = tools.filter((n) => known.has(n));
    return live.length ? [`${when}: ${live.join(", ")}`] : [];
  });
}

/** MCP `instructions` for the cortex server. A host that defers MCP tool schemas shows the
 *  model only the tool names plus this text, so without it nothing says when to look a tool
 *  up. `names` is what the server lists; "" when it lists nothing the guide knows.
 *  @param {string[]} [names] */
export function mcpInstructions(names = TOOLS.map((t) => t.name)) {
  const auto = toolHints(
    names,
    MCP_TOOL_GUIDE.filter(([, , mode]) => mode === "auto"),
  );
  const ask = toolHints(
    names,
    MCP_TOOL_GUIDE.filter(([, , mode]) => mode === "ask"),
  );
  if (!auto.length && !ask.length) return "";
  return [
    `${BRAND.brand} pre-action checks and repo memory for coding work.`,
    ...(auto.length ? [`Use these tools without waiting to be asked — ${auto.join("; ")}.`] : []),
    ...(ask.length ? [`Only when the task calls for it — ${ask.join("; ")}.`] : []),
  ].join(" ");
}

/** True when the user turned the orientation off (`FORGE_ORIENT=0`, `false`, `off`, `no`). */
export function orientDisabled(env = process.env) {
  return /^(0|false|off|no)$/i.test(String(env.FORGE_ORIENT ?? "").trim());
}

/** The orientation block (Markdown), or "" when disabled or on a resume (the resumed transcript
 *  already holds it). `source` is the SessionStart payload's `source`. Pure: no I/O. */
export function orientationBlock(env = process.env, { source = "" } = {}) {
  if (orientDisabled(env) || source === "resume") return "";
  const tools = toolHints(TOOLS.map((t) => t.name));
  return [
    `## ${BRAND.brand} active (${BRAND.pkg})`,
    "- Explore → plan → code → verify; plan first only for multi-file or unfamiliar work.",
    "- Never claim done without a check you ran; show the command and its result.",
    "- Fix root causes; never suppress an error to pass a check. Ask before destructive or production actions.",
    `- Delegate: ${ORIENT_CREW.map(([name, when]) => `${name} (${when})`).join(", ")}.`,
    `- Skills: ${ORIENT_SKILLS.map(([name, when]) => `${name} (${when})`).join(", ")}.`,
    ...(tools.length ? [`- ${BRAND.cli}-cortex MCP — ${tools.join("; ")}.`] : []),
    "Off: FORGE_ORIENT=0.",
    "",
  ].join("\n");
}
