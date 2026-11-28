# ForgeKit in depth

The README is the short path: install, the eight commands to start with, and what ForgeKit
catches. This page is everything else it used to hold: the status notes, every setup option,
orchestration, advisor pairing, team memory, retrieval, supervised runs, MCP tools and the
full list of limits. Measurements, refutations and the research prototypes are in
[EVIDENCE.md](EVIDENCE.md). Every command, with worked examples, is in [GUIDE.md](GUIDE.md).

## Contents

- [Status](#status)
- [The three jobs](#the-three-jobs)
- [Beyond the quickstart](#beyond-the-quickstart)
- [Why Forgekit exists](#why-forgekit-exists)
- [What you get](#what-you-get)
- [Core capabilities](#core-capabilities)
- [Agent orchestration](#agent-orchestration)
- [Advisor pairing](#advisor-pairing)
- [Setup details](#setup-details)
- [Team memory](#team-memory)
- [LLMs, retrieval, and embeddings](#llms-retrieval-and-embeddings)
- [Run a supervised coding task](#run-a-supervised-coding-task)
- [Agent roles and MCP tools](#agent-roles-and-mcp-tools)
- [Honest limits](#honest-limits)
- [Public site](#public-site)
- [Documentation](#documentation)

## Status

> **Status: beta — read before you rely on it.**
>
> - Releases follow Semantic Versioning ([CHANGELOG](../CHANGELOG.md),
>   [release notes](RELEASING.md)): since 1.0.0 a breaking change ships as a new major
>   version. "Beta" describes maturity, not interface churn — the analyses are heuristic, the
>   checks are advisory unless you enable enforcement, and most integrations have less real-world
>   exercise than Claude Code. The core (`init`, `sync`, `substrate`, `impact`, `ledger`, guards)
>   is tested and in daily use. The commands listed in [command contracts](CLI-CONTRACTS.md)
>   refuse flags their help does not list, and their JSON forms have a versioned output
>   contract checked in CI; other commands' JSON is not yet frozen.
> - **Claude Code 2.1.325** invoked the supervised run and status tools on a normal prompt and received a signed suite receipt. Its pre-tool hook denied a direct Bash write. [Claude acceptance workflow](../.github/workflows/native-claude-harness.yml)
>   In a trusted workspace, the first model request from Codex CLI 0.169.0 included a source
>   excerpt and routing instructions. Kimi Code 2.6.2 discovered and called the supervised MCP
>   tool on an ordinary prompt, then received a signed test receipt. Both clients blocked a direct
>   shell write. These runs used real clients, synthetic workspaces and loopback model responses.
>   [Codex run](https://github.com/CodeWithJuber/forgekit/actions/runs/43589328444/job/132430512728) · [Kimi run](https://github.com/CodeWithJuber/forgekit/actions/runs/43589328450/job/132430513107) · [Host coverage](INTEGRATIONS.md)
>   On OpenClaw specifically, rules arrive via `AGENTS.md` project context; the config-only
>   path uses a one-command MCP registration, while installing the package as a compatible
>   Codex bundle loads its skills and bundle-scoped MCP server. Neither path provides ambient
>   hooks (see
>   [OpenClaw in ARCHITECTURE](../ARCHITECTURE.md#openclaw-what-is-automatic-and-what-is-not)).
> - **Impact/blast-radius analysis is heuristic** — a regex-approximate code graph, not a sound
>   call graph. It is not conservative: it can miss affected files as well as flag unaffected
>   ones, so treat its output as advisory and an empty result as "unknown", not "safe".
> - **"Proof-carrying memory" is a name, not a formal proof.** Claims are content-addressed and
>   carry evidence references; confidence moves only when independent oracles (tests, CI, a
>   human) raise it. There is no theorem-prover in the loop.
> - Some integrations shell out — `forge harden`, `forge scan`, and the git-native ledger
>   assume **Bash and Git** are available (`jq` is not required — the guards read hook JSON
>   with node). Claude hooks on Windows do
>   not require `bash` on `PATH`: their Node launcher finds Git Bash and preserves guard exits.
>   `protect-paths` needs no bash at all and fails closed: when it cannot reach a verdict, the
>   tool call is blocked rather than let through.
> - Guardrails reduce risk; they are not a security sandbox. What each integration actually does —
>   config emission, MCP registration, automatic hooks, blocking — is in
>   [docs/INTEGRATIONS.md](INTEGRATIONS.md).

## The three jobs

It does three jobs:

1. **Share reliable project knowledge.** Lessons, facts and decisions live in the repository as
   *evidence-referenced memory*: each claim carries references to its evidence, only tests, CI or
   a person raise its confidence, and teammates merge it over plain git.
2. **Inspect likely change impact.** Before an edit, a *heuristic* impact analysis lists the files
   the change probably touches, including coupled files you did not name. It reads a
   regex-derived code graph, so it can miss files as well as over-warn.
3. **Verify the current change.** `forge verify` runs the repository's detected test suites and
   reports `PASS`, `FAIL`, `INCOMPLETE` or `NOT_CONFIGURED` for the code state it ran on. A run that
   covers only part of the repository is *partial* verification, and says so.

## Beyond the quickstart

Open the local project dashboard from the same directory:

```bash
forge dash
```

Open the printed loopback URL. Choose **Coding hosts** to check setup. With a trusted harness and a model route running, choose **New run** to submit a task and **Runs** to inspect its outcome. [Dashboard guide](GUIDE.md#project-dashboard)

Then run a pre-action check inside a repository:

```bash
forge substrate "Change verifyToken in src/auth.js to require length > 20; update tests"
```

The result includes an assumption verdict, a model-tier recommendation, predicted impact,
a context-coverage check (what was delivered, not a proof that it suffices), scope clusters, and
a verification checklist. On Claude Code, the
pre-action check can run automatically through a `UserPromptSubmit` hook; Codex, Gemini CLI,
Cursor and Copilot run it the same way once a repository opts in with `forge hooks on`. On other
supported tools, Forgekit emits instructions and MCP configuration that the tool can invoke.

The three jobs, one command each:

```bash
forge ledger query "token validation"   # 1. what does the team already know about this area?
forge impact verifyToken                 # 2. which files will this edit probably touch?
forge verify                             # 3. did the change pass the suites that actually ran?
```

### Automatic evidence for coding agents

For Kimi Code, `KIMI_CODE_HOME` selects the user profile where the native plugin is enabled. The project MCP connections live in `.kimi-code/mcp.json`. For Codex, enable the repository’s hooks in a trusted session. OpenCode loads the generated `.opencode/plugins/forgekit.js` on its next session; set `FORGE_CLI` when `forge` is not the command on `PATH`.

Choose the agents your project uses. For example, `forge init --tools claude,codex,kimi` prepares these three clients. Run `forge integrations` to browse packages and remote servers, or `forge integrations select` for the interactive picker. Select each integration separately. Use `forge integrations connect <id> --url <endpoint>` for a hosted or self-managed MCP server and `forge integrations register <descriptor.json>` for a custom npm tool. `forge integrations list --json` shows the recorded selection and `forge integrations remove <id>` disconnects it from the project. Read the [implementation and host setup guide](V2-IMPLEMENTATION.md) for per-host activation, portable agents and command examples.

Use `forge develop "<task>"` to inspect the development plan and research evidence. Use `forge develop "<task>" --verify` to run the project checks for the current tree.

In a project, run `forge hooks on --hosts claude,codex` to install the project hooks for those hosts. A supported, trusted hook retrieves relevant code locations and source excerpts on a coding prompt or tool failure. OpenCode has no shell hooks, so forge writes a small JavaScript plugin instead; it calls the same `forge hooks run opencode <event>` entry point and is a no-op when the CLI is absent. Set `FORGE_CLI` to point at a non-standard forge binary. To add private sources, run `forge sources init`, edit the configuration file it prints, then run `forge sources sync`. The cache stays in your user state directory.

Run `forge evidence "investigate retry timeouts"` to inspect the same evidence directly. For an unfamiliar capability, `forge integrations find "<task>"` looks for a suitable community tool. `forge team "<task>"` shows whether independent specialist work is warranted. The [setup and research guide](AGENT-EVIDENCE.md) covers supported hosts, local PDFs and spreadsheets, public research, and Jira, Confluence and GitLab on cloud and self-hosted deployments.

`forge discover find "<task>"` searches for task-fit skills, plugins, tools and hooks, with source links, fit reasons and setup guidance. Automatic public research is opt-in. Configure Jev decisions across repositories with `forge discover setup --global --decisions on`; add `--search serper` for Google or `--search brave` for Brave. [Keys, preferences and automatic recommendations](DISCOVERY.md)

## Why Forgekit exists

The pain it kills — and the mechanism that kills it:

- **You fixed this bug last month. The agent just re-introduced it.** Lessons die when a
  session compacts. Forgekit stores them in the repository as evidence-referenced memory: only
  tests, CI, or a human raise a claim's confidence, and wrong lessons decay out instead of
  ossifying. `forge ledger query "token validation"` finds what the team already knows —
  teammates get it by pulling. (Memory persists outside the model; it doesn't guarantee the
  agent reads it — retrieval is budget-bounded, and missing context becomes a question, not
  invented context.)
- **The "safe" rename broke twelve files you never opened.** `forge impact <symbol>` shows
  the predicted blast radius before you edit, including coupled files you never named. It is
  heuristic — a regex-derived graph, not a sound call graph — so treat the output as advisory
  and an empty result as "unknown", not "safe".
- **"Done" with no test evidence.** A completion gate blocks a session's "done" when code
  moved without test evidence or a doc/state artifact — and hands back the repair checklist
  (`forge docs sync` sweeps the diff for stale prose, `forge handoff` writes the bounded
  session snapshot, `forge decide` records choices so no session re-decides them). On Claude
  Code this runs automatically.
- **A dependency that does not exist.** An agent that invents a package name is the
  slopsquatting attack surface. The dep-gate guard reads install commands, manifest edits and
  installs that read a manifest, across nine ecosystems (npm, PyPI, crates.io, Go, Maven,
  NuGet, RubyGems, Packagist, pub.dev), and blocks a name that is not on its own registry or
  that OSV lists as malicious; a brand-new, thin package asks you first. It fails open — an
  unreachable registry never blocks an install — and `forge vet` runs the same check by hand.
- **Rules that die at context compaction.** Guardrails — protected paths, cost budget,
  doom-loop detection, dependency vetting, secret redaction — run as deterministic hooks, not
  prose in a prompt.
  They survive compaction the way `CLAUDE.md` does not. `forge init` wires them into Claude
  Code on your machine; `forge hooks on` writes the same wiring into the repository for Claude
  Code, Codex, Gemini CLI, Cursor and Copilot, so a teammate's agent, CI and cloud agents run
  the guards too — without the model having to choose to. (The substrate is advisory by
  default; set `FORGE_ENFORCE=1` to block only its strongest signals.)
- **One rulebook, eleven tools.** Author your rules once; Forge emits each tool's native config,
  plus MCP for Roo and VS Code. Zero runtime dependencies — one Node CLI, plain files in git,
  no server to run.

## What you get

The day-to-day value first — what the substrate keeps outside the model, so it survives between sessions and tools:

- **Memory that persists across sessions and teammates.** _[Implemented]_ Every lesson, fact,
  and verified reuse is _proof-carrying memory (PCM)_ — our name for **evidence-referenced,
  content-addressed memory**: a claim that carries references to its own evidence and is only
  trusted once independent oracles raise its confidence above a floor (the "proof" is that
  evidence trail, not a formal proof). Wrong lessons decay out instead of ossifying.
- **Heuristic impact before you break things.** _[Heuristic]_ Ask "what does changing `verifyToken`
  break?" and get the _blast radius_ — the set of files an edit is predicted to impact, read
  from a regex-approximate code graph (not sound, and it can miss affected files), including
  coupled files you never named.
- **Guardrails that can't be forgotten.** _[Implemented on Claude Code]_ Deterministic hooks
  check the rules a model shouldn't break (protected paths, cost budget, doom loops) — they
  survive a context compaction the way `CLAUDE.md` prose does not. They reduce risk as
  defence in depth; they are not a sandbox. Commands are normalized the way the shell reads
  them before they are judged, so quoting, variables and inline programs no longer hide a
  delete or a secret read, but a program the guard cannot evaluate still can.
- **Work that finishes end to end.** A completion gate blocks "done" once per session when
  code moved without test evidence or a doc/state artifact (a UI-only change — styling,
  class strings, JSX text — owes a design record or a UI check instead of a unit test, and
  in a shared checkout a file another agent's session trail claims is named, not weighed;
  anything no trail accounts for still counts) — with the repair checklist as the answer
  (`forge docs sync` sweeps the diff for stale prose, `forge handoff` writes the bounded
  session snapshot the next session resumes from, `forge decide` records choices so no
  session re-decides them).
- **One config for 11 tools.** Author your rules once; Forge emits each tool's native config,
  plus MCP for Roo and VS Code. Zero runtime dependencies — one Node CLI, plain files in git,
  no server.

The substrate is advisory by default. Set `FORGE_ENFORCE=1` to block only its strongest
signals: a vacuous task, required context that cannot be assembled, or a large impact set
from a fresh repository graph.

## Core capabilities

- **Evidence-weighted memory.** Claims are content-addressed, keep provenance and outcome
  references, and earn or lose confidence through a closed set of oracles. Time decay moves
  unreviewed knowledge toward uncertainty rather than silently treating it as permanent fact.
- **Git-native team merge.** Claims and append-only logs merge by set union. The join is
  property-tested for commutativity, associativity, and idempotence.
- **Heuristic impact prediction.** Forgekit builds a regex-derived code graph and walks
  reverse dependencies to estimate affected files and tests; the pre-action check and the
  Stop gate's repair checklist also walk the empirical refutation's sibling and forward
  relations and tag each file with the relation that reached it. It is not conservative: it
  can miss affected files (including constructs its parser does not recognize) as well as
  produce false positives, and the sibling/forward files are lower-precision co-change
  candidates.
- **Budgeted context assembly.** Definitions, direct dependants, sibling tests, and trusted
  lessons are selected under a token budget. Missing required context becomes a question
  rather than invented context. Coverage is syntactic — delivered, not proven sufficient — token
  counts are estimates, a file that only fits as a "read this" pointer stays a pending read,
  and a definition counts as delivered only when its whole body is.
- **Model-tier recommendation.** A deterministic rubric combines task text and repository
  signals. An optional LLM proposal can only lower the tier, confidence-gated and bounded; a
  vote for a higher tier is never applied automatically — it is recorded as an advisory
  `escalateTo` recommendation, which names the tier only once an external check has actually
  failed (the doom-loop diagnosis at its thrash threshold). Forgekit advises which tier to
  request; it does not itself proxy or fail over model traffic. The opt-in cross-provider router
  (`route universal`) minimises **expected routing cost** for a success target; its budgets are
  expectations, not spend caps, and its benchmark headline is repository-reported. Its shipped
  prior refits exactly from pinned public data in this repository, and a new in-repo held-out
  replay finds it no better than a fixed cascade chosen on the same dev tasks
  ([docs/UNIVERSAL_ROUTING.md](UNIVERSAL_ROUTING.md)). For agents nobody watches,
  `--mode unattended` adds a confidence-gated vote raise, a writes-code floor, a risk floor and
  a gate on the top tier ([Agent orchestration](#agent-orchestration)).
- **Proof-gated reuse.** Cached code is served only after evidence clears a confidence floor
  and declared dependencies still resolve in the current repository graph.
- **Lifecycle guardrails.** Hooks cover prompt preflight, protected paths, cost budget,
  dependency vetting, repeated failures, format-on-edit, secret redaction, completion checks,
  and session learning — in Claude Code, and in Codex, Gemini CLI, Cursor and Copilot after
  `forge hooks on`. These controls reduce risk; they do not create a secure execution boundary.
- **Verification, partial or full.** `forge verify` runs the repository's detected test
  suites, reports `PASS`, `FAIL`, `INCOMPLETE`, or `NOT_CONFIGURED`, checks unknown symbols,
  and binds provenance to the code state it ran on. A verdict covers only the suites that ran:
  partial coverage is `INCOMPLETE`, not `PASS`. `--deep` adds structural, security, spec-drift,
  impact, and optional model-review lenses.

## Agent orchestration

A lead agent running several sub-agents mostly pays for context re-reads, not new work. In one
measured session, 7 parallel agents on one shared e2e environment used ~857M tokens in ~4.5 h,
~98% of them cache re-reads: agents polled logs every ~10 minutes against a 250–300k-token
context, more agents ran than the environment could serve, and the top model tier was
hand-picked for routine work (~140M tokens).

`forge sync` now emits an **orchestration rule pack** into every tool's config: no polling,
a parallel-agent cap (default 2), heavy suites in CI, fresh small sub-agents with short reports,
model choice via `forge route`, tests plus lead review for money/auth/secrets/migrations/security
changes, isolated e2e environments, and a lean lead. Each rule has a stable id
(`orch.no-polling`, …) and can be switched per repo or globally:

```bash
forge orchestration                        # rules, routing settings, and where each value came from
forge orchestration off orch.parallel-cap  # this repo; add --global for every repo
forge orchestration set route.mode unattended
forge route "add a refund endpoint" --mode unattended --json   # tier key + policy steps
```

In `unattended` mode, `forge route` raises the tier on a confident proposer vote, starts
code-writing tasks at mid, keeps risky tasks on the premium tier, and allows the top tier only
with `--allow-top` and a top deterministic score. The default `conservative` mode is unchanged.
Details, defaults and the evidence: [docs/ORCHESTRATION.md](ORCHESTRATION.md).

## Advisor pairing

Claude Code's [advisor tool](https://code.claude.com/docs/en/advisor) lets the main model consult a
second, typically stronger model at decision points: before committing to an approach, when an
error keeps recurring, and before declaring a task done. The advisor reads the whole conversation
and is billed at its own rate per call, and Claude Code accepts it only when it ranks at or above
the session's main model. `forge advisor` configures it once, per repo or globally, emits it into
Claude Code's settings, and checks the pairing before Claude Code has to refuse it:

```bash
forge advisor set opus                     # this repo: .forge/forge.config.json → .claude/settings.json + an Advisor section in AGENTS.md
forge advisor set fable --global           # every repo: the user-level config → ~/.claude/settings.json (what /advisor saves to)
forge advisor check sonnet opus            # ok — exit 1 when the pairing would be refused (for scripts and CI)
forge advisor pairings claude-opus-5-5     # which advisors this main model accepts, and the suggested one
forge advisor off                          # remove advisorModel again
```

The **Advisor** section tells every agent that reads `AGENTS.md` when to consult it (approach,
recurring error, done check, risky code), when not to (short, well-specified tasks), and that the
evidence wins over its guidance; each rule has a stable id (`advisor.before-approach`, …) and can
be switched with `forge advisor rule off <id>`. The prompt-time advisory adds one line at a
decision point, the doom-loop advisory names the advisor when a failure recurs, and `forge doctor`
reports the pairing and the environment variables that keep the advisor off
(`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, `DISABLE_TELEMETRY`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). The pairing table ships as data
(`source/advisor.json`, with the date it was verified against the docs); a model newer than it is
accepted with a note, since Claude Code validates the pairing at launch.

## Setup details

Install using one path:

| Use case | Command |
| --- | --- |
| Claude Code 2.1.275 or later, one step | `/plugin install forgekit --marketplace CodeWithJuber/forgekit` |
| Claude Code or another plugin-capable supported host | `/plugin marketplace add CodeWithJuber/forgekit` then `/plugin install forgekit` |
| Global CLI from npm | `npm install -g @codewithjuber/forgekit` |
| Directly from GitHub | `npm install -g github:CodeWithJuber/forgekit` |
| Contributor checkout | `git clone https://github.com/CodeWithJuber/forgekit.git && cd forgekit && npm link` |

The plugin runs its guards and its `forge-cortex` MCP server from the plugin directory, so
it needs only `node` on `PATH`. It does not put the `forge` command on your shell's `PATH`;
to run the `forge` commands below yourself, also install the npm package.

Initialize inside a project:

```bash
forge init
forge doctor
forge doctor --fix
```

When Claude Code is selected, `forge init` can merge Forgekit hooks and permissions into
`~/.claude/settings.json`. That file is global and affects all repositories. Use
`forge init --no-settings` to skip the merge or `forge init --remove-settings` to reverse
Forgekit-managed entries. The implementation preserves unrelated entries and creates a
timestamped backup before changing the file. When the Forgekit Claude Code plugin is enabled
(in user, project or local settings), its `hooks/hooks.json` already runs every guard, so
`forge init` and `forge doctor --fix` merge permissions only and never register the guards a
second time.

`forge init` detects agent tools from files such as `.cursor/`, `.codex/` and
`.github/copilot-instructions.md`. A repository with no tool markers starts with Claude Code.
Choose explicitly with
`forge init --tools claude,cursor` or `--tools all`; the choice is recorded in
`.forge/forge.config.json`, so later `forge sync` runs emit the same set. In `AGENTS.md`,
Forgekit owns only the block between `<!-- forge:begin -->` and `<!-- forge:end -->`. A
hand-written `AGENTS.md` keeps every line when `forge sync` appends the block.
The Stop hook refreshes the block only with readable project settings. Keep the selected profile in Git for disposable runners. [Project memory on disposable runners](GUIDE.md#project-memory-on-disposable-runners)

For an explicit model provider, inspect or update configuration with `forge config`. API keys
remain environment variables; Forgekit's provider file stores the environment-variable name,
not the secret value.

Terminal output is plain when piped. On an interactive terminal it can use color and confidence
meters; `NO_COLOR` disables color and `FORCE_COLOR=1` enables it explicitly.

## Team memory

Lessons, durable facts, and verified reuse artifacts land as content-addressed claims under
`.forge/ledger/`:

```bash
forge init

# Work normally; hooks and explicit memory commands add claims and evidence.
git pull
forge ledger merge <path-to-another-ledger>
forge ledger sync
```

Identical claim content converges to one identifier while provenance records preserve authors.
`forge ledger blame <id>` shows the mint history, oracle outcomes, and derived trust. The default
storage is files in git, not a hosted database or synchronization service.

With no flags, `forge ledger sync` serializes ledger state under `refs/forge/ledger` on the
repository's git remote. A non-fast-forward race triggers a re-merge and bounded retry. A shared
directory can be selected with `--dir <path>` or `FORGE_SYNC_DIR`; `--personal` includes the
per-user ledger.

## LLMs, retrieval, and embeddings

### Direct LLM adapters

`src/llm.js` supports two wire formats:

- Anthropic Messages API;
- OpenAI-compatible chat completions, used for OpenAI, Gemini, OpenRouter, and LiteLLM.

The direct adapter reads credentials from environment variables and sends a bounded single-prompt
request. The supervised executor has a separate Chat Completions client for iterative tool calls.
Its route, limits and verification contract come from the project's harness controls. [Harness setup](HARNESS.md)

### Repository and document retrieval

ForgeKit retrieves code definitions and ledger evidence locally. A configured source mirror can
also return cited rows, pages and issue records from selected folders, Jira projects, Confluence
spaces and GitLab projects. Source credentials, caches and freshness limits belong to the
operator. Use `forge sources sync` to refresh the configured sources and `forge sources aggregate`
for exact spreadsheet totals. [Source configuration, formats and routing](AGENT-EVIDENCE.md)

### Optional embeddings

MinHash remains the zero-dependency default. To opt into semantic similarity, configure an
external provider with one of the formats the current implementation accepts:

```bash
# OpenAI-compatible embedding endpoint
export FORGE_EMBED="https://api.example.com/v1/embeddings"
export FORGE_EMBED_MODEL="your-embedding-model"
export FORGE_EMBED_KEY="your-provider-key"

# Or a local/external command that implements Forgekit's stdin/stdout vector protocol
export FORGE_EMBED="cmd:./my-embedding-provider"
```

Vectors are cached in `.forge/embed-cache.jsonl`. Provider failure, timeout, malformed output,
or missing vectors falls back to MinHash. The repository test uses a deterministic fake
provider; it verifies adapter and fallback behavior, not live performance of a hosted model.

The performance snapshot in [`reports/benchmarks.md`](../reports/benchmarks.md) was generated at
commit `eb68ea9` and does not measure the optional embedding path. Current
embedding behavior is defined by [`src/embed.js`](../src/embed.js) and
[`test/embed.test.js`](../test/embed.test.js).

## Run a supervised coding task

From a fresh project checkout, use Node 20+ and Python with SQLite FTS5 support. Python 3.11+
also supports the Codex TOML configuration check.

```bash
forge harness init --hosts claude,codex,kimi --supervised
forge harness status
forge harness drift --hosts claude,codex,kimi
```

In Claude Code, trust the checkout and enable the project’s `forge-cortex` MCP server if prompted. In local Codex, review the project hooks in `/hooks`. In Kimi, trust the workspace, run the printed `/plugins install …` command and then `/reload`. OpenCode loads `.opencode/plugins/forgekit.js` on the next session. Select just the hosts you use. For another stdio MCP client, choose `--hosts generic` and copy the printed server settings into that client.

Start the configured model endpoint. The default is a local Chat Completions server at
`http://127.0.0.1:11434/v1` serving `qwen2.5-coder:7b`. In a project with a trusted test suite,
`forge verify` can issue a receipt for the current tree. To verify edits during a run, configure
a pinned container verifier. A rootless container runtime may require `XDG_RUNTIME_DIR`.
For a custom model endpoint, copy the fingerprint from `forge harness routes` into
`FORGE_HARNESS_TRUSTED_ROUTES`. A run returns its ID, verdict, usage and evidence. [First run, approvals and verification](HARNESS.md)

## Agent roles and MCP tools

Use `forge prompts show reviewer` to print a portable role brief, or `forge team "<task>" --handoff kimi` to prepare evidence for an independent reviewer. Twelve role briefs cover planning, research, coding, debugging, review, security, testing, memory, mediation, impact mapping, compatibility review and coordination. The Claude Code plugin also registers five native role definitions:

- `scout` — read-only repository investigation;
- `verifier` — fresh-context correctness review;
- `independent-reviewer` — diff/spec/test-only merge gate;
- `frontend-verifier` — visual and accessibility review;
- `doc-sync` — documentation consistency after code changes.

For an independent task, the team runner can launch a Kimi or Codex client with a supplied brief.
The lead applies changes and verifies the result. See the [worker options and billing](V2-IMPLEMENTATION.md).

In ordinary projects the built-in MCP server advertises 36 tools through `tools/list`, including:

- pre-action checks: `substrate_check`, `preflight_check`, `assumption_gate`, `route_task`,
  `dep_check`;
- repository analysis: `predict_impact`, `scope_files`, `rank_code`, `collide_check`;
- memory: `cortex_lessons`, `forge_remember`, `forge_ledger_query`,
  `forge_ledger_ratify`, `forge_ledger_retract`;
- operations: `forge_doctor`, `forge_provider_status`, `forge_cost`, dashboard data.

In a trusted supervised project the MCP server exposes only `forge_harness_run` and
`forge_harness_status`. The client can start a task and inspect its outcome. ForgeKit applies
the project policy and verifier to tool calls made inside that run.

## Honest limits

- **Beta software.** The CLI is released, CI-tested and semantically versioned (a breaking
  change is a major version); "beta" is about maturity and evidence, not about interface churn.
  Support is maintainer-led and best-effort; there is no SLA. [STABILITY.md](STABILITY.md) lists
  what is frozen today (14 of 64 commands have a versioned contract), the deprecation policy and
  the evidence that would end the beta label.
- **Claude Code is the deepest-tested integration.** Other emitters and MCP configuration are
  implemented, but the repository does not provide equivalent real-world exercise evidence for
  every supported host.
- **The code graph is heuristic.** Regex extraction is not a sound call graph and can both
  over-predict and miss dependencies: against a mutation oracle on this repository it named 53 of
  132 breaking test files. `forge impact --record` adds runtime evidence (the tests that executed
  the code), which named all 132, but it covers only JavaScript and TypeScript run by Node and only
  code some test runs.
- **Routing and costs.** `forge route` recommends a model tier. A supervised run uses its configured
  endpoint and enforces run and project budgets using the operator's prices. The Python routing
  study's 62.1% saving failed to reproduce on held-out tasks. [Evaluation](EVIDENCE.md#measured-evidence)
- **Memory is external state, not model training.** Claims live in files and are retrieved into
  context; Forgekit does not update model weights. It supplies persistence and external checks
  that a model does not guarantee on its own — one tested way to do that, not the only one.
- **Embeddings are an adapter, not an included model or vector store.** A user supplies the
  external command or HTTP service. MinHash remains the default and fallback.
- **Guardrails are defence in depth.** Commands are normalized before they are judged (quotes,
  variables, substitutions, inline programs); on a 25-command held-out bypass set the guard
  blocked 23 at first measurement, against 4 before. It is static analysis: a program it cannot
  evaluate can still get past it, and post-tool redaction
  runs after the external tool has executed. Forgekit is not a sandbox.
- **Human ratification is a workflow convention.** Ratify and retract operations record the git
  author, but this repository does not authenticate a human or enforce enterprise approval roles.
- **Evaluations are deliberately scoped.** The JavaScript impact set has six hand-labelled cases;
  the Python router set has 30 hand-labelled tasks tuned to its rubric; the Python impact study has
  five mutations. None is a production field study.
- **Deployment scope.** Source mirrors and harness state live under the operator's account.
  Teams supply their identity controls, model service, tenant credentials and production monitoring.

## Public site

Forgekit includes a hand-authored landing page at [`landing/index.html`](../landing/index.html) and
generates a status page at `public/index.html`. The generator reads
repository data from `package.json`, `README.md`, `CHANGELOG.md`, and the benchmark report.

```bash
npm run pages:build
BUILD_PAGES_LIVE=1 npm run pages:build
```

The default build is offline and deterministic. Optional live mode reads public GitHub repository
metadata with bounded retries and caching. GitHub Pages deployment is defined in
[`.github/workflows/static.yml`](../.github/workflows/static.yml); this static documentation site is
not an AI application deployment.

## Documentation

| Document | Contents |
| --- | --- |
| [`ONBOARDING.md`](../ONBOARDING.md) | Five-minute setup and design principles |
| [`docs/GUIDE.md`](GUIDE.md) | Full command reference, worked examples, MCP schemas, and honest limits |
| [`docs/HARNESS.md`](HARNESS.md) | Supervised tasks, model routes, verification, approvals, workers and recovery |
| [`docs/AGENT-EVIDENCE.md`](AGENT-EVIDENCE.md) | Source configuration, local documents, hosted and self-managed services, public search and reuse |
| [`examples/`](../examples/) | Runnable pain-point solution demos (cost governance, adversarial doctor) — each with copy-paste steps, a demo script, and a GIF |
| [`docs/INTEGRATIONS.md`](INTEGRATIONS.md) | Per-tool behaviour: config emission, MCP registration, automatic hooks, blocking — and how each is tested |
| [`docs/UNIVERSAL_ROUTING.md`](UNIVERSAL_ROUTING.md) | The cross-provider router: model, shipped prior, evidence status and modeling limits |
| [`docs/MATH-CORE.md`](MATH-CORE.md) | Decision mathematics not yet wired into commands: anytime-valid evidence bounds, exact cascade order, the replay engine, merge batching and flaky-test inference |
| [`docs/ORCHESTRATION.md`](ORCHESTRATION.md) | Agent-orchestration rule pack, on/off controls, and routing for unattended agents |
| [`docs/status/`](status/README.md) | Machine-readable status of every load-bearing claim (generated table) |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | Runtime layers, emitters, state, and design decisions |
| [`reports/benchmarks.md`](../reports/benchmarks.md) | Reproducible benchmark snapshot, methodology, environment, and limitations |
| [`research/python-prototypes/README.md`](../research/python-prototypes/README.md) | Explicit maturity boundary for the Python research packages |
| [`docs/cognitive-substrate/`](cognitive-substrate/) | White paper, evidence map, ecosystem map, and prototype sources |
| [`docs/RELEASING.md`](RELEASING.md) | Tag, npm, provenance, and GitHub Release flow |
| [`CHANGELOG.md`](../CHANGELOG.md) | Changes by release |

Current implementation truth for optional embeddings is `src/embed.js`: use an `http://` or
`https://` endpoint, or `cmd:<command>`. A bare `FORGE_EMBED=1` is not a valid provider
configuration. Benchmark comparison prose that describes MinHash-only behavior is historical and
does not supersede the current source and tests.
