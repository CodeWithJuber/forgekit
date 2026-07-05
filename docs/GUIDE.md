# Forge — the complete guide

Every command with a worked example and its **real** output, the everyday workflow,
how to make it run itself inside any agent, common recipes, and how to extend each
piece. If you just want to get going, the [5-minute onboarding](../ONBOARDING.md) is
shorter; this is the reference you come back to.

- [Mental model](#mental-model)
- [The everyday workflow](#the-everyday-workflow)
- [Command reference](#command-reference) — every command, with examples
- [Auto-use inside an agent](#auto-use-inside-an-agent)
- [Reading substrate output](#reading-substrate-output)
- [Recipes](#recipes) — common situations, start to finish
- [Extending Forge](#extending-forge)
- [Honest limits](#honest-limits)

---

## Mental model

A language model at inference time is a fixed function `y = f(x)` — frozen weights, a
bounded window, no state between calls. From that shape, five things follow that no
prompt can fix: it can't **remember** across sessions, can't **learn** from outcomes,
can't **imagine** what an edit breaks, can't reliably **check itself**, and can't see
**what already exists** beyond its window.

Forge supplies those faculties from the *outside*, in three layers:

- **tools** — know-how the model loads on demand (`lean`, `atlas`, `recall`…).
- **crew** — isolated sub-agents for focused work (`scout`, `verifier`…).
- **guards** — deterministic shell hooks that *enforce* what prose can't (the only
  layer the model can't drift from).

Two subsystems sit on top: **Cortex** (self-correcting memory) and the **cognitive
substrate** (`forge substrate` — the pre-action check). The full argument is the
[white paper](cognitive-substrate/).

---

## The everyday workflow

```bash
cd your-project
forge init                              # once per repo: emit every tool's config
forge atlas build                       # once: index symbols so impact/scope work well

# then, for any non-trivial change:
forge substrate "<what you want to do>" # is it clear? which model? what breaks? split?
# …make the edit…
forge verify                            # prove it — real tests + hallucinated-symbol check
```

On **Claude Code** the `forge substrate` step happens automatically on every prompt
(see [Auto-use](#auto-use-inside-an-agent)); on other tools you or the agent run it.

---

## Command reference

Outputs below are copied verbatim from a real run against a four-file demo repo where
`src/login.js` and `src/session.js` both `import { verifyToken } from "./auth.js"`.

### `forge substrate "<task>"` — the one pre-action check

Bundles assumption gate + route + impact + scope + memory + verify into one verdict.
This is the command you'll use most.

**A clear task — cleared to proceed, with the blast radius:**

```console
$ forge substrate "Change verifyToken in src/auth.js to require length > 20; update tests"

Forge substrate — pre-action check

  proceed: yes
  assumption: medium risk · completeness 0.63

  route: Haiku 4.5 (simple) · complexity 0.15
    driven by: base cost of any task

  impact: 3 file(s) predicted
    - src/auth.js
    - src/login.js
    - src/session.js

  verify:
    - review impacted files before editing
    - run the narrowest affected test first, then the broader suite
```

It found `login.js` and `session.js` — the two files that import `verifyToken` but you
never named. That's the "forgot the coupled file" bug, caught *before* the edit.

**A vague task — it tells you to ask first:**

```console
$ forge substrate "make the auth better"

Forge substrate — pre-action check

  proceed: ASK FIRST
  assumption: high risk · completeness 0.23

  clarify:
    - What exactly should this produce, and how will we know it is correct?

  route: Haiku 4.5 (simple) · complexity 0.15
  impact: 0 file(s) predicted
```

Add `--json` for machine-readable output (see [Use it in a script](#use-it-in-a-script)).

### `forge preflight "<task>"` — is this clear enough to start?

The assumption gate on its own. Flags names the repo doesn't define and vague wording.

```console
$ forge preflight "fix the thing in authManager so it works properly"

Forge preflight — assumption check

  info-gap: 1.00  · completeness 0.01  (referenced 1 symbol(s), 0 file(s))

## Before starting — clarify (Forge Preflight)
This task has unknowns that would otherwise become assumptions:

- `authManager` — not found in the code. Different name, or should it be created?
- Ambiguous: "properly" — state concrete acceptance criteria.
- Which specific file, module, component, or symbol should this change touch?
- How will we verify it: tests, acceptance criteria, benchmark, or reference behavior?

_Advisory: ask rather than assume._
```

### `forge route "<task>"` — the cheapest capable model

A transparent additive rubric (never a second LLM call). Every point is attributable
to a named signal you can inspect and override.

```console
$ forge route "write an is_prime function"
  → Haiku 4.5  (simple, $1/$5 per M tok)
    lint, formatting, docs, stubs, trivial well-defined edits
    complexity 0.13 · driven by: ambiguity, base cost of any task

$ forge route "design and implement a distributed rate limiter with sliding windows across 3 services"
  → Fable 5  (extreme, $10/$50 per M tok)
    complexity 0.95 · driven by: algorithmic/systems difficulty, architectural/design scope
```

Run `forge route gateway` to emit a LiteLLM config so the routing happens automatically.

### `forge impact <symbol|file>` — what will this edit break?

Reverse-dependency blast radius from the atlas graph. Run `forge atlas build` first.

```console
$ forge impact verifyToken
Forge impact — blast radius

  target: verifyToken  ✓ found
  impacted files: 3
    - src/auth.js
    - src/login.js
    - src/session.js
```

### `forge scope <file…>` — can this be split into sessions?

Groups the files you name into independent clusters and surfaces coupled files you
*didn't* name — so you split cleanly instead of overloading one session.

```console
$ forge scope src/auth.js src/report.js
Forge scope — task decomposition

  2 independent groups → consider a separate session per group:

  [1] src/auth.js
      ! also coupled (you didn't name): src/session.js, src/login.js
  [2] src/report.js
```

### `forge verify` — did it actually work?

The independent check: runs the real test suite and flags edited symbols that aren't in
the codebase (possible hallucinations). This is what turns "the model says it's done"
into "the tests say it's done."

```console
$ forge verify
Forge verify

  changed files:    2
  tests:            ✓ pass
  symbols checked:  7
  provenance:       .forge/provenance.json

  PASS
```

### `forge atlas build | query | has` — the code-graph

```console
$ forge atlas build
  indexed 5 symbols in 4 files → .forge/atlas.json

$ forge atlas query verifyToken
  src/auth.js:1  function verifyToken

$ forge atlas has doesNotExistSymbol
  ✗ not found (possible hallucinated symbol): doesNotExistSymbol
```

`query` costs a few hundred tokens instead of reading five files; `has` is a cheap
"is this symbol real?" check before an agent calls it.

### `forge recall add | list | consolidate` — cross-session memory

Durable facts, one per file, injected at the start of the next session by the
`recall-load` guard. Secrets are refused.

```console
$ forge recall add "db-port" "Postgres runs on 5433 here, not 5432"
  saved: db-port
$ forge recall list
  - db-port
```

### `forge cortex [status | why <symbol>]` — self-correcting memory

Status of the lessons Cortex has learned from *this repo's* correction history.

```console
$ forge cortex
Forge cortex — self-correcting project memory

  lessons: 0  (active 0 · candidate 0 · quarantined 0 · retired 0)

  (no active lessons yet — Cortex learns from corrections as you work)

  stored in .forge/lessons/ (git-committable, auditable)
```

`forge cortex why <symbol>` shows the lessons that would be injected when you touch it.

### `forge uicheck <fg> <bg>` — deterministic WCAG contrast

Exact contrast math for UI work — asserted, never guessed.

```console
$ forge uicheck "#777" "#fff"
  contrast #777 on #fff: 4.48:1  →  fail (FAILS AA)
```

### The rest

| Command | Answers |
| --- | --- |
| `forge init` | Emit every tool's native config from one source. |
| `forge sync` | Recompile `source/` → each tool's files (idempotent). |
| `forge doctor` | Health check: layers, install, drift, cortex. |
| `forge catalog` | Start-Here index of every tool / crew / guard. |
| `forge brain` / `forge remember` | Portable project memory inlined into `AGENTS.md`. |
| `forge cost` | Real per-day spend (via `ccusage`) + the cost ceiling. |
| `forge scan <path>` | Vet a skill/MCP for injection/RCE before install. |
| `forge harden` | Wire gitleaks pre-commit + sandbox settings. |
| `forge spec [init\|lock\|check]` | Spec-as-contract drift check. |
| `forge brand` | Print the active brand token map. |

### Use it in a script

```bash
forge substrate "update verifyToken in src/auth.js" --json
```

```jsonc
{
  "okToProceed": false,
  "assumption": { "risk": "high", "shouldAsk": true, "questions": ["…"] },
  "route":      { "tier": "simple", "model": { "name": "Haiku 4.5" } },
  "impact":     { "impactedFiles": ["src/auth.js", "src/login.js"] },
  "verification": { "checklist": ["npm test", "npm run typecheck"] }
}
```

Gate your agent's next step on `okToProceed`; feed `route.tier` to your model picker;
read `impact.impactedFiles` before editing. `forge impact <target> --json` is available
too.

---

## Auto-use inside an agent

The point of Forge is that you don't have to *remember* to run these checks.

### Claude Code — fully ambient

Install the plugin and the substrate runs on **every prompt** via a `UserPromptSubmit`
hook. It adds a short advisory only when something needs attention and never blocks:

```text
Forge substrate — pre-action advisory (advisory, never blocks):
- Under-specified (high risk). Ask before editing:
    • What constraints must be respected: performance, dependencies, style, compatibility?
- Suggested model: Haiku 4.5 (simple); escalate only on a verifier failure.
- Predicted blast radius (2): login.js, auth.js. Review these before editing.
- Verify with: review impacted files before editing · run the narrowest affected test first
```

Nothing to wire — the plugin's [`hooks/hooks.json`](../hooks/hooks.json) installs the
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` guards for you.

### Every other tool — a rule + MCP tools

`forge init` writes a rule into each tool's native config (`AGENTS.md`, `.cursor/rules`,
`GEMINI.md`, …) telling the agent to run the check itself:

> Before ambiguous, expensive, multi-file, or mutating work, run
> `forge substrate "<task>" --json` (or the MCP tool `substrate_check`). If
> `okToProceed` is false, ask the questions first; read `impact.impactedFiles` before editing.

…and exposes the substrate as MCP tools any MCP-capable agent can call directly:

| MCP tool | Does |
| --- | --- |
| `substrate_check` | full pre-action check |
| `assumption_gate` | ask/proceed + questions |
| `predict_impact` | blast radius |
| `route_task` | model recommendation |
| `scope_files` | independent vs. coupled |

Forge never pretends it can force a hook into a tool that has none — **ambient on Claude
Code, agent-invoked everywhere else.**

---

## Reading substrate output

| Field | What it means | Do this |
| --- | --- | --- |
| `proceed: ASK FIRST` / `okToProceed: false` | task is under-specified | ask the `clarify` questions, don't guess |
| `route` | cheapest capable model | start there; escalate only if a verifier fails |
| `impact` | predicted blast radius | read these files before editing |
| `scope` | independent vs. coupled work | split independent groups into separate sessions |
| `memory` | past Cortex lessons for this area | context, not law — tests override it |
| `verify` | how to prove it works | run it, show the output, then say "done" |

---

## Recipes

**Before a risky refactor.** `forge impact <symbol>` (or `forge substrate "<task>"`) to
see every dependent, including the ones the ticket didn't name; read them; edit the
shared function once at the root, not each caller.

**Splitting a big change.** `forge scope <files…>` → if it reports more than one
independent group, do a session per group; keep coupled files together.

**Controlling cost.** `forge route "<task>"` before you pick a model; `forge cost` for
real spend; the `cost-budget` guard warns when a day exceeds `FORGE_COST_CEILING`.

**Teaching the repo a fact.** `forge recall add "<name>" "<fact>"` — it's injected next
session. For learned-from-mistakes memory, just work: Cortex captures recurring
corrections on its own.

**UI work.** `forge uicheck <fg> <bg>` for exact contrast; the `ui-workflow` and
`taste` tools for the rest.

---

## Extending Forge

Everything is small, single-sourced, and testable. Change one piece, run `npm test`.

### Add or change a rule
Edit [`source/rules.json`](../source/rules.json), then `forge sync`. The rule is
re-emitted into every tool's native file with a content-hash header.

### Add a tool (skill)
Create `global/tools/<name>/SKILL.md` with `name` + `description` frontmatter. It's
picked up by the plugin and by `forge catalog`.

### Add a guard (enforced hook)
Create `global/guards/<name>.sh` (source `_guardlib.sh` for the shared fields + the
re-entrancy lock), then wire it in `global/settings.template.json` **and**
[`hooks/hooks.json`](../hooks/hooks.json). Guards must be idempotent and fail-safe —
worst case they do nothing.

### Add a crew member (sub-agent)
Create `global/crew/<name>.md` with frontmatter. It installs into `~/.claude/agents/`.

### Tune the cognitive substrate
| To change… | Edit |
| --- | --- |
| how often it asks | `source/substrate.json` → `defaults.askThreshold` (0.6) |
| blast-radius sensitivity | `source/substrate.json` → `defaults.impactThreshold` (0.1) |
| a routing signal | `src/route.js` → `rubricComplexity()` |
| model tiers / prices | `src/model_tiers.js` |
| an assumption question | `src/preflight.js` → `DIMENSIONS[]` |
| the verify checklist | `src/substrate.js` → `verificationChecklist()` |
| when the ambient hook speaks | `src/substrate.js` → `substrateContext()` |
| the cross-tool rule wording | `source/rules.json` → `substrate` section (then `forge init`) |

### Support a new tool
Add an emitter module in `src/emit/<tool>.js` (mirror an existing one like
`src/emit/cursor.js`), then register it in `src/sync.js`. A golden-file test in
`test/sync.test.js` keeps it honest.

### Rebrand
Edit `brand.json` (`FORGE_BRAND`), the `bin` key in `package.json`, and `name` in
`.claude-plugin/plugin.json`. The whole CLI, banner, and emitted headers follow.

---

## Honest limits

- **Guards reduce, don't eliminate** the "ignored my rules" problem — semantic rules
  still live in prose.
- **`recall` / `cortex` are file + prompt memory**, not weight-level learning.
- **The atlas graph is regex-approximate** — conservative, not a sound call graph;
  dynamic dispatch and generated code can be missed.
- **The substrate's rubrics are heuristic, not benchmarked** — judge them after real
  use. What's *asserted* (safe to gate on): repo grounding, graph traversal, scope
  decomposition, routing arithmetic, and the test/build commands. Everything else is
  *advisory*. **Tests and human corrections always win.**
