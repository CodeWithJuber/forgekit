// forge commands — the CLI's command surface as DATA. cli.js renders --help from
// this table and docs_check.js reconciles README/GUIDE against it, so a command can
// no longer ship (or disappear) without the docs check noticing. One line per command.

export const COMMANDS = {
  init: "scaffold this repo's config — emits every tool from one shared source",
  sync: "recompile the canonical source into each tool's native config files",
  doctor: "health-check installed tools, guards, MCP auth, and config drift",
  update: "self-update — `--check` reports if a newer version is available, bare applies it",
  taste: "enable one UI-taste tool for this repo (no arg = list)",
  atlas: "build / query the code-graph (where-is-Y, has-symbol)",
  stack: "detect this repo's real stack (languages, frameworks, test commands) from its manifests",
  recall: "manage cross-session memory (list / add / consolidate)",
  catalog: "Start Here — list every tool, crew, and guard with a one-line why",
  scan: "vet a skill/MCP for injection/RCE/exfil before install (skill-gate)",
  verify: "independent verification gate — tests + hallucinated-symbol + provenance",
  precommit:
    "commit-level gate — staged code w/o docs + secret scan (FORGE_COMMIT_GATE=block|warn|0)",
  harden: "wire security controls — pre-commit gate (gitleaks + commit gate) + sandbox settings",
  remember: "add a durable fact to this repo's portable memory (forge brain)",
  brain: "show / rebuild the portable project memory index",
  cost: "real per-day spend via ccusage + measured stage factors (--stages)",
  spec: "spec-as-contract — init (OpenSpec) / lock / check drift",
  cortex: "self-correcting project memory — status / why <symbol>",
  ledger:
    "proof-carrying memory — stats / verify / show / blame / query / ratify / retract / merge / import",
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
  dash: "local dashboard over the ledger, metrics, and blast radius",
  brand: "print the active brand token map",
  docs: "docs↔code drift — check (registry reconcile) / sync (diff-driven stale-docs sweep)",
};

export const GROUPS = {
  Core: ["init", "sync", "doctor", "catalog", "docs", "update"],
  Memory: ["cortex", "recall", "remember", "brain", "ledger", "reuse", "handoff", "decide", "know"],
  Substrate: [
    "substrate",
    "preflight",
    "route",
    "impact",
    "scope",
    "context",
    "anchor",
    "diagnose",
    "imagine",
    "lean",
  ],
  Quality: ["verify", "precommit", "scan", "spec", "taste", "uicheck", "harden"],
  Config: ["config", "cost", "dash", "brand", "atlas", "stack"],
};

/** Commands that exist but are deliberately not advertised in --help or docs tables. */
export const HIDDEN_COMMANDS = ["cortex-mcp"];
