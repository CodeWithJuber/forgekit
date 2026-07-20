// forge commands — the CLI's command surface as DATA. cli.js renders --help from
// this table and docs_check.js reconciles README/GUIDE against it, so a command can
// no longer ship (or disappear) without the docs check noticing.
//
// An entry is EITHER a one-line summary string OR a rich object
// `{summary, usage?, flags?, examples?, env?}` — both coexist permanently. Read a
// summary via commandSummary(name) (printHelp is the only value-reader), and the full
// per-command help via commandHelp(name). docs_check only reads Object.keys(COMMANDS),
// so migrating a value from string to object never affects the docs reconciler.

export const COMMANDS = {
  init: {
    summary: "scaffold this repo's config — emits every tool from one shared source",
    usage:
      "forge init [--profile minimal|standard] [--no-settings | --settings-only | --remove-settings]",
    flags: [
      {
        flag: "--profile <minimal|standard>",
        desc: "policy profile: minimal = the five core-safety rules only; standard = the full pack (default). Legacy names (web-app, backend-service, library, regulated) are deprecated aliases of standard.",
      },
      {
        flag: "--no-settings",
        desc: "emit tool configs but don't touch ~/.claude/settings.json (the merge is GLOBAL — it affects all repos)",
      },
      {
        flag: "--settings-only",
        desc: "only merge hooks/permissions into settings (skip repo emit)",
      },
      {
        flag: "--remove-settings",
        desc: "reverse the merge — remove forge-managed hooks/permissions/statusline from ~/.claude/settings.json (backed up first)",
      },
    ],
    examples: ["forge init", "forge init --profile minimal", "forge init --remove-settings"],
  },
  sync: {
    summary: "recompile the canonical source into each tool's native config files",
    usage: "forge sync",
    examples: ["forge sync"],
  },
  doctor: {
    summary: "health-check installed tools, guards, MCP auth, and config drift",
    usage: "forge doctor [--fix]",
    flags: [
      {
        flag: "--fix",
        desc: "auto-repair safely fixable findings, then re-check",
      },
    ],
    examples: ["forge doctor", "forge doctor --fix"],
  },
  tools:
    "primary-tool config — gitignore secondary-tool artifacts (.cursor/.gemini/…) for tools this repo doesn't use (`forge tools <name>` sets it, `--reset` clears)",
  update: {
    summary:
      "self-update — `--check` reports if a newer version is available, bare applies it, `--to <version>` pins/downgrades",
    usage: "forge update [--check | --to <version>]",
    flags: [
      {
        flag: "--check",
        desc: "report whether a newer version is available (makes no change)",
      },
      {
        flag: "--to <version>",
        desc: "pin or downgrade to an exact released version",
      },
    ],
    examples: ["forge update --check", "forge update --to 0.19.0"],
  },
  taste: "enable one UI-taste tool for this repo (no arg = list)",
  atlas: "build / query the code-graph (where-is-Y, has-symbol)",
  stack: "detect this repo's real stack (languages, frameworks, test commands) from its manifests",
  radar:
    "dependency-currency rings — staleness/major-lag/advisories from live registry evidence, cached 24h",
  recall: "manage cross-session memory (list / add / consolidate)",
  catalog: "Start Here — list every tool, crew, and guard with a one-line why",
  scan: "vet a skill/MCP for injection/RCE/exfil before install (skill-gate)",
  verify:
    "independent verification gate — tests + hallucinated-symbol + provenance (--deep: multi-lens consensus)",
  precommit:
    "commit-level gate — staged code w/o docs + secret scan (FORGE_COMMIT_GATE=block|warn|0)",
  harden: "wire security controls — pre-commit gate (gitleaks + commit gate) + sandbox settings",
  remember: "add a durable fact to this repo's portable memory (forge brain)",
  brain: "show / rebuild the portable project memory index",
  cost: "real per-day spend via ccusage + measured stage factors (--stages)",
  spec: "spec-as-contract — init (OpenSpec) / lock / check drift",
  cortex: "self-correcting project memory — status / why <symbol>",
  deja: "anti-repetition — have you done this task before? ranks prior solved/verified sessions",
  ledger:
    "evidence-referenced memory — stats / verify / show / blame / query / ratify / retract / merge / sync / import",
  reuse: "proof-carrying code cache — query <spec> / mint <spec> --file <path> / stats",
  context: "budgeted context assembly + completeness gate — what an edit NEEDS known",
  preflight: "assumption check — what a task names that the repo doesn't define",
  config: "provider setup — show / switch / add providers, set default model",
  route: "recommend the cheapest capable model for a task (+ gateway config)",
  impact: "predict blast radius for a symbol or file from the atlas graph",
  substrate: "one pre-action gate: assumptions, route, impact, scope, memory, verify",
  scope: "decompose files into independent clusters (+ coupled files you didn't name)",
  anchor: "goal-drift check — are your actual (git) changes still on the stated goal?",
  handoff: "bounded session snapshot — rewrite .forge/state.md, re-injected each session start",
  decide: "append-only decision log — D-#### ADR-lite entries in .forge/decisions.md",
  know: "route any fact to its storage home (decision / ledger / recall / …) — total, never dropped",
  diagnose:
    "doom-loop check — record a failure; 3× the same signature mints a diagnosis + escalation",
  imagine: "consequence simulation — predicted breaks + the minimal dry-run test suite for a task",
  lean: "scope-minimality (M5) — measure the diff's footprint vs what the task asked for",
  uicheck:
    "deterministic UI checks — contrast <fg> <bg> · fingerprint <file...> · design <file...> · visual <file-or-url>",
  dash: "live dashboard: ledger, metrics trends, radar, memory browser, timeline, blast radius",
  report: "emit a static, self-contained HTML snapshot of .forge/ — opens offline, no server",
  brand: "print the active brand token map",
  docs: {
    summary:
      "docs↔code drift — check (registry reconcile) / sync (diff-driven stale-docs sweep) / impact (reusable doc-reference graph: which docs mention what THIS diff changed)",
    usage: "forge docs [check | sync | impact] [--since <ref> | --staged] [--strict] [--json]",
    flags: [
      {
        flag: "--since <ref>",
        desc: "impact: diff against this git ref (default: session baseline, then HEAD)",
      },
      {
        flag: "--staged",
        desc: "impact/sync: diff the staged index instead of the working tree",
      },
      {
        flag: "--min-confidence <n>",
        desc: "impact: drop reference hits below this confidence (0..1)",
      },
      {
        flag: "--strict",
        desc: "exit non-zero when stale/impacted docs are found (for CI; advisory otherwise)",
      },
    ],
    examples: [
      "forge docs check",
      "forge docs sync",
      "forge docs impact",
      "forge docs impact --since main",
    ],
  },
  integrations:
    "opt-in third-party MCP servers (e.g. context7) — add records the managed set and writes only with --yes (--adopt claims a same-name entry); remove reverses it",
};

// Groups order the --help surface from the stable reliability loop down to experiments.
// "Labs" is the audit's P1-01 signal: those commands are experimental, not part of the
// core loop — grouped here so new users see the load-bearing beams first (nothing is
// removed; the full surface still ships).
export const GROUPS = {
  Core: ["init", "sync", "doctor", "tools", "catalog", "docs", "update", "config"],
  Substrate: [
    "substrate",
    "preflight",
    "impact",
    "scope",
    "context",
    "route",
    "verify",
    "precommit",
  ],
  Memory: ["cortex", "recall", "remember", "brain", "ledger", "handoff", "decide", "know"],
  Quality: ["scan", "spec", "harden", "radar"],
  Config: ["brand", "atlas", "stack", "integrations", "cost"],
  "Labs (experimental)": [
    "taste",
    "uicheck",
    "imagine",
    "lean",
    "anchor",
    "diagnose",
    "dash",
    "report",
    "deja",
    "reuse",
  ],
};

/** Commands that exist but are deliberately not advertised in --help or docs tables. */
export const HIDDEN_COMMANDS = ["cortex-mcp"];

/**
 * The one-line summary for a command — works for both string and object entries.
 * The single value-reader of COMMANDS (printHelp) goes through here so the table can
 * hold either shape. Unknown name → "".
 * @param {string} name
 * @returns {string}
 */
export function commandSummary(name) {
  const e = COMMANDS[name];
  if (!e) return "";
  return typeof e === "string" ? e : (e.summary ?? "");
}

/**
 * Normalized per-command help — always the full shape regardless of how the entry was
 * authored. A string entry yields its summary with empty usage/flags/examples/env.
 * @param {string} name
 * @returns {{summary:string, usage:string, flags:{flag:string,desc:string}[],
 *   examples:string[], env:string[]}|null} null for an unknown command
 */
export function commandHelp(name) {
  const e = COMMANDS[name];
  if (!e) return null;
  if (typeof e === "string") return { summary: e, usage: "", flags: [], examples: [], env: [] };
  return {
    summary: e.summary ?? "",
    usage: e.usage ?? "",
    flags: Array.isArray(e.flags) ? e.flags : [],
    examples: Array.isArray(e.examples) ? e.examples : [],
    env: Array.isArray(e.env) ? e.env : [],
  };
}
