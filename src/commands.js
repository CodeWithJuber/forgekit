// forge commands — the CLI's command surface as DATA. cli.js renders --help from
// this table and docs_check.js reconciles README/GUIDE against it, so a command can
// no longer ship (or disappear) without the docs check noticing.
//
// An entry is EITHER a one-line summary string OR a rich object
// `{summary, usage?, flags?, examples?, env?, exit?, strict?, subcommands?, defaultSub?}` —
// both coexist permanently. A flag object may carry `for` (the subcommands it applies to),
// `values` (an enumeration), `int` ({min, max}), `multiple` (repeatable) and `requires`
// (another flag it only makes sense with); src/cli/args.js enforces them for strict entries. Read a
// summary via commandSummary(name) (printHelp is the only value-reader), and the full
// per-command help via commandHelp(name). docs_check only reads Object.keys(COMMANDS),
// so migrating a value from string to object never affects the docs reconciler.

/**
 * @typedef {{flag: string, desc: string, for?: string[], values?: string[],
 *   int?: {min?: number, max?: number}, multiple?: boolean, requires?: string}} FlagEntry
 */

export const COMMANDS = {
  relay: {
    summary:
      "synchronize encrypted workspace evidence through a private relay that stores only ciphertext",
    usage:
      "forge relay configure --full-workspace [--include-ignored] --url <origin> --tenant <id> --workspace <id> --token-env <variable> --key-env <variable> | preview [--include-ignored] | push [--replace-remote --confirm] | watch [--interval <seconds>] | status [--remote] | list [--revision <id>] | read <path> [--revision <id>] [--json] | logout | delete --confirm | serve --config <server.json>",
    strict: true,
    subcommands: [
      "configure",
      "preview",
      "push",
      "watch",
      "status",
      "list",
      "read",
      "logout",
      "delete",
      "serve",
      "help",
    ],
    defaultSub: "help",
    flags: [
      {
        flag: "--full-workspace",
        for: ["configure"],
        desc: "required: confirms that project files and recorded sessions, prompts, traces and repo memory are included",
      },
      {
        flag: "--include-ignored",
        for: ["configure", "preview"],
        desc: "also include files Git ignores (secrets are still redacted)",
      },
      {
        flag: "--url <origin>",
        for: ["configure"],
        desc: "the relay's origin, https in production",
      },
      { flag: "--tenant <id>", for: ["configure"], desc: "the tenant this workspace belongs to" },
      {
        flag: "--workspace <id>",
        for: ["configure"],
        desc: "the workspace ID; a new key generation needs a new ID",
      },
      {
        flag: "--token-env <variable>",
        for: ["configure"],
        desc: "the environment variable that holds this device's scoped bearer credential (the name is stored, never the value)",
      },
      {
        flag: "--key-env <variable>",
        for: ["configure"],
        desc: "the environment variable that holds the workspace encryption key: 32 random bytes, standard base64",
      },
      {
        flag: "--replace-remote",
        for: ["push"],
        desc: "rebuild the baseline from what the relay holds now, dropping a pending upload (needs --confirm)",
      },
      {
        flag: "--confirm",
        for: ["push", "delete"],
        desc: "confirm --replace-remote or a remote delete",
      },
      {
        flag: "--interval <seconds>",
        for: ["watch"],
        int: { min: 1, max: 86400 },
        desc: "seconds between pushes (default 30); failures back off up to 5 minutes",
      },
      {
        flag: "--remote",
        for: ["status"],
        desc: "also fetch and authenticate the relay's current revision, and compare it with this device's history",
      },
      {
        flag: "--revision <id>",
        for: ["list", "read"],
        desc: "require exactly this revision, received over an independent channel; without it the served revision is checked against what this device has seen",
      },
      {
        flag: "--path <path>",
        for: ["read"],
        desc: "the artifact to read, for a path that starts with a dash",
      },
      {
        flag: "--json",
        for: ["read", "preview"],
        desc: "read: print the verified artifact as JSON with its bytes in base64, instead of the raw bytes",
      },
      {
        flag: "--config <server.json>",
        for: ["serve"],
        desc: "the receiver's operator configuration",
      },
    ],
    env: [
      "FORGE_HOME   where enrollment, the encrypted queue and the revision history are kept (outside the project)",
    ],
    exit: [
      "0  done; every form prints JSON, except read without --json (the verified bytes) and serve",
      "1  refused or failed: no enrollment, authentication or validation failed, the relay served an older or forked revision than this device has seen, the relay could not be reached, HTTP 4xx/5xx, or a usage error",
    ],
    examples: [
      "forge relay configure --full-workspace --url https://relay.example.org --tenant team --workspace demo --token-env WORKSPACE_ACCESS --key-env WORKSPACE_RELAY_KEY",
      "forge relay push",
      "forge relay status --remote",
      'forge relay read README.md --revision "$EXPECTED_REVISION" --json',
    ],
  },
  cloud: {
    summary: "synchronize an enrolled workspace with its private dashboard",
    usage:
      "forge cloud configure --full-workspace [--include-ignored] --url <origin> --workspace <id> --token-env <variable> | preview [--include-ignored] [--json] | push [--replace-remote --confirm] | watch [--interval <seconds>] | status [--remote] | logout | delete --confirm | serve --config <server.json>",
    strict: true,
    subcommands: [
      "configure",
      "preview",
      "push",
      "watch",
      "status",
      "logout",
      "delete",
      "serve",
      "help",
    ],
    defaultSub: "help",
    flags: [
      {
        flag: "--full-workspace",
        for: ["configure"],
        desc: "required: confirms that project files and recorded sessions, prompts, traces and repo memory are included",
      },
      {
        flag: "--include-ignored",
        for: ["configure", "preview"],
        desc: "also include files Git ignores (secrets are still redacted)",
      },
      {
        flag: "--url <origin>",
        for: ["configure"],
        desc: "the dashboard's origin, https in production",
      },
      { flag: "--workspace <id>", for: ["configure"], desc: "the workspace ID on that dashboard" },
      {
        flag: "--token-env <variable>",
        for: ["configure"],
        desc: "the environment variable that holds this device's scoped bearer credential (the name is stored, never the value)",
      },
      {
        flag: "--replace-remote",
        for: ["push"],
        desc: "rebuild the baseline from what the dashboard holds now, dropping a pending upload (needs --confirm)",
      },
      {
        flag: "--confirm",
        for: ["push", "delete"],
        desc: "confirm --replace-remote or a remote delete",
      },
      {
        flag: "--interval <seconds>",
        for: ["watch"],
        int: { min: 1, max: 86400 },
        desc: "seconds between pushes (default 30); failures back off up to 5 minutes",
      },
      { flag: "--remote", for: ["status"], desc: "also fetch the dashboard's current revision" },
      {
        flag: "--json",
        for: ["preview"],
        desc: "accepted for symmetry; preview always prints JSON",
      },
      {
        flag: "--config <server.json>",
        for: ["serve"],
        desc: "the dashboard's operator configuration",
      },
    ],
    env: ["FORGE_HOME   where enrollment and the pending upload are kept (outside the project)"],
    exit: [
      "0  done; every form prints JSON except serve, which prints its address",
      "1  refused or failed: no enrollment, a pending upload outside its scope, the dashboard could not be reached, HTTP 4xx/5xx, or a usage error",
    ],
    examples: ["forge cloud status", "forge cloud preview", "forge cloud push"],
  },
  init: {
    summary:
      "scaffold this repo's config — emits the tools it uses (detected hosts, or --tools) from one shared source",
    usage:
      "forge init [--tools <list|all>] [--profile minimal|standard] [--no-settings | --settings-only | --remove-settings]",
    flags: [
      {
        flag: "--tools <list|all>",
        desc: "agent tools to emit config for, comma-separated (claude, cursor, gemini, codex, zed, vscode, aider, continue, windsurf, roo, openclaw, kimi) or all. Defaults to the recorded selection or the tools detected in this repo. A repo with no tool markers starts with Claude Code. Recorded in .forge/forge.config.json so later syncs emit the same set.",
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
  taste: {
    summary:
      "pin one visual direction for this repo's UI work by writing a managed DESIGN.md (no style = list them)",
    usage: "forge taste [<style>] [--json]",
    strict: true,
    flags: [
      {
        flag: "[<style>]",
        desc: "the direction to pin; without it the available styles are listed",
      },
      {
        flag: "--json",
        desc: "machine-readable result: {styles} when listing, {style, action} when pinning",
      },
    ],
    exit: [
      "0  the styles were listed, or DESIGN.md was written or is already current",
      "1  unknown style, a DESIGN.md that ForgeKit does not manage (it is left untouched), or a usage error",
    ],
    examples: ["forge taste", "forge taste editorial", "forge taste minimalist --json"],
  },
  atlas: "build / query the code-graph (where-is-Y, has-symbol)",
  stack: "detect this repo's real stack (languages, frameworks, test commands) from its manifests",
  radar:
    "dependency-currency rings — staleness/major-lag/advisories from live registry evidence, cached 24h",
  harness: {
    summary:
      "run host-neutral supervised tasks with policy, budgets, verification and replayable evidence",
    usage:
      "forge harness init|connect|trust|supervise on|off|routes|run|resume|show|replay|stats|audit|drift|approvals|memory|extensions|jobs|council",
    examples: [
      "forge harness init --hosts claude,codex,kimi,generic --supervised",
      "forge harness supervise off",
      'forge harness run "Fix the retry bug" --accept "Retry tests pass"',
      "forge harness jobs tick",
    ],
  },
  develop: {
    summary:
      "assemble a development plan, search prior solutions, assess security and select verification for the current change",
    usage: 'forge develop "<task>" [--web "<public search terms>"] [--verify] [--json]',
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
      'forge team "<task>" [--max-workers N] [--handoff <host> | --run kimi|codex --host-billing | --run claude --budget-usd N]',
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
  recall: "manage cross-session memory (list / add / consolidate)",
  catalog: "Start Here — list every tool, crew, and guard with a one-line why",
  scan: "vet a skill/MCP for injection/RCE/exfil before install (skill-gate)",
  vet: {
    summary:
      "vet a package before install (dep-gate) — is the name on its registry, is it listed malicious, how new and thin is it",
    usage: 'forge vet <ecosystem:name[@version]>… | --cmd "<install command>" [--json]',
    flags: [
      {
        flag: '--cmd "<command>"',
        desc: "vet every package an install command line would fetch (the PreToolUse guard's view)",
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
      "forge hooks [status | on | off | run <host> <event>] [--hosts a,b] [--bootstrap] [--json]",
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
      "forge hooks off",
    ],
  },
  verify:
    "independent verification gate — tests + hallucinated-symbol + provenance (--deep: multi-lens consensus)",
  demo: "scripted scenario — a throwaway repo goes green → broken → green while forge verify watches (the README hero, runnable)",
  precommit:
    "commit-level gate — staged code w/o docs + secret scan (FORGE_COMMIT_GATE=block|warn|0)",
  "test-select": {
    summary:
      "smart test selection — the tier contract as a command: which tests this change owes (selection only, never runs them)",
    usage: `forge test-select [--changed <a,b>] [--base <ref> --head <ref>] [--json]`,
    flags: [
      {
        flag: "--changed <a,b>",
        desc: "comma-separated changed files; default: the working tree (staged + unstaged + untracked)",
      },
      {
        flag: "--base <ref> --head <ref>",
        desc: "select for a ref range (git diff base...head) instead of the working tree",
      },
      { flag: "--json", desc: "machine-readable plan" },
    ],
    examples: [
      "forge test-select",
      "forge test-select --changed src/atlas.js",
      "forge test-select --json",
    ],
  },
  harden: "wire security controls — pre-commit gate (gitleaks + commit gate) + sandbox settings",
  remember: "add a durable fact to this repo's portable memory (forge brain)",
  brain: "show / rebuild the portable project memory index",
  cost: "real per-day spend via ccusage + measured stage factors (--stages)",
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
    summary:
      "each tier's model family resolved to a concrete model — newest in the provider's live catalog (else the shipped snapshot), with its price and where both came from",
    usage: "forge models [--json]",
    flags: [{ flag: "--json", desc: "machine-readable resolution (id, created, price, sources)" }],
    examples: ["forge models", "forge models --json"],
  },
  spec: "spec-as-contract — init (OpenSpec) / lock / check drift",
  cortex: "self-correcting project memory — status / why <symbol>",
  deja: {
    summary:
      "anti-repetition — have you done this task before? ranks prior solved and verified sessions from the ledger",
    usage: 'forge deja "<task you are about to start>" [--json]',
    strict: true,
    flags: [
      { flag: '"<task>"', desc: "the task you are about to start" },
      {
        flag: "--json",
        desc: "machine-readable list of the closest prior claims: id, kind, score, verified, day and gist",
      },
    ],
    exit: [
      "0  the ledger was searched, with or without a match",
      "1  no task given, or a usage error",
    ],
    examples: [
      'forge deja "add pagination to the orders endpoint"',
      'forge deja "retry on 429" --json',
    ],
  },
  ledger:
    "evidence-referenced memory — stats / verify / show / blame / query / compact / at / diff / root / ratify / retract / merge / sync / import",
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
    summary:
      "proof-carrying code cache — query a spec for verified code, mint code with its evidence, or show stats",
    usage:
      'forge reuse query "<what you are about to build>" [--json] | mint "<task the code solves>" --file <path> [--ref <test-run/commit>] [--json] | stats [--json]',
    strict: true,
    subcommands: ["query", "mint", "stats"],
    defaultSub: "stats",
    flags: [
      {
        flag: "--file <path>",
        for: ["mint"],
        desc: "the file that solves the task; its exports and dependency declarations are fingerprinted, so a later signature change invalidates it",
      },
      {
        flag: "--ref <test-run/commit>",
        for: ["mint"],
        desc: "the verification that backs it (a test run or commit); without one the artifact stays at the 0.5 prior and is not served",
      },
      {
        flag: "--json",
        desc: "machine-readable result: the tier and reasons for query, the minted claim for mint, the counters for stats",
      },
    ],
    exit: [
      "0  query ran (hit or miss), mint stored the artifact, or stats printed",
      "1  mint refused (for example a file that does not exist); or a usage error",
    ],
    examples: [
      'forge reuse query "parse an ISO-8601 duration"',
      'forge reuse mint "parse an ISO-8601 duration" --file src/duration.js --ref ci-run-4411',
      "forge reuse stats --json",
    ],
  },
  context: {
    summary:
      "budgeted context assembly + completeness gate — what an edit NEEDS known, delivered or owed",
    usage: 'forge context "<task>" [--budget <tokens>] [--block] [--json]',
    flags: [
      { flag: "--budget <tokens>", desc: "assembly budget (chars/3.6 estimate; default 6000)" },
      { flag: "--block", desc: "print the assembled context block itself (what gets delivered)" },
      { flag: "--json", desc: "machine-readable result (add --block to include the block)" },
    ],
    examples: ['forge context "update computeTax in src/tax.js" --block'],
  },
  preflight: "assumption check — what a task names that the repo doesn't define",
  config: "provider setup — show / switch / add providers, set default model",
  route: {
    summary:
      "recommend the cheapest capable model for a task (+ gateway config); `route universal`: any provider's models, lowest expected cost for the success asked for, learned from outcomes",
    usage:
      'forge route "<task>" [--mode conservative|unattended] [--read-only] [--allow-top] [--apply] [--provider <name>] [--json]   |   forge route gateway | calibrate | universal …',
    flags: [
      {
        flag: "--mode <conservative|unattended>",
        desc: "conservative (default) never raises the tier on a model's vote; unattended applies the vote raise, the writes-code and risk floors and the top-tier gate. Default from `route.mode` in the config (forge orchestration set route.mode …)",
      },
      {
        flag: "--read-only",
        desc: "unattended: the task only reads/explores, so it may stay on the cheapest tier (otherwise a code-writing task starts at mid)",
      },
      {
        flag: "--allow-top",
        desc: "unattended: allow the top tier — still only when the deterministic score reaches its cutoff, never from a vote (route.topTier: explicit)",
      },
      { flag: "--apply", desc: "write the recommended model into the active tool's settings" },
      { flag: "--provider <name>", desc: "switch the active provider first" },
      {
        flag: "--json",
        desc: "machine-readable: `key` is the generic tier key (haiku/sonnet/opus/fable); `policy` lists mode, steps, risk matches and the top-tier gate",
      },
    ],
    examples: [
      'forge route "fix a typo in the readme"',
      'forge route "add a refund endpoint" --mode unattended --json',
      'forge route "map the auth module" --mode unattended --read-only',
      "forge route gateway",
    ],
  },
  orchestration: {
    summary:
      "agent-orchestration rule pack (no polling, parallel cap, CI for heavy checks, fresh sub-agents, model routing, risk review, isolated envs, lean lead), the working-method pack (goal and means, evidence first, isolate, proof of done, fix without breaking) and the unattended routing policy — list, switch rules on/off, set routing mode/gates, per repo or --global",
    usage:
      "forge orchestration [list] [--json]   |   forge orchestration on|off <rule-id|all|pack|method> [--global]   |   forge orchestration set <key> <value> [--global]",
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
      "forge orchestration off method.smallest-cases",
      "forge orchestration off method",
      "forge orchestration set parallelCap 3",
      "forge orchestration set route.mode unattended --global",
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
      'forge impact <symbol|file> [--json] [--basic] [--all-relations] | forge impact --diff [--staged | --since <ref>] [--json] | forge impact --record [--command "<test command with {file}>"] [--jobs <n>] [--json]',
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
      {
        flag: "--record",
        desc: "run each test file under V8 coverage and save which functions it executes (.forge/runtime-map.json); later queries list the tests that run the target, including ones the import graph misses",
      },
      {
        flag: '--command "<cmd {file}>"',
        desc: "with --record: the per-file test command (default: the project's runner, e.g. node --test {file})",
      },
      { flag: "--jobs <n>", desc: "with --record: test files run at once (default 4)" },
    ],
    examples: [
      "forge impact --record",
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
    strict: true,
    flags: [
      {
        flag: "[<file>…]",
        desc: "check these files instead of the working diff",
      },
      {
        flag: "--json",
        desc: "machine-readable report: risk, the sessions found, and the files in play",
      },
    ],
    exit: ["0  always once the check ran: a collision is advice to coordinate, not a failure"],
    examples: ["forge collide", "forge collide src/auth.js --json"],
  },
  rank: {
    summary:
      "load-bearing code — PageRank centrality × past-incident history, circular-dependency clusters, chokepoint files",
    usage: 'forge rank [--top <n>] [--task "<terms>"] [--json]',
    strict: true,
    flags: [
      {
        flag: "--top <n>",
        int: { min: 1 },
        desc: "how many files and symbols to list (default 15)",
      },
      {
        flag: '--task "<terms>"',
        desc: "rank around a task: the symbols and files it names seed a personalised PageRank, so the list shows what that task leans on",
      },
      { flag: "--json", desc: "machine-readable full report" },
    ],
    exit: [
      "0  the report was computed",
      "1  no code atlas yet (run `forge atlas build`), or a usage error",
    ],
    examples: [
      "forge rank",
      "forge rank --top 5 --json",
      'forge rank --task "change verifyHandshake"',
    ],
  },
  substrate: "one pre-action gate: assumptions, route, impact, scope, memory, verify",
  scope: "decompose files into independent clusters (+ coupled files you didn't name)",
  anchor: {
    summary:
      "goal-drift check — are your actual (git) changes still on the stated goal? set/show/clear keep the goal across sessions",
    usage: 'forge anchor ["<goal>"] [--json] | forge anchor set "<goal>" | show | clear [--json]',
    strict: true,
    subcommands: ["set", "show", "clear"],
    flags: [
      {
        flag: '["<goal>"]',
        desc: "the goal to check the changes against; without it the goal stored by `anchor set` is used",
      },
      {
        flag: "--json",
        desc: "machine-readable result: the drift report, or {goal} for set and show, {cleared} for clear",
      },
    ],
    exit: [
      "0  the changes were checked, on goal or not (drift is advice); or the goal was set, shown or cleared",
      "1  no goal given and none stored; `set` refused (empty, or it looks like a secret); or a usage error",
    ],
    examples: [
      'forge anchor set "make the billing export resumable"',
      "forge anchor",
      'forge anchor "fix the login redirect" --json',
      "forge anchor clear",
    ],
  },
  handoff: "bounded session snapshot — rewrite .forge/state.md, re-injected each session start",
  decide: "append-only decision log — D-#### ADR-lite entries in .forge/decisions.md",
  know: {
    summary:
      "route any fact to its storage home (decision / ledger / recall / …) — total, never dropped; a checkable policy can be compiled into a commit check",
    usage:
      'forge know "<fact>" [--dry-run] [--json] | forge know --enforce "<rule>" [--warn] [--json] | forge know --rules [--json] | forge know --check [--json] | forge know --remove <id> [--json]',
    flags: [
      { flag: "--dry-run", desc: "show where the fact would go without writing it" },
      {
        flag: '--enforce "<rule>"',
        desc: 'compile a policy into a check `forge precommit` runs on every commit: a banned import ("never import moment"), a construct ("no console.log in src", "avoid default exports"), a quoted literal, or another package manager\'s lockfile ("use pnpm, not npm"); anything else is refused and stays memory',
      },
      { flag: "--warn", desc: "with --enforce: a violation warns instead of refusing the commit" },
      { flag: "--rules", desc: "list the enforced rules (.forge/rules.json)" },
      { flag: "--check", desc: "check the working changes against the enforced rules now" },
      { flag: "--remove <id>", desc: "drop an enforced rule" },
      { flag: "--json", desc: "machine-readable result" },
    ],
    examples: [
      'forge know "we picked Postgres over Mongo for transactions"',
      'forge know --enforce "never import moment"',
      'forge know --enforce "use pnpm, not npm"',
      "forge know --check",
    ],
  },
  diagnose: {
    summary:
      "doom-loop check — record a failure; the same signature three times mints a diagnosis and an escalation",
    usage:
      'forge diagnose "<error text>" [--file <path>] [--symbol <name>] [--task "<task>"] [--json]',
    strict: true,
    flags: [
      {
        flag: '"<error text>"',
        desc: "the failure as it was printed; numbers, paths and hex ids are normalised away before the signature is taken",
      },
      { flag: "--file <path>", desc: "the file the failure points at, part of the signature" },
      { flag: "--symbol <name>", desc: "the symbol the failure points at, part of the signature" },
      {
        flag: '--task "<task>"',
        desc: "the task this failure came from, the same text `forge route` was given; when a routing decision for it is on record, the escalation names that decision's tier",
      },
      {
        flag: "--json",
        desc: "machine-readable result: signature, count, thrash, and the escalation when there is one",
      },
    ],
    exit: [
      "0  the failure was recorded, whether or not it crossed the thrash threshold; stopping the retry loop is the agent's move",
      "1  no error text given, or a usage error",
    ],
    examples: [
      "forge diagnose \"TypeError: cannot read properties of undefined (reading 'id')\" --file src/user.js",
      'forge diagnose "$(npm test 2>&1 | tail -5)" --task "fix the flaky date test" --json',
    ],
  },
  imagine: {
    summary:
      "consequence simulation — predicted breaks and the smallest test suite for a task, optionally run in an isolated checkout",
    usage: 'forge imagine "<task>" [--run [--sandbox auto|required|off] [--allow-dirty]] [--json]',
    strict: true,
    flags: [
      {
        flag: '"<task>"',
        desc: "what you are about to change. Name the symbol (`pushCloud`) or file (`src/cloud_client.js`) it touches: a task that names neither has no targets, and nothing is predicted",
      },
      {
        flag: "--run",
        desc: "also run the selected tests in a detached git worktree of HEAD and report what they measured",
      },
      {
        flag: "--sandbox <auto|required|off>",
        values: ["auto", "required", "off"],
        requires: "--run",
        desc: "process confinement of the run: auto uses an installed sandbox runtime (srt) when present, required refuses to run without one, off never uses it (default auto)",
      },
      {
        flag: "--allow-dirty",
        requires: "--run",
        desc: "run even with uncommitted changes; the run still measures HEAD, so those changes are not in it",
      },
      {
        flag: "--json",
        desc: "machine-readable prediction; with --run it also carries dryRun with the measured counts and the isolation that applied",
      },
    ],
    exit: [
      "0  a prediction was made (including none, when the task names no known symbol or file); with --run, the suite ran and produced a verdict, passing or failing",
      "1  with --run: a dirty working tree without --allow-dirty, --sandbox required with no runtime, or a run that produced no verdict; or a usage error",
    ],
    examples: [
      'forge imagine "add a retry to pushCloud"',
      'forge imagine "rename parseConfig in src/config.js" --run',
      'forge imagine "change verifyHandshake" --run --sandbox required --json',
    ],
  },
  lean: {
    summary:
      "scope-minimality check — measure the working diff's footprint against what the task asked for",
    usage: 'forge lean "<task>" [--json]',
    strict: true,
    flags: [
      {
        flag: '"<task>"',
        desc: "the task as it was given; abstractions the diff adds that the task does not mention are reported as unrequested",
      },
      { flag: "--json", desc: "machine-readable footprint and warnings" },
    ],
    exit: [
      "0  the footprint was measured; warnings are advice and never fail the command",
      "1  no task given, or a usage error",
    ],
    examples: [
      'forge lean "fix the off-by-one in paginate"',
      'forge lean "add a --top flag" --json',
    ],
  },
  uicheck: {
    summary:
      "deterministic UI checks — contrast <fg> <bg> · fingerprint <file...> · design <file...> · visual <file-or-url> · interact <file-or-url>",
    usage:
      "forge uicheck contrast <fg> <bg> [--large] [--json] | fingerprint <file...> [--theme <file>]... [--mint] [--json] | design <file...> [--theme <file>]... [--taste <name>] [--json] | visual <file-or-url> [--taste <name>] [--remote] [--json] | interact <file-or-url> [--record] [--enforce] [--remote] [--json]",
    strict: true,
    subcommands: ["contrast", "fingerprint", "design", "visual", "interact"],
    defaultSub: "contrast",
    flags: [
      {
        flag: "--large",
        for: ["contrast"],
        desc: "grade against the large-text / UI-component bar (AA 3:1) instead of normal text (AA 4.5:1)",
      },
      {
        flag: "--theme <file>",
        for: ["fingerprint", "design"],
        multiple: true,
        desc: "the Tailwind theme source — a v4 @theme stylesheet or a tailwind.config — that resolves token utilities (rounded-card, shadow-lift, bg-brand); repeatable; replaces auto-discovery; a named file that does not exist is an error",
      },
      {
        flag: "--taste <name>",
        for: ["design", "visual"],
        desc: "gate thresholds and checks from a taste profile (default: the style pinned by a forge-taste DESIGN.md)",
      },
      {
        flag: "--mint",
        for: ["fingerprint"],
        desc: "store the vector as the project's design claim, the gate's reference point (refused when the vector is empty)",
      },
      {
        flag: "--remote",
        for: ["visual", "interact"],
        desc: "allow a non-loopback URL. Without it only files and localhost are opened, because fetching an arbitrary URL can leak data",
      },
      {
        flag: "--record",
        for: ["interact"],
        desc: "record the verdict as behavioural evidence for the completion gate",
      },
      {
        flag: "--enforce",
        for: ["interact"],
        desc: "make a failing interaction check exit 1 (also FORGE_ENFORCE=1); without it interact is advisory",
      },
      {
        flag: "--json",
        desc: "machine-readable result (contrast: ratio, level and the composited hexes compared; fingerprint: the feature vector; design and visual: verdict pass | fail | insufficient-signal; interact: the checks)",
      },
    ],
    env: [
      "FORGE_ENFORCE=1      interact: a failing check exits 1, as with --enforce",
      "FORGE_PLAYWRIGHT     visual/interact: path to an existing playwright-core install",
    ],
    exit: [
      "0  the check passed; visual or interact found no browser runtime (skipped, reported as such); interact failed without --enforce",
      "1  contrast below AA; design or visual verdict fail or insufficient-signal; --mint refused; interact failed with --enforce; a named --theme file missing; or a usage error",
    ],
    examples: [
      'forge uicheck contrast "#777" "#fff"',
      'forge uicheck contrast "oklch(0.55 0.1 250)" "#fff" --large --json',
      "forge uicheck design src/components/Card.tsx",
      "forge uicheck design src/components/*.tsx --theme src/app/globals.css",
      "forge uicheck interact http://localhost:3000 --enforce",
    ],
  },
  dash: {
    summary:
      "open a local project dashboard to inspect runs, check agent setup and review project memory",
    usage: "forge dash [--port <n>] [--json]",
    strict: true,
    flags: [
      {
        flag: "--port <n>",
        int: { min: 0, max: 65535 },
        desc: "listen on this port of 127.0.0.1 (default 4242); 0 picks any free port",
      },
      {
        flag: "--json",
        desc: "print one line, {url, port, root}, once the server is listening, so a script can find it; the write token is never printed",
      },
    ],
    exit: [
      "0  stopped with Ctrl+C or SIGTERM after serving; the server closes before the process exits",
      "1  the port is in use or not allowed, or a usage error",
    ],
    examples: ["forge dash", "forge dash --port 0 --json"],
  },
  report: {
    summary:
      "emit a static, self-contained HTML snapshot of .forge/ — opens offline, no server, no script",
    usage: "forge report [--out <path> [--force]] [--json]",
    strict: true,
    flags: [
      {
        flag: "--out <path>",
        desc: "write here instead of .forge/report.html. The directory must exist, and a file that is not a ForgeKit report is not overwritten",
      },
      {
        flag: "--force",
        requires: "--out",
        desc: "overwrite the --out file even though it is not a ForgeKit report",
      },
      { flag: "--json", desc: "machine-readable result: {path, bytes}, or {error} when refused" },
    ],
    exit: [
      "0  the report was written",
      "1  --out names a directory, a missing directory, or a file that is not a ForgeKit report (without --force); or a usage error",
    ],
    examples: [
      "forge report",
      "forge report --out ~/Desktop/forge-report.html",
      "forge report --json",
    ],
  },
  brand: "print the active brand token map",
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
      'forge integrations list [--json] | select [id] | connect <id> [--url URL] [--token-env NAME] | local <id> --binary PATH [--arg ARG] | register <descriptor.json> | unregister <id> | find "<task>" | install <id> | auto on <id>... | auto off|status | add <id> [--yes] | remove <id>',
    examples: [
      'forge integrations find "test a browser checkout flow"',
      "forge integrations install playwright",
      "forge integrations auto status",
    ],
  },
};

// Groups order the --help surface from the stable reliability loop down to experiments.
// "Labs" is the audit's P1-01 signal: those commands are experimental, not part of the
// core loop — grouped here so new users see the load-bearing beams first (nothing is
// removed; the full surface still ships). A command leaves Labs when it meets the
// production bar in docs/CLI-CONTRACTS.md: a strict, complete help entry with documented
// exit statuses, a versioned --json contract checked in CI (src/contracts.js), and tests
// of its failure cases.
export const GROUPS = {
  Core: [
    "init",
    "sync",
    "doctor",
    "tools",
    "catalog",
    "docs",
    "update",
    "config",
    "dash",
    "report",
  ],
  Substrate: [
    "substrate",
    "preflight",
    "evidence",
    "team",
    "develop",
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
    "imagine",
    "lean",
    "anchor",
    "diagnose",
    "collide",
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
    "deja",
    "reuse",
  ],
  Quality: ["scan", "vet", "spec", "harden", "radar", "hooks", "uicheck", "rank"],
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
    "taste",
  ],
  Sync: ["cloud", "relay"],
  // Every Labs command met the production bar on 2026-11-27. A new experimental command
  // goes back into a "Labs (experimental)" group here until it meets the bar too.
};

/**
 * What bare `forge --help` shows a new user: the eight commands of the everyday loop (set up,
 * remember, check impact, verify, guard installs and commits), each with a plain one-line why
 * instead of its full summary. `forge --help --all` prints every group above. Two reviews of
 * 1.20.0 found 61 commands on one screen too many to find a first step in; this list is that
 * first step, and nothing outside it is removed or hidden.
 * @type {{name: string, why: string}[]}
 */
export const START_HERE = [
  { name: "init", why: "set up ForgeKit for the coding agents this repo uses" },
  { name: "doctor", why: "check that hooks, providers and MCP wiring work (--fix repairs)" },
  { name: "sync", why: "rewrite every agent's config after you edit the shared rules" },
  { name: "remember", why: "save a fact for every agent (run sync to deliver it)" },
  { name: "impact", why: "list the files an edit to a symbol will probably touch" },
  { name: "verify", why: "run the repo's tests and report PASS, FAIL or INCOMPLETE" },
  { name: "precommit", why: "stop a commit that leaks a secret or changes code without docs" },
  { name: "vet", why: "check a package is real and not known malicious before installing" },
];

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
 * @returns {{summary:string, usage:string, flags:FlagEntry[], examples:string[], env:string[],
 *   exit:string[], strict:boolean, subcommands:string[], defaultSub:string|null}|null}
 *   null for an unknown command
 */
export function commandHelp(name) {
  const e = COMMANDS[name];
  if (!e) return null;
  if (typeof e === "string")
    return {
      summary: e,
      usage: "",
      flags: [],
      examples: [],
      env: [],
      exit: [],
      strict: false,
      subcommands: [],
      defaultSub: null,
    };
  return {
    summary: e.summary ?? "",
    usage: e.usage ?? "",
    flags: Array.isArray(e.flags) ? e.flags : [],
    examples: Array.isArray(e.examples) ? e.examples : [],
    env: Array.isArray(e.env) ? e.env : [],
    // A strict command has every flag it reads listed above, so src/cli/args.js refuses any
    // other; `exit` documents its exit statuses; `subcommands` and `defaultSub` let a flag
    // name the forms it applies to (`for`).
    exit: Array.isArray(e.exit) ? e.exit : [],
    strict: e.strict === true,
    subcommands: Array.isArray(e.subcommands) ? e.subcommands : [],
    defaultSub: e.defaultSub ?? null,
  };
}
