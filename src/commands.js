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
  relay: {
    summary: "synchronize encrypted workspace evidence through a private relay",
    usage:
      "forge relay <configure|preview|push|watch|status|list|read|logout|delete|serve> [options]",
    examples: ["forge relay status", "forge relay list"],
  },
  cloud: {
    summary: "synchronize an enrolled workspace with its private dashboard",
    usage: "forge cloud <configure|preview|push|watch|status|logout|delete|serve> [options]",
    examples: ["forge cloud status", "forge cloud preview"],
  },
  agents: {
    summary: "inspect or run a single packaged agent or role brief",
    usage: "forge agents <list|show|run|install|uninstall> [id] [options]",
    examples: [
      "forge agents list --json",
      "forge agents show scout",
      "forge agents install scout --host claude",
    ],
  },
  skills: {
    summary: "discover, inspect and use packaged skills independently",
    usage:
      "forge skills <list|show|run|install|uninstall|scripts|capture-script|verify-script|pin-script|replay-script> [id] [options]",
    examples: [
      "forge skills list --json",
      "forge skills show forge-impact",
      "forge skills scripts",
    ],
  },
  init: {
    summary:
      "scaffold this repo's config — emits the tools it uses (detected hosts, or --tools) from one shared source",
    usage:
      "forge init [--tools <list|all>] [--review-edits | --no-review-edits] [--profile minimal|standard] [--no-settings | --settings-only | --remove-settings]",
    flags: [
      {
        flag: "--review-edits | --no-review-edits",
        desc: "Enable or disable a required impact review before each edit in this workspace.",
      },
      {
        flag: "--tools <list|all>",
        desc: "agent tools to emit config for, comma-separated (claude, cursor, gemini, codex, zed, vscode, aider, continue, windsurf, roo, openclaw, kimi, opencode) or all. Defaults to the recorded selection or the tools detected in this repo. A repo with no tool markers starts with Claude Code. Recorded in .forge/forge.config.json so later syncs emit the same set.",
      },
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
      {
        flag: "--no-warm",
        desc: "skip warming the atlas cache (init pre-builds it so the first `forge impact` is a warm query instead of a cold graph build)",
      },
    ],
    examples: [
      "forge init",
      "forge init --tools claude,cursor",
      "forge init --profile minimal",
      "forge init --remove-settings",
    ],
  },
  sync: {
    summary: "recompile the canonical source into each tool's native config files",
    usage: "forge sync",
    examples: ["forge sync"],
  },
  doctor: {
    summary: "health-check installed tools, guards, MCP auth, and config drift",
    usage: "forge doctor [--fix] [--adversarial]",
    flags: [
      {
        flag: "--fix",
        desc: "auto-repair safely fixable findings, then re-check",
      },
      {
        flag: "--adversarial",
        desc: "attack our own hooks with real payloads — rerouting attacks, malformed hook JSON, the permissions-bypass hole — and report the score",
      },
    ],
    examples: ["forge doctor", "forge doctor --fix", "forge doctor --adversarial"],
  },
  tools: {
    summary:
      "primary-tool config — gitignore secondary-tool artifacts (.cursor/.gemini/…) for tools this repo doesn't use (`forge tools <name>` sets it, `--reset` clears)",
    usage: "forge tools [<tool>|--reset] [--json]",
    examples: ["forge tools --json", "forge tools codex"],
  },
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
  taste: {
    summary: "enable one UI-taste tool for this repo (no arg = list)",
    usage: "forge taste [<style>]",
    examples: ["forge taste"],
  },
  atlas: {
    summary: "build / query the code-graph (where-is-Y, has-symbol)",
    usage: "forge atlas build [--ast|--portable] [--json] | query <text> | has <symbol>",
    examples: ["forge atlas build --portable", "forge atlas query freezeSuite"],
  },
  stack: {
    summary:
      "detect this repo's real stack (languages, frameworks, test commands) from its manifests",
    usage: "forge stack [--json]",
    examples: ["forge stack --json"],
  },
  radar: {
    summary:
      "dependency-currency rings — staleness/major-lag/advisories from live registry evidence, cached 24h",
    usage: "forge radar [--offline|--refresh] [--json]",
    examples: ["forge radar --offline --json"],
  },
  harness: {
    summary:
      "run host-neutral supervised tasks with policy, budgets, verification and replayable evidence",
    usage:
      "forge harness init|connect|trust|routes|run|resume|show|replay|stats|audit|drift|approvals|memory|extensions|jobs|council",
    examples: [
      "forge harness init --hosts claude,codex,kimi,generic --supervised",
      'forge harness run "Fix the retry bug" --accept "Retry tests pass"',
      'forge harness run "Review the change" --route reviewed --model MODEL_ID --model-profile NAME',
      'forge harness run "Check the release" --route review --model-profile openai --model YOUR_MODEL',
      "forge harness jobs tick",
      "forge harness memory org-grant engineering write",
      "forge harness memory org-grants",
      "forge harness memory share <item> organization --organization engineering",
      "forge harness memory recall <query> --organization engineering",
      "forge harness memory history <item> --organization engineering",
      "forge harness memory org-revoke engineering",
    ],
  },
  develop: {
    summary:
      "assemble a development plan, search prior solutions, assess security and select verification for the current change",
    usage:
      'forge develop "<task>" [--mode standard|focused|repair] [--web "<public search terms>"] [--verify] [--json]',
    examples: [
      'forge develop "Fix a PostgreSQL deadlock" --web "postgres application retry deadlock"',
      'forge develop "Verify the retry fix" --verify --json',
    ],
  },
  discover: {
    summary:
      "find task-fit skills, plugins, tools and hooks; configure global/workspace Jev advice",
    usage:
      'forge discover find "<task>" [--web "<public terms>"] [--json] | setup [--global] [--decisions on|off] [--recommendations on|off] [--search off|serper|brave] [--model jev-latest] | status | reset [--global]',
    examples: [
      "forge discover setup --global --decisions on --search serper",
      'forge discover find "React browser testing skills and hooks" --json',
      "forge discover status",
    ],
  },
  team: {
    summary:
      "plan independent read-only agents for complex work and optionally run them with a shared budget",
    usage:
      'forge team "<task>" [--brief FILE | --review] [--max-workers N] [--handoff <host> | --run kimi|codex --host-billing | --run claude --budget-usd N [--model ID]]',
    examples: [
      'forge team "Investigate a GitLab regression and compare retry libraries" --max-workers 2',
    ],
  },
  evidence: {
    summary:
      "find existing code, cached source excerpts and public research candidates before editing or debugging",
    usage: 'forge evidence "<task>" [--web "<public query>"] [--json]',
    flags: [
      {
        flag: "--web <terms>",
        desc: "send these separately supplied public terms to discovery providers",
      },
      { flag: "--json", desc: "include provenance and source warnings" },
    ],
    examples: [
      'forge evidence "Investigate PostgreSQL deadlocks"',
      'forge evidence "Choose a parser" --web "streaming XLSX Node.js"',
    ],
  },
  sources: {
    summary:
      "sync scoped project sources privately and search, route live reads or aggregate local tables",
    usage:
      "forge sources init|status|sync [id] [--full]|update-page <id> <page> --version N --title TITLE --body-file FILE|probe <id>|get <id> [item] [--chunk N]|sql <id> <SELECT>|read <id> <record>|search <query>|route <id> <operation>|aggregate <id> <path> <operation>",
    flags: [
      { flag: "--source <id>", desc: "restrict search to one configured source" },
      { flag: "--budget <tokens>", desc: "estimated token budget for search excerpts" },
      { flag: "--fresh --mcp", desc: "route a live operation through an available MCP server" },
      {
        flag: "--column X --group-by Y --sheet Z",
        desc: "select table columns and worksheet for aggregation",
      },
    ],
    examples: [
      "forge sources init",
      'forge sources search "retry policy" --budget 400',
      "forge sources aggregate docs usage.csv sum --column minutes",
    ],
  },
  recall: {
    summary: "manage cross-session memory (list / add / consolidate)",
    usage: 'forge recall list | add "<name>" "<fact>" | consolidate',
    examples: [
      "forge recall list",
      'forge recall add "test command" "Run npm test from the repository root"',
    ],
  },
  catalog: {
    summary: "Start Here — list every tool, crew, and guard with a one-line why",
    usage: "forge catalog",
    examples: ["forge catalog"],
  },
  scan: {
    summary: "vet a skill/MCP for injection/RCE/exfil before install (skill-gate)",
    usage: "forge scan <SKILL.md|.mcp.json|path>",
    examples: ["forge scan skills/forge-impact/SKILL.md"],
  },
  vet: {
    summary:
      "vet a package before install (dep-gate) — is the name on its registry, is it listed malicious, how new and thin is it",
    usage:
      'forge vet <ecosystem:name[@version]>… | --cmd "<install command>" | --lockfile [path] [--json]',
    flags: [
      {
        flag: '--cmd "<command>"',
        desc: "vet every package an install command line would fetch (the PreToolUse guard's view)",
      },
      {
        flag: "--lockfile [path]",
        desc: "query OSV for exact public npm package versions in a lockfile (default package-lock.json)",
      },
      { flag: "--json", desc: "print the evidence and verdict per package as JSON" },
    ],
    examples: [
      "forge vet npm:left-pad pypi:requests==2.31.0 cargo:serde",
      "forge vet go:github.com/spf13/cobra@v1.8.0 maven:org.slf4j:slf4j-api@2.0.9 gem:rails",
      'forge vet --cmd "npm install some-new-package"',
    ],
  },
  hooks: {
    summary:
      "run the guards by themselves in every agent — project-level hook files for Claude Code, Codex, Gemini CLI, Cursor, Copilot and OpenCode (cloud agents and CI included)",
    usage:
      "forge hooks [status | on | off | list | show <id> | invoke <id> | enable <id> --host claude | disable <id> --host claude | run <host> <event>] [--hosts a,b] [--bootstrap] [--json]",
    flags: [
      {
        flag: "--hosts <a,b>",
        desc: "with `on`: only these hosts (claude, codex, gemini, cursor, copilot, opencode) instead of every tool the repo emits for",
      },
      {
        flag: "--bootstrap",
        desc: "with `on`: a session start installs this exact forge version when the CLI is missing (fresh cloud or CI machines)",
      },
      { flag: "--json", desc: "print status or the written files as JSON" },
    ],
    examples: [
      "forge hooks",
      "forge hooks on",
      "forge hooks on --hosts claude,codex --bootstrap",
      "forge hooks enable protect-paths --host claude",
      "forge hooks disable protect-paths --host claude",
      "forge hooks off",
    ],
  },
  verify: {
    summary:
      "independent verification gate — tests + hallucinated-symbol + provenance (--deep: multi-lens consensus)",
    usage:
      "forge verify [--base <revision>] [--deep [--llm]] [--json] | forge verify --claim <receipt.json> [--json] | forge verify triage [--json]",
    examples: ["forge verify --base HEAD --json", "forge verify --claim receipt.json"],
  },
  demo: {
    summary:
      "scripted scenario — a throwaway repo goes green → broken → green while forge verify watches (the README hero, runnable)",
    usage: "forge demo [workshop] [--json]",
    examples: ["forge demo", "forge demo workshop --json"],
  },
  precommit: {
    summary:
      "commit-level gate — staged code w/o docs + secret scan (FORGE_COMMIT_GATE=block|warn|0)",
    usage: "forge precommit [--require-verified] [--json]",
    examples: ["forge precommit --json"],
  },
  "test-select": {
    summary:
      "smart test selection — the tier contract as a command: which tests this change owes (selection only, never runs them)",
    usage: `forge test-select [--changed <a,b> | --base <ref> --head <ref>] [--evidence <absolute-path>] [--json] | forge test-select --state [--json] | forge test-select --register <absolute-path>`,
    flags: [
      {
        flag: "--changed <a,b>",
        desc: "comma-separated changed files; default: the working tree (staged + unstaged + untracked)",
      },
      {
        flag: "--base <ref> --head <ref>",
        desc: "select for a ref range (git diff base...head) instead of the working tree",
      },
      { flag: "--evidence <path>", desc: "use an external dependency-evidence manifest" },
      { flag: "--register <path>", desc: "register dependency evidence for this workspace" },
      { flag: "--state", desc: "show the inputs used to identify this verification state" },
      { flag: "--json", desc: "machine-readable plan" },
    ],
    examples: [
      "forge test-select",
      "forge test-select --changed src/atlas.js",
      "forge test-select --json",
    ],
  },
  harden: {
    summary: "wire security controls — pre-commit gate (gitleaks + commit gate) + sandbox settings",
    usage: "forge harden [--require-verified]",
    examples: ["forge harden"],
  },
  remember: {
    summary: "add a durable fact to this repo's portable memory (forge brain)",
    usage: 'forge remember "<name>" "<fact>"',
    examples: ['forge remember "runner" "Integration checks use the staging fixture"'],
  },
  brain: {
    summary: "review memory proposals and rebuild the approved project index",
    usage: "forge brain | forge brain proposals|approve <id>|reject <id>|conflicts",
    examples: ["forge brain proposals --json", "forge brain conflicts"],
  },
  cost: {
    summary: "inspect spend, stage factors and paired evaluation outcomes",
    usage: "forge cost [--stages] | pilot <init|freeze|template|compare> [options]",
    examples: ["forge cost --stages", "forge cost pilot init suite.json"],
  },
  budget: {
    summary:
      "cost governance — per-day and per-task spend budgets, alert threshold, and an opt-in circuit breaker the cost guard enforces",
    usage:
      "forge budget set --daily 10 --per-task 2 [--alert-at 0.8] [--hard|--soft] | forge budget status [--json] | forge budget clear [--daily|--per-task] | forge budget check --session-id <sid>",
    flags: [
      {
        flag: "--daily <n>",
        desc: "per-day spend budget in USD. FORGE_COST_CEILING overrides it when set; unset, the historic $10/day soft ceiling applies.",
      },
      {
        flag: "--per-task <n>",
        desc: "per-task (session) spend budget in USD — the guard snapshots spend at session start and measures the delta.",
      },
      {
        flag: "--alert-at <0–1>",
        desc: "warn when spend reaches this fraction of a budget (default 0.8).",
      },
      {
        flag: "--hard",
        desc: "circuit breaker: tool calls are BLOCKED past a budget (deny). Default is soft: the guard asks you.",
      },
      {
        flag: "--soft",
        desc: "revert to soft mode (ask, never block).",
      },
    ],
    examples: [
      "forge budget set --daily 10 --per-task 2",
      "forge budget set --hard",
      "forge budget status",
      "forge budget clear",
    ],
  },
  models: {
    summary: "list model inventories by provider profile, cache age and measured workload band",
    usage:
      "forge models [--schema 1|2] [--profile <name>] [--workload <name>] [--capability <value>] [--availability <state>] [--max-age <duration>] [--refresh|--offline] [--json]",
    flags: [
      {
        flag: "--schema 1|2",
        desc: "v1 legacy four-tier view or v2 profile inventory (plain --json defaults to v1)",
      },
      { flag: "--profile <name>", desc: "show one configured model profile" },
      { flag: "--workload <name>", desc: "compare paired verified outcomes for this workload" },
      {
        flag: "--capability <value>",
        desc: "match an advertised operation, parameter or modality; use unknown for absent metadata",
      },
      {
        flag: "--availability <state>",
        desc: "match listed, public-listed, configured-only, observed-only, recently-callable, stale, denied or unknown",
      },
      {
        flag: "--max-age <duration>",
        desc: "filter evidence by age in seconds, or use units such as 30m, 4h or 1d; required for recently-callable",
      },
      { flag: "--refresh", desc: "refresh enabled provider listings without an inference call" },
      { flag: "--offline", desc: "use only private cached and configured model IDs" },
      { flag: "--json", desc: "print machine-readable results" },
    ],
    examples: [
      "forge models",
      "forge models --schema 2 --offline --json",
      "forge models --profile openai --refresh",
    ],
  },
  spec: {
    summary: "spec-as-contract — init (OpenSpec) / lock / check drift",
    usage: "forge spec init | lock | check",
    examples: ["forge spec check"],
  },
  cortex: {
    summary: "inspect project memory and review privately observed corrections",
    usage:
      "forge cortex status | why <symbol-or-file> | review [--json] | confirm <lesson-id|full-claim-hash> [--json]",
    examples: ["forge cortex why src/ledger.js", "forge cortex review --json"],
  },
  deja: {
    summary:
      "anti-repetition — have you done this task before? ranks prior solved/verified sessions",
    usage: 'forge deja "<task>" [--json]',
    examples: ['forge deja "Review the checkout totals" --json'],
  },
  ledger: {
    summary:
      "evidence-referenced memory — stats / verify / show / blame / query / compact / at / diff / root / ratify / retract / merge / sync / import",
    usage:
      "forge ledger <stats|verify|show|blame|query|compact|at|diff|root|ratify|retract|merge|sync|import|index|migrate|restore-legacy> [arguments] [--personal] [--json]",
    examples: [
      "forge ledger stats --json",
      'forge ledger query "release checklist"',
      "forge ledger compact --dry-run",
      "forge ledger migrate --json",
      "forge ledger restore-legacy /tmp/recovered-forge-memory",
    ],
  },
  claim: {
    summary:
      "claim interop — export the ledger's claims as open JSON any tool can read (step 1 toward claims as a standard)",
    usage: "forge claim export [--out <file>] [--pretty]",
    flags: [
      {
        flag: "--out <file>",
        desc: "write the export document to a file instead of stdout",
      },
      {
        flag: "--pretty",
        desc: "pretty-print the JSON (default is compact)",
      },
    ],
    examples: ["forge claim export --pretty", "forge claim export --out claims.json --pretty"],
  },
  reuse: {
    summary: "proof-carrying code cache — query <spec> / mint <spec> --file <path> / stats",
    usage:
      'forge reuse stats | query "<task>" | mint "<task>" --file <path> [--ref <evidence>] [--json]',
    examples: ['forge reuse query "create a weekly cost report" --json', "forge reuse stats"],
  },
  context: {
    summary:
      "budgeted context assembly + completeness gate — what an edit NEEDS known, delivered or owed",
    usage:
      'forge context "<task>" [--budget <units>] [--encoding <name>] [--block] [--json] [--packet [--ack <revision>]]',
    flags: [
      {
        flag: "--budget <units>",
        desc: "budget for the rendered context in the selected counting units (default 6000)",
      },
      {
        flag: "--encoding <name>",
        desc: "count UTF-8 bytes (default) or use a named encoding from an independently installed js-tiktoken",
      },
      { flag: "--block", desc: "print the assembled context block itself (what gets delivered)" },
      {
        flag: "--packet",
        desc: "emit a versioned JSON packet with delivered evidence and revision",
      },
      {
        flag: "--ack <revision>",
        desc: "send changes against an exact packet retained by this client",
      },
      { flag: "--json", desc: "machine-readable result (add --block to include the block)" },
    ],
    examples: ['forge context "update computeTax in src/tax.js" --block'],
  },
  preflight: {
    summary: "assumption check — what a task names that the repo doesn't define",
    usage: 'forge preflight "<task>" [--require-file <path>]... [--json]',
    examples: ['forge preflight "Review freezeSuite in src/rollout_eval.js" --json'],
  },
  config: {
    summary: "provider setup — show / switch / add providers, set default model",
    usage:
      "forge config show | providers | provider <name> | provider add <name> --base-url <url> [--key-env <VAR>] | model <tier> | model --exact <model-id> [--profile <name>]",
    examples: ["forge config show --json", "forge config providers"],
  },
  route: {
    summary:
      "choose a currently listed deployment from verified results on a comparable workload, or explain what is missing",
    usage:
      'forge route "<task>" [--provider NAME] [--workload NAME] [--objective SPEC] [--band low|medium|high] [--apply] [--json] | forge route calibrate [--workload NAME] | forge route gateway | forge route monitor <observations.json> | forge route universal …',
    flags: [
      { flag: "--provider <name>", desc: "provider profile whose inventory to consider" },
      { flag: "--workload <name>", desc: "workload with attributed verified outcomes" },
      { flag: "--objective <spec>", desc: "requested success, cost and latency objectives" },
      {
        flag: "--band <low|medium|high>",
        desc: "restrict to a band supported by workload measurements",
      },
      { flag: "--apply", desc: "apply the recommended provider and model to the active tool" },
      { flag: "--json", desc: "include the inventory, decision status, evidence and reasons" },
    ],
    examples: [
      'forge route "Review the change" --provider openai --workload review --json',
      "forge route calibrate --workload review",
    ],
  },
  orchestration: {
    summary:
      "agent-orchestration rule pack (no polling, parallel cap, CI for heavy checks, fresh sub-agents, model routing, risk review, isolated envs, lean lead) and model authorization — list or switch rules, set the parallel limit or top deployment policy per repo or --global",
    usage:
      "forge orchestration [list] [--json]   |   forge orchestration on|off <rule-id|all|pack> [--global]   |   forge orchestration set <key> <value> [--global]",
    flags: [
      {
        flag: "--global",
        desc: "write the user-level config (<state dir>/forge.config.json) instead of this repo's .forge/forge.config.json; the repo's value wins where both are set",
      },
      { flag: "--json", desc: "machine-readable state (list only)" },
    ],
    examples: [
      "forge orchestration",
      "forge orchestration off orch.parallel-cap",
      "forge orchestration set parallelCap 3",
      "forge orchestration set route.topTier explicit --global",
      "forge orchestration set route.topTier never",
    ],
  },
  advisor: {
    summary:
      "Claude Code's advisor tool — a stronger second model consulted at decision points: set the advisor per repo (emitted into .claude/settings.json by sync, with an Advisor rule section in AGENTS.md) or --global, check a main/advisor pairing before Claude Code refuses it, list accepted pairings",
    usage:
      "forge advisor [status] [--json]   |   forge advisor set <model|off> [--global]   |   forge advisor off | reset [--global]   |   forge advisor rule on|off <rule-id|all> [--global]   |   forge advisor pairings [<main-model>]   |   forge advisor check <main-model> <advisor-model>",
    flags: [
      {
        flag: "--global",
        desc: "write the user-level config and ~/.claude/settings.json (what Claude Code's /advisor saves to) instead of this repo's .forge/forge.config.json and .claude/settings.json; the repo's value wins where both are set",
      },
      { flag: "--json", desc: "machine-readable state (status, pairings, check)" },
    ],
    env: [
      "CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1  Claude Code ignores any advisorModel; status and doctor say so",
      "DISABLE_TELEMETRY / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  turn feature-flag fetching off, which keeps the advisor off",
      "ANTHROPIC_MODEL  the main model the pairing is checked against (else Claude Code's settings, else the account default)",
    ],
    examples: [
      "forge advisor",
      "forge advisor set opus",
      "forge advisor set fable --global",
      "forge advisor check sonnet opus",
      "forge advisor pairings claude-opus-5-5",
      "forge advisor rule off advisor.before-done",
      "forge advisor off",
    ],
  },
  impact: {
    summary:
      "hazard-aware blast radius — SCC-aware propagation + data-driven threshold from PageRank centrality and ledger incident history",
    usage:
      "forge impact <symbol|file> [--json] [--basic] [--all-relations] | forge impact --diff [--staged | --since <ref>] [--json] | forge impact --review <receipt-id> [--json]",
    flags: [
      { flag: "--json", desc: "machine-readable report" },
      {
        flag: "--diff",
        desc: "impact of the working diff (vs HEAD, plus untracked files): coupled invariants the graph cannot see — a set a require-all validator quantifies over, a store a sibling binary writes — then the graph's dependents",
      },
      { flag: "--staged", desc: "diff mode over the index instead of the working tree" },
      { flag: "--since <ref>", desc: "diff mode against this git ref instead of HEAD" },
      {
        flag: "--all-relations",
        desc: "also walk sibling and forward relations (recall instrument; much larger, noisier answer)",
      },
      {
        flag: "--basic",
        desc: "skip hazard-aware enhancements (fixed threshold, no SCC expansion)",
      },
    ],
    examples: [
      "forge impact src/atlas.js",
      "forge impact computeTax --json",
      "forge impact src/val.js --basic",
      "forge impact --diff",
    ],
  },
  collide: {
    summary:
      "parallel-session conflict radar — who else recently touched the files (or their import neighbors) you are editing",
    usage: "forge collide [<file>…] [--json]",
    flags: [
      {
        flag: "[<file>…]",
        desc: "check these files instead of the working diff",
      },
      { flag: "--json", desc: "machine-readable report" },
    ],
    examples: ["forge collide", "forge collide src/auth.js --json"],
  },
  rank: {
    summary:
      "load-bearing code — PageRank centrality × past-incident history, circular-dependency clusters, chokepoint files",
    usage: "forge rank [--top <n>] [--json]",
    flags: [
      {
        flag: "--top <n>",
        desc: "how many files/symbols to list (default 15)",
      },
      { flag: "--json", desc: "machine-readable full report" },
    ],
    examples: ["forge rank", "forge rank --top 5 --json"],
  },
  substrate: {
    summary: "one pre-action gate: assumptions, route, impact, scope, memory, verify",
    usage: 'forge substrate "<task>" [--json]',
    examples: ['forge substrate "Update the billing summary in src/cost_report.js" --json'],
  },
  scope: {
    summary: "decompose files into independent clusters (+ coupled files you didn't name)",
    usage: "forge scope <file> [file ...] [--json]",
    examples: ["forge scope src/cost_report.js src/metrics.js --json"],
  },
  anchor: {
    summary: "goal-drift check — are your actual (git) changes still on the stated goal?",
    usage: 'forge anchor ["<goal>"] [--json] | set "<goal>" | show | clear',
    examples: ["forge anchor show", 'forge anchor "Keep public API names stable" --json'],
  },
  handoff: {
    summary: "save or resume a bounded session snapshot with portable evidence",
    usage:
      "forge handoff <summary> [--next <step>] [--evidence <tracked-path>] | forge handoff --resume [--json]",
    examples: ["forge handoff --resume --json"],
  },
  decide: {
    summary: "append-only decision log — D-#### ADR-lite entries in .forge/decisions.md",
    usage:
      'forge decide ["<decision and reason>"] [--json] | compare <file.json> [--record] [--json]',
    examples: ["forge decide --json", "forge decide compare alternatives.json --json"],
  },
  know: {
    summary:
      "route any fact to its storage home (decision / ledger / recall / …) — total, never dropped",
    usage: 'forge know "<fact>" [--dry-run] [--json]',
    examples: [
      'forge know "The team validates billing imports against last month" --dry-run --json',
    ],
  },
  diagnose: {
    summary:
      "doom-loop check — record a failure; 3× the same signature mints a diagnosis + escalation",
    usage:
      'forge diagnose "<error text>" [--file <path>] [--symbol <name>] [--task "<task>"] [--json]',
    examples: ['forge diagnose "Expected 3 rows but received 2" --file src/cost_report.js --json'],
  },
  imagine: {
    summary:
      "consequence simulation — predicted breaks + the minimal dry-run test suite for a task",
    usage: 'forge imagine "<task>" [--run] [--allow-dirty] [--json]',
    examples: ['forge imagine "Change the format of the billing summary" --json'],
  },
  lean: {
    summary: "scope-minimality (M5) — measure the diff's footprint vs what the task asked for",
    usage: 'forge lean "<task>" [--json]',
    examples: ['forge lean "Update the billing summary" --json'],
  },
  uicheck: {
    summary:
      "deterministic UI checks — contrast <fg> <bg> · fingerprint <file...> · design <file...> · visual <file-or-url>",
    usage:
      "forge uicheck contrast <fg> <bg> [--large] [--json] | fingerprint <file...> [--theme <file>]... [--mint] [--json] | design <file...> [--theme <file>]... [--taste <name>] [--json] | visual <file-or-url> | interact <file-or-url> | journey <file-or-url> --spec <json-file> [--json]",
    flags: [
      {
        flag: "--large",
        desc: "contrast: grade against the large-text / UI-component bar (AA 3:1) instead of normal text (AA 4.5:1); exit 1 when AA fails either way",
      },
      {
        flag: "--json",
        desc: "machine-readable result (contrast: ratio, level, the composited hexes compared, notes; design: verdict pass | fail | insufficient-signal)",
      },
      {
        flag: "--theme <file>",
        desc: "fingerprint/design: the Tailwind theme source(s) — a v4 @theme stylesheet or a tailwind.config — that resolve token utilities (rounded-card, shadow-lift, bg-brand); repeatable; replaces auto-discovery",
      },
      {
        flag: "--taste <name>",
        desc: "design/visual: gate thresholds + checks from a taste profile (default: the style pinned by a forge-taste DESIGN.md)",
      },
      {
        flag: "--mint",
        desc: "fingerprint: store the vector as the project's design claim (refused, exit 1, when it is empty)",
      },
    ],
    examples: [
      'forge uicheck contrast "#777" "#fff"',
      'forge uicheck contrast "oklch(0.55 0.1 250)" "#fff" --large --json',
      "forge uicheck design src/components/Card.tsx",
      "forge uicheck design src/components/*.tsx --theme src/app/globals.css",
    ],
  },
  dash: {
    summary:
      "open a local project dashboard to inspect runs, check agent setup and review project memory",
    usage: "forge dash [--port N]",
    flags: [
      {
        flag: "--port <N>",
        desc: "listen on this local port (default 4242). Use 0 to choose a free port.",
      },
    ],
    examples: ["forge dash", "forge dash --port 4243"],
  },
  report: {
    summary: "emit a static, self-contained HTML snapshot of .forge/ — opens offline, no server",
    usage: "forge report [--out <path>]",
    examples: ["forge report --out review.html"],
  },
  brand: {
    summary: "print the active brand token map",
    usage: "forge brand",
    examples: ["forge brand"],
  },
  docs: {
    summary:
      "docs↔code drift — check (registry reconcile) / render (regenerate machine-owned tables + diagrams) / sync (diff-driven stale-docs sweep) / impact (reusable doc-reference graph: which docs mention what THIS diff changed)",
    usage:
      "forge docs [check | render | sync | impact] [--check] [--since <ref> | --staged] [--strict] [--json]",
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
      {
        flag: "--check",
        desc: "render: report stale generated blocks without writing (exit 1 on strict drift)",
      },
    ],
    examples: [
      "forge docs check",
      "forge docs render",
      "forge docs sync",
      "forge docs impact",
      "forge docs impact --since main",
    ],
  },
  hikmah: {
    summary: "bind a local Hikmah kernel ledger and recall its verified public lessons",
    usage:
      "forge hikmah on --binary <absolute-path> --store <absolute-path> | recall <query> | status | off",
    examples: ["forge hikmah status"],
  },
  prompts: {
    summary: "choose a workspace development profile or show a portable prompt and specialist role",
    usage:
      "forge prompts list | use engineering|quran|off | status | show <master|pain-id|role-id> [--profile engineering|quran]",
    examples: ["forge prompts use engineering", "forge prompts show master --profile quran"],
  },
  integrations: {
    summary:
      "choose project integrations, register custom packages and connect hosted or self-managed MCP endpoints",
    usage:
      'forge integrations template [--out <new-directory>] [--json] | list [--json] | select [id] | connect <id> [--url URL] [--token-env NAME] | local <id> --binary PATH [--arg ARG] | register <descriptor.json> | unregister <id> | find "<task>" | install <id> | auto on <id>... | auto off|status | add <id> [--yes] | remove <id>',
    examples: [
      "forge integrations template --json",
      'forge integrations find "test a browser checkout flow"',
      "forge integrations install playwright",
      "forge integrations auto status",
    ],
  },
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
    "evidence",
    "team",
    "develop",
    "agents",
    "skills",
    "sources",
    "impact",
    "scope",
    "context",
    "route",
    "orchestration",
    "harness",
    "advisor",
    "verify",
    "demo",
    "precommit",
    "test-select",
  ],
  Memory: [
    "hikmah",
    "cortex",
    "recall",
    "remember",
    "brain",
    "ledger",
    "claim",
    "handoff",
    "decide",
    "know",
  ],
  Quality: ["scan", "vet", "spec", "harden", "radar", "hooks"],
  Config: [
    "prompts",
    "discover",
    "brand",
    "atlas",
    "stack",
    "integrations",
    "cost",
    "budget",
    "models",
  ],
  "Labs (experimental)": [
    "taste",
    "uicheck",
    "imagine",
    "lean",
    "anchor",
    "diagnose",
    "dash",
    "cloud",
    "relay",
    "report",
    "deja",
    "reuse",
    "rank",
    "collide",
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
