# Forge

[![CI](https://github.com/CodeWithJuber/forgekit/actions/workflows/ci.yml/badge.svg)](https://github.com/CodeWithJuber/forgekit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![runtime deps: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](./package.json)

**One config, every AI coding tool — plus the memory, foresight, and guardrails a
frozen model structurally lacks.**

Forge is a cross-tool configuration layer for agentic coding assistants. You author
your rules **once**; Forge emits each tool's native config, enforces the
non-negotiables as deterministic guards, and adds a code-graph, cross-session memory,
a cost governor, and a **cognitive substrate** that runs a fast pre-action check
before an agent touches your code. Works with **Claude Code, Codex, Cursor, Gemini
CLI, Aider, Copilot, Windsurf/Devin, Zed, Continue, and Roo**.

> **Status: beta.** The core (`init`, `sync`, `substrate`, `impact`, `cortex`, guards)
> is tested and in daily use; some flags may still change before `1.0`.

- **New here?** → [Install](#install) then the [5-minute onboarding](ONBOARDING.md).
- **Want every command with worked examples?** → [`docs/GUIDE.md`](docs/GUIDE.md).
- **Want the theory?** → the [cognitive-substrate white paper](docs/cognitive-substrate/).

---

## Install

Pick the row that matches how you work. **No `curl | bash`, no clone required** for
the two recommended paths.

| You use… | Run this | What you get |
| --- | --- | --- |
| **Claude Code / Codex** *(recommended)* | `/plugin marketplace add CodeWithJuber/forgekit`<br>`/plugin install forgekit` | The full plugin — tools, crew, and **ambient guards** wired automatically. Zero setup. |
| **Any tool, from the CLI** | `npm install -g github:CodeWithJuber/forgekit` | The `forge` command on your `PATH`. No token, no clone. |
| **Contributors / local dev** | `git clone https://github.com/CodeWithJuber/forgekit.git`<br>`cd forgekit && npm link` | An editable checkout with `forge` linked to your working copy. |

Verify any install with one command:

```bash
forge doctor      # health-check: tools, guards, MCP auth, config drift
```

<details>
<summary>Alternative installs (symlink dev setup · GitHub Packages · CI)</summary>

**Symlink `global/` into `~/.claude` (dev setup).** From a clone, `bash install.sh`
symlinks the tree into `~/.forge` + `~/.claude` and prints the hook block to merge.
It is idempotent, reversible (`bash install.sh --uninstall`), offline, and never
edits your `settings.json` for you. Prefer the plugin unless you're hacking on Forge
itself.

**GitHub Packages (`@codewithjuber/forgekit`).** Published to GitHub Packages, which
requires an auth token even for public installs — so it's only worth it in CI that
already authenticates:

```bash
echo "@codewithjuber:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc   # needs read:packages
npx @codewithjuber/forgekit init
```

</details>

All three front doors drive the **same** `global/` + `source/` tree — no duplication.

---

## Quickstart

```bash
cd your-project

forge init                 # emit every tool's native config from one shared source
forge substrate "add rate limiting to the /login route"   # pre-action check before you edit
```

`forge init` configures Claude Code, Codex, Cursor, Gemini, Aider, Copilot, Zed,
Continue, and Roo — each reads the **same** rules from its own native file. On Claude
Code the substrate then runs **on every prompt, automatically** (see [below](#it-runs-itself)).

---

## Why Forge exists

A single developer now juggles several AI coding tools, and each one:

- reads a **different** config file (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `GEMINI.md`…),
- **acknowledges your rules, then ignores them** — especially after context compaction,
- has **no memory** across sessions, re-learning your repo every time,
- **can't see what an edit breaks** beyond the files in its window, and
- can quietly run up a surprise token bill.

Forge answers each with a specific mechanism, not a vibe. The mechanisms come straight
from a first-principles read of what a frozen language model *is* — a stateless
function `y = f(x)` with fixed weights and a bounded window — and what that shape
structurally prevents. The full argument, with evidence graded against primary
sources, is the [cognitive-substrate white paper](docs/cognitive-substrate/).

## How it works — three layers

| Layer | Named | What it does | Enforcement |
| --- | --- | --- | --- |
| **tools** | model-invoked skills | know-how loaded on demand: `lean`, `reuse-first`, `atlas`, `recall`, `cognitive-substrate` | the model chooses to use them |
| **crew** | isolated sub-agents | fresh-context specialists: `scout`, `verifier`, `frontend-verifier` | spawned per task |
| **guards** | deterministic hooks | the **only** layer that *enforces*: `protect-paths`, `cost-budget`, `doom-loop`, `cortex` | runs regardless of what the model "remembers" |

**The one idea that matters:** rules the model can drift from live in prose; rules it
must **never** break live in **guards**. A guard is a shell hook — it can't be
forgotten after a context compaction. So Forge demotes enforceable invariants (don't
touch `.env`, watch the token budget, keep diffs small) out of `CLAUDE.md` prose and
into guards, and keeps the prose thin and single-sourced.

Two subsystems build on those layers:

- **Forge Cortex — self-correcting memory.** An LLM relearns your repo every session
  and repeats last week's correction. Cortex watches for a *genuine* recurring mistake
  (a test that failed then passed, a `git revert`, an explicit "undo"), distills a
  durable lesson, and re-confirms it against fresh outcomes. Injection never confirms a
  lesson — only independent outcomes (tests, builds, a human) move its confidence, so a
  wrong lesson decays out instead of ossifying. Advisory, never blocking.

- **Forge Cognitive Substrate — the check before every edit.** One fast, mostly-
  deterministic command supplies the faculties a frozen model can't have: is the task
  clear enough to start (**assumption gate**), which model is cheapest-but-capable
  (**route**), what will this edit break (**impact / blast radius**), what can be split
  into separate sessions (**scope**), and how do we prove it worked (**verify**) — all
  from the repo you already have, with no extra LLM call.

```bash
forge substrate "Change verifyToken in src/auth.js to require length > 20; update tests"
```

returns, in one pass: the assumption verdict, the cheapest capable model, the predicted
blast radius (including the coupled files you *didn't* name), scope clusters, relevant
Cortex lessons, and a verification checklist.

## It runs itself

You don't have to remember to use any of this.

- **In Claude Code** — a `UserPromptSubmit` hook runs the substrate on **every prompt**
  and adds a short advisory *only when something needs attention* (unclear task, big
  blast radius, pricey model). It never blocks and never nags on a clean, simple task.
- **In other AI tools** (Codex, Cursor, Gemini, Aider…) — `forge init` writes a rule
  into their native config telling the agent to run the check itself, and exposes it as
  MCP tools any MCP-capable agent can call: `substrate_check`, `assumption_gate`,
  `predict_impact`, `route_task`, `scope_files`.

Forge never pretends it can force a hook into a tool that has none — it's **ambient on
Claude Code, agent-invoked everywhere else**, and says so plainly.

---

## Commands

```
forge init        emit this repo's config for every tool (one command)
forge sync        recompile source/ → each tool's native files (idempotent)
forge doctor      pass/fail health check (layers, install, drift, cortex)
forge catalog     Start-Here index of every tool / crew / guard

forge substrate   full pre-action cognitive-substrate check
forge preflight   assumption check — what a task names that the repo doesn't define
forge route       cheapest capable model for a task (+ gateway config)
forge impact      predict blast radius for a symbol or file
forge scope       decompose files into independent clusters
forge anchor      goal-drift check — are your git changes still on the stated goal?
forge verify      independent verification — tests + hallucinated-symbol check
forge uicheck     deterministic WCAG contrast check

forge cortex      self-correcting memory — status / why <symbol>
forge atlas       build / query the code-graph (where-is-X, has-symbol)
forge recall      cross-session memory (list / add / consolidate)
forge brain       portable project memory inlined into AGENTS.md
forge cost        real per-day spend via ccusage + the cost ceiling
forge scan        vet a skill/MCP for injection/RCE before install
forge harden      wire gitleaks pre-commit + sandbox settings
forge brand       print the active brand token map
```

**→ Every command with a worked example, expected output, and how to extend it:
[`docs/GUIDE.md`](docs/GUIDE.md).**

---

## What's honest about it

Forge states its own ceiling everywhere — the same discipline the substrate applies to
your edits.

- **Guards reduce, don't eliminate** the "ignored my rules" problem — semantic rules
  still live in prose and can still be missed.
- **`recall` / `cortex` are file + prompt memory**, not weight-level learning. No RL,
  no fine-tuning. Consolidation is deterministic, not a model call.
- **`atlas` / `impact` is a regex-approximate graph.** It flags likely-hallucinated
  symbols and catches the obvious dependents; it is *conservative*, not a sound call
  graph, and can miss dynamic dispatch or generated code.
- **The substrate's rubrics are heuristic, not benchmarked** — tuned on small
  hand-labeled sets. What's *asserted* (safe to gate on): repo grounding, graph
  traversal, scope decomposition, routing arithmetic, and the test/build commands.
  What's *advisory* (flagged, never asserted): model fit, minimality, and memory
  relevance. **Tests and human corrections always win.**

## Documentation

| Doc | What's in it |
| --- | --- |
| [`ONBOARDING.md`](ONBOARDING.md) | Five minutes to productive + the design principles. |
| [`docs/GUIDE.md`](docs/GUIDE.md) | Every command, worked examples, all cases, how to extend. |
| [`docs/cognitive-substrate/`](docs/cognitive-substrate/) | The white paper, evidence map, ecosystem map, and prototype sources. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The four-layer compiler, the pain-point evidence, and the cross-tool emit matrix. |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed, per release. |

## Community & support

- **Get help / ask questions** → [SUPPORT.md](./SUPPORT.md) · [Discussions](https://github.com/CodeWithJuber/forgekit/discussions)
- **Contribute** → [CONTRIBUTING.md](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)
- **Direction & decisions** → [ROADMAP.md](./ROADMAP.md) · [GOVERNANCE.md](./GOVERNANCE.md)
- **Security** → [SECURITY.md](./SECURITY.md) (report privately) · **Accessibility** → [ACCESSIBILITY.md](./ACCESSIBILITY.md)

## Rebranding

The name lives in one place: `brand.json` (`FORGE_BRAND`). Change it there (plus the
`bin` key in `package.json` and `name` in `.claude-plugin/plugin.json`) and the whole
CLI, banner, and emitted headers follow.

---

MIT licensed. Built by [CodeWithJuber](https://github.com/CodeWithJuber).
