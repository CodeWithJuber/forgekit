# The Forge Cognitive Substrate

**Coding agents forget what they learned, assume what they don't know, and break code they
can't see.** The substrate is a fast, mostly-deterministic check that runs _before_ an agent
edits your code: it flags an unclear task, picks the cheapest capable model, and shows what
an edit will break — all from the repo you already have, with no extra LLM call.

In Claude Code it runs **automatically**. In other tools you (or the agent) run one command.

> Why this exists, in one line: a model with frozen weights keeps no durable state between
> independent calls, sees only a bounded context, never updates its weights from outcomes, and
> cannot reliably verify itself without external evidence. Prompting does change what it does
> inside one context, but it cannot supply those guarantees; this layer supplies persistence and
> verification from the outside — one tested way to do it, not the only possible one. Full
> argument: the white paper ([HTML](./cognitive_substrate_whitepaper.html), with the 2026-09-21
> and 2026-09-26 corrections · [PDF](./cognitive_substrate_whitepaper.pdf), a pre-correction
> edition). _(Corrected 2026-09-26: this line used to say "no memory, no foresight, a fixed
> window. Those faculties can't be prompted in"; see the white paper's Corrections.)_

---

## Install

Install Forge (plugin · npm · `github:`) per [README → 60-second quickstart](../../README.md#60-second-quickstart),
then inside any project:

```bash
forge init      # writes each AI tool's native config from one source
forge atlas     # build the code graph (needed for blast-radius checks)
```

`forge init` configures Claude Code, Codex, Cursor, Gemini, Aider, Copilot, Windsurf, Zed,
Continue, and OpenClaw (plus MCP config for Roo and VS Code). On Claude Code the check then
runs on every prompt automatically.

---

## It runs itself (the main benefit)

You don't have to remember to use it.

**In Claude Code** — a hook runs the substrate on **every prompt** and adds a short note _only
when something needs attention_ (unclear task, big blast radius, pricey model). It never blocks
and never nags on a clean, simple task. Real example — you type _"refactor computeTax in
math.js"_ and the agent silently receives:

```text
Forge substrate — pre-action advisory (advisory, never blocks):
- Under-specified (high risk). Ask before editing:
    • What constraints must be respected: performance, dependencies, style, or compatibility?
- Suggested model: Haiku 4.5 (simple); escalate only on a verifier failure.
- Predicted blast radius (2: 2 reverse): invoice.js (reverse), math.js (reverse). Review these before editing.
- Verify with: review impacted files before editing · run the narrowest affected test first
```

A trusted prompt or tool-result hook can also deliver the evidence packet on supported hosts.
For a host without those events, run `forge evidence "<task>"` or call `forge_evidence`.
The [evidence guide](../AGENT-EVIDENCE.md) covers host setup, provider reads and indexed sources.
See [In other AI tools](#in-other-ai-tools).

---

## The one command

```bash
forge substrate "<what you want to do>"
```

The report includes observed prerequisites, measured model routes, affected files and verification obligations. For example, `forge preflight "Update exports" --require-file fixtures/exports.csv --json` checks the file directly. Without declared requirements it reports unknown coverage. A proposed new filename can appear among unresolved references without becoming a blocking requirement.

`forge impact <file>` shows known dependents. Additional co-change relations remain candidates for inspection. For the details of the evidence that permits a smaller test run, see the [test selection guide](../GUIDE.md#select-tests-from-measured-dependencies).

---

## The checks (each is also its own command)

`forge substrate` bundles these. Run any one on its own when that's all you need.

| Command                       | Answers                                  | One-line example                                |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `forge preflight "<task>"`    | Is this task clear enough to start?      | checks named references and required inputs       |
| `forge route "<task>"`        | Which model is cheapest-but-capable?     | compare deployments on shared measured workloads             |
| `forge impact <symbol\|file>` | What will this edit break?               | reverse-dependency blast radius                 |
| `forge scope <file…>`         | Can this be split into sessions?         | independent vs. coupled files                   |
| `forge anchor "<goal>"`       | Are my changes still on the stated goal? | flags changed files that drifted off-goal       |
| `forge verify`                | Did it actually work?                    | runs the real tests/build, not the model's word |

Inside an agent session (`FORGE_SESSION_ID`, or Claude Code's `CLAUDE_CODE_SESSION_ID`),
`forge substrate`'s goal-drift and minimality checks, `forge anchor` and `forge lean` read
only what that session changed since its SessionStart baseline. Older dirt is left out, and
so is a file another live session's trail claims (the completion gate's attribution rule).
Before the session has changed anything, minimality reports "pre-existing diff (not
measured)" instead of critiquing someone else's diff.

The wider v0.5 surface — `forge context` (budgeted assembly + completeness gate),
`forge imagine [--run]` (predicted breaks + minimal dry-run suite), `forge diagnose`
(doom-loop), `forge ledger` / `forge reuse` (proof-carrying memory + code cache), and
`forge uicheck` (the design gate) — is documented with real outputs in
[docs/GUIDE.md → Command reference](../GUIDE.md#command-reference).

Real output for the two most-used:

```console
$ forge preflight "fix the thing in authManager so it works properly"

- `authManager` — not found in the code. Different name, or should it be created?
- Ambiguous: "properly" — state concrete acceptance criteria.
- Which specific file, module, component, or symbol should this change touch?
```

```console
$ forge impact verifyToken
  target: verifyToken  ✓ found
  impacted files: 3
    - src/auth.js
    - src/login.js
    - src/session.js
```

---

## Read the result (what to do)

Field-by-field: what each verdict means and the action to take —
[docs/GUIDE.md → Reading substrate output](../GUIDE.md#reading-substrate-output).
The short version: `ASK FIRST` means ask, `route` means start cheap, `impact` means
read those files first, and `verify` means show the output before saying "done".

---

## In other AI tools

Tools without a hook surface get the substrate two ways, both written by `forge init`:
a rule in their native config telling the agent to run `forge substrate "<task>" --json`
before ambiguous/expensive/mutating work, and MCP tools (`substrate_check`,
`assumption_gate`, `predict_impact`, `route_task`, `scope_files`) any MCP-capable agent
can call directly. Details + the exact rule wording:
[docs/GUIDE.md → Auto-use inside an agent](../GUIDE.md#auto-use-inside-an-agent).

Forge never pretends it can force a hook into a tool that has none — it's ambient on Claude
Code, and agent-invoked everywhere else.

**OpenClaw** is agent-invoked in exactly this sense. It picks up the rules on its own (the
execution folder's `AGENTS.md` becomes project context), but its MCP registry is your global
`~/.openclaw/openclaw.json`, which Forge will not write to. `forge sync` leaves the
definition in `.openclaw/mcp.json`; you register it once with
`openclaw mcp add forge-cortex --command forge --arg cortex-mcp`. Forge installs nothing
into OpenClaw's own hook system.

---

## Use it in a script

Add `--json` to any command for machine-readable output — gate your agent's next step on
`okToProceed`, feed `route.tier` to your model picker, read `impact.impactedFiles` before
editing. Every knob (ask threshold, blast-radius sensitivity, routing signals, assumption
questions, the verify checklist, the ambient hook wording) is a small pure function or a
JSON default. Full JSON shape and the extension table:
[docs/GUIDE.md → Use it in a script](../GUIDE.md#use-it-in-a-script) ·
[Extending Forge](../GUIDE.md#extending-forge).

---

## Optional: LLM-assisted judgments (`FORGE_LLM=1`)

The pre-action check reads the current checkout and the configured provider inventory. `FORGE_LLM=1` enables a configured proposer. A provider reading and its provenance can accompany explicit prerequisite coverage. An operator may set `FORGE_PREFLIGHT_MIN_CONFIDENCE` to allow proposals to influence a suggestion. A model cannot waive a declared missing file. Model selection requires comparable verified outcomes. Permissions and spend limits follow the operator's configuration.

[![Observed prerequisites and optional model advice](../diagrams/llm-reconcile.svg)](https://jubershaikh.com/forgekit/diagrams/llm-reconcile.html)

## Limits

Static graph evidence covers the supported parser and compiler relationships. Dynamic behavior needs trusted runtime observations. The budgeted context packet accounts for the source content supplied to the agent. Human acceptance and independent tests are separate observations. [Operating manual](../ForgeKit-Full-Documentation.md)

## Learn more

- **White paper** — the full argument: [HTML](./cognitive_substrate_whitepaper.html) (with the
  2026-09-21 and 2026-09-26 corrections) · [PDF](./cognitive_substrate_whitepaper.pdf)
  (historical, pre-correction edition; provenance in
  [research/HISTORICAL_EDITIONS.md](../../research/HISTORICAL_EDITIONS.md)). Its two
  prototype results were refuted on real data — see
  [research/empirical-refutation/](../../research/empirical-refutation/).
- **[Package overview](./deliverable-package.md)** — headline results (refuted; see its banner)
  and prototypes
- **[Evidence map](./evidence_map.md)** — every load-bearing statistic re-graded against
  primary sources (5 confirmed, 5 vendor-reported, 2 dropped); since 2026-09-26 it also grades
  claim support, study design, replication and transfer scope separately
- **[Ecosystem map](./ecosystem_map.md)** — each capability vs. the real 2026 tool stack
- **[Prototype source](../../research/python-prototypes/)** — the auditable Python originals
- **[Claim status registry](../status/README.md)** — every load-bearing headline with its
  status (implemented / measured / refuted / hypothesis / partial / reported) and evidence

### Which copy is canonical

`research/cognitive-substrate/` is the canonical source. Four files here are byte-identical
copies kept for readers of `docs/`, and `node scripts/claims-status.mjs --check` fails when they
drift (sha256):

| Copy in `docs/cognitive-substrate/` | Canonical source |
| --- | --- |
| `cognitive_substrate_whitepaper.html` | `research/cognitive-substrate/cognitive_substrate_whitepaper.html` |
| `cognitive_substrate_whitepaper.pdf` | `research/cognitive-substrate/cognitive_substrate_whitepaper.pdf` |
| `evidence_map.md` | `research/cognitive-substrate/evidence/evidence_map.md` |
| `ecosystem_map.md` | `research/cognitive-substrate/evidence/ecosystem_map.md` |

Edit the canonical file, then copy it over (`node scripts/claims-status.mjs --sync-copies` does
that). [`deliverable-package.md`](./deliverable-package.md) is not a copy: it is an adapted
edition of `research/cognitive-substrate/EXECUTIVE_SUMMARY.md` with links rewritten for this
folder, so it is edited by hand alongside it.

**How the paper maps to what ships (all 11):** memory → `recall`/`cortex`/`ledger` ·
learning → `cortex` + ledger oracles · imagination → `imagine [--run]`/`impact` ·
self-correction → `verify`/`diagnose` · impact-awareness → `atlas`/`impact` · M1 routing →
`route` · M2 assumption gate → `preflight`/`context` · M3 decomposition → `scope` ·
M4 goal-anchoring → `anchor` · M5 minimality → `lean`/`uicheck design` · M6 verification →
`verify`/`substrate`.
