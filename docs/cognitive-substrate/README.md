# The Forge Cognitive Substrate

**Coding agents forget what they learned, assume what they don't know, and break code they
can't see.** The substrate is a fast, mostly-deterministic check that runs *before* an agent
edits your code: it flags an unclear task, picks the cheapest capable model, and shows what
an edit will break — all from the repo you already have, with no extra LLM call.

In Claude Code it runs **automatically**. In other tools you (or the agent) run one command.

> Why this exists, in one line: a frozen model is a stateless function `y = f(x)` — no memory,
> no foresight, a fixed window. Those faculties can't be prompted in; they have to be supplied
> from the outside. This is that outside layer. Full argument: the white paper
> ([PDF](./cognitive_substrate_whitepaper.pdf) · [HTML](./cognitive_substrate_whitepaper.html)).

---

## Install (about 2 minutes)

```bash
# Claude Code / Codex — the plugin (recommended; the check then runs on every prompt)
/plugin marketplace add CodeWithJuber/forgekit
/plugin install forgekit

# …or the CLI, any tool (no token, no clone)
npm install -g github:CodeWithJuber/forgekit
```

Then, inside any project:

```bash
forge init      # writes each AI tool's native config from one source
forge atlas     # builds the code graph (needed for blast-radius checks)
```

That's it. `forge init` configures Claude Code, Codex, Cursor, Gemini, Aider, Copilot, Zed,
Continue, and Roo where supported.

---

## It runs itself (the main benefit)

You don't have to remember to use it.

**In Claude Code** — a hook runs the substrate on **every prompt** and adds a short note *only
when something needs attention* (unclear task, big blast radius, pricey model). It never blocks
and never nags on a clean, simple task. Real example — you type *"refactor computeTax in
math.js"* and the agent silently receives:

```text
Forge substrate — pre-action advisory (advisory, never blocks):
- Under-specified (high risk). Ask before editing:
    • What constraints must be respected: performance, dependencies, style, or compatibility?
- Suggested model: Haiku 4.5 (simple); escalate only on a verifier failure.
- Predicted blast radius (2): invoice.js, math.js. Review these before editing.
- Verify with: review impacted files before editing · run the narrowest affected test first
```

**In other AI tools** (Codex, Cursor, Gemini, Aider…) — `forge init` writes a rule into their
config file telling the agent to run the check itself, and exposes it as MCP tools it can call.
See [In other AI tools](#in-other-ai-tools).

---

## The one command

```bash
forge substrate "<what you want to do>"
```

It runs the whole check and gives a plain verdict. Two real examples:

**Vague task → it tells you to ask first:**

```console
$ forge substrate "make the auth better"

  proceed: ASK FIRST
  assumption: high risk · completeness 0.23
  clarify:
    - What exactly should this produce, and how will we know it is correct?
  impact: 0 file(s) predicted
```

**Clear task → it clears you and shows the blast radius:**

```console
$ forge substrate "Change verifyToken in src/auth.js to require length > 20; update tests"

  proceed: yes
  assumption: medium risk · completeness 0.63
  route: Haiku 4.5 (simple)
  impact: 3 file(s) predicted
    - src/auth.js
    - src/login.js        (imports verifyToken — you didn't mention it)
    - src/session.js      (imports verifyToken — you didn't mention it)
  verify:
    - run the narrowest affected test first, then the broader suite
```

The second run found the two files that import `verifyToken` but you never named — the
"forgot the coupled file" bug, caught *before* the edit. Add `--json` for machine-readable
output (see [Use it in a script](#use-it-in-a-script)).

---

## The five checks (each is also its own command)

`forge substrate` bundles these. Run any one on its own when that's all you need.

| Command | Answers | One-line example |
| --- | --- | --- |
| `forge preflight "<task>"` | Is this task clear enough to start? | flags names not in the repo + vague words |
| `forge route "<task>"` | Which model is cheapest-but-capable? | trivial → Haiku · hard → Opus/Fable |
| `forge impact <symbol\|file>` | What will this edit break? | reverse-dependency blast radius |
| `forge scope <file…>` | Can this be split into sessions? | independent vs. coupled files |
| `forge verify` | Did it actually work? | runs the real tests/build, not the model's word |

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

| Field | What it means | Do this |
| --- | --- | --- |
| `okToProceed: false` | task is under-specified | ask the `assumption.questions`, don't guess |
| `route.tier` | cheapest capable model | start there; only escalate if a verifier fails |
| `impact.impactedFiles` | predicted blast radius | read these before editing |
| `scope.clusters` | independent vs. coupled work | split independent groups into separate sessions |
| `memory.advisory` | past lessons for this area | context, not law — tests override it |
| `verification.checklist` | how to prove it works | run it, show the output, then say "done" |

---

## In other AI tools

Tools without a hook surface get the substrate two ways, both written by `forge init`:

1. **A rule in their config** (`AGENTS.md`, `.cursor/rules`, `GEMINI.md`, …): *"Before
   ambiguous, expensive, multi-file, or mutating work, run `forge substrate "<task>" --json`
   (or the MCP tool `substrate_check`). If `okToProceed` is false, ask the questions first."*

2. **MCP tools** any MCP-capable agent can call directly:

   | MCP tool | Does |
   | --- | --- |
   | `substrate_check` | full pre-action check |
   | `assumption_gate` | ask/proceed + questions |
   | `predict_impact` | blast radius |
   | `route_task` | model recommendation |
   | `scope_files` | independent vs. coupled |

Forge never pretends it can force a hook into a tool that has none — it's ambient on Claude
Code, and agent-invoked everywhere else.

---

## Use it in a script

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

Gate your agent's next step on `okToProceed`; feed `route.tier` to your model picker; read
`impact.impactedFiles` before editing.

---

## Extend it

Small, pure functions — change the one piece you need, then run `npm test`.

| To change… | Edit |
| --- | --- |
| how often it asks | `source/substrate.json` → `defaults.askThreshold` (0.6) |
| blast-radius sensitivity | `source/substrate.json` → `defaults.impactThreshold` (0.1) |
| a routing signal | `src/route.js` → `rubricComplexity()` |
| an assumption question | `src/preflight.js` → `DIMENSIONS[]` |
| the verify checklist | `src/substrate.js` → `verificationChecklist()` |
| when the ambient hook speaks | `src/substrate.js` → `substrateContext()` |
| the cross-tool wording | `source/rules.json` → `substrate` section (then `forge init`) |

---

## Honest limits

- **Heuristic, not benchmarked.** Rubrics were tuned on small hand-labeled sets. Judge after
  real use.
- **The graph is regex-approximate.** Dynamic dispatch / DI / generated code can be missed —
  impact is *conservative* (catches the obvious dependents), not a sound call graph.
- **Assumption detection is lexical.** It catches unclear *names and wording*, not wrong
  *intent*.
- **Auto-run needs a hook surface** — fully ambient on Claude Code; agent-invoked elsewhere.

What's **asserted** (safe to gate on): repo symbol/file grounding, graph traversal, scope
decomposition, the routing arithmetic, and the test/build commands. What's **advisory**
(flagged, never asserted): whether the model is capable enough, whether a change is
over-engineered, and whether a past lesson is relevant. Tests and human corrections always win.

---

## Learn more

- **White paper** — the full argument: [PDF](./cognitive_substrate_whitepaper.pdf) ·
  [HTML](./cognitive_substrate_whitepaper.html)
- **[Package overview](./deliverable-package.md)** — headline results and prototypes
- **[Evidence map](./evidence_map.md)** — every load-bearing statistic re-graded against
  primary sources (5 confirmed, 5 vendor-reported, 2 dropped)
- **[Ecosystem map](./ecosystem_map.md)** — each capability vs. the real 2026 tool stack
- **[Prototype source](../../research/python-prototypes/)** — the auditable Python originals

**How the paper maps to what ships:** memory → `recall`/`cortex` · learning → `cortex` ·
imagination → `impact` · self-correction → `verify` · impact-awareness → `atlas`/`impact` ·
M1 routing → `route` · M2 assumption gate → `preflight` · M3 decomposition → `scope` ·
M4 goal-anchoring, M5 minimality, M6 verification → `substrate`.
