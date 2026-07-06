# Forge — one config for every AI coding agent

[![CI](https://github.com/CodeWithJuber/forgekit/actions/workflows/ci.yml/badge.svg)](https://github.com/CodeWithJuber/forgekit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@codewithjuber/forgekit.svg)](https://www.npmjs.com/package/@codewithjuber/forgekit)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![runtime deps: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](./package.json)

**The memory, foresight, and guardrails a frozen model structurally lacks — wired into
every AI coding tool from one config.**

## The problem

You now juggle several AI coding assistants, and every one of them:

- reads a **different** config file (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `GEMINI.md`…),
- **acknowledges your rules, then ignores them** — especially after a context compaction,
- has **no memory** across sessions and re-learns your repo every time,
- **can't see what an edit breaks** beyond the handful of files in its window, and
- can quietly run up a surprise token bill.

## The solution

Author your rules **once**. Forge emits each tool's native config, enforces the
non-negotiables as deterministic **guards**, and adds cross-session memory, a code-graph,
a cost governor, and a **cognitive substrate** that checks a task *before* the agent
touches your code. Works with **Claude Code, Codex, Cursor, Gemini, Aider, Copilot,
Windsurf, Zed, and Continue** (plus MCP config for Roo and VS Code).

> **Status: beta.** The core (`init`, `sync`, `substrate`, `impact`, `cortex`, guards)
> is tested and in daily use; some flags may change before `1.0`.

---

## Install

`forge` is a zero-dependency Node CLI. Pick the row that fits — the recommended paths
need **no token and no clone**.

| You use… | Run this | What you get |
| --- | --- | --- |
| **Claude Code / Codex** *(recommended)* | `/plugin marketplace add CodeWithJuber/forgekit`<br>`/plugin install forgekit` | The full plugin — tools, crew, and **ambient guards** wired automatically. |
| **Any tool, from the CLI** | `npm install -g @codewithjuber/forgekit` | The `forge` command on your `PATH`, from public npm. |
| **Contributors / local dev** | `git clone https://github.com/CodeWithJuber/forgekit.git`<br>`cd forgekit && npm link` | An editable checkout with `forge` linked to your working copy. |

```bash
forge doctor      # verify any install: tools, guards, MCP, config drift
```

<details>
<summary>Other ways in (no-registry install · symlink dev setup)</summary>

- **No registry at all:** `npm install -g github:CodeWithJuber/forgekit` installs `forge`
  straight from the repo — no npm account, no token.
- **Symlink dev setup:** from a clone, `bash install.sh` symlinks `global/` into
  `~/.forge` + `~/.claude` and prints the hook block to merge. Idempotent, reversible
  (`bash install.sh --uninstall`), offline. Prefer the plugin unless you're hacking on Forge.

</details>

## Quickstart

```bash
cd your-project
forge init                 # emit every tool's native config from one shared source
forge substrate "add rate limiting to the /login route"   # pre-action check before you edit
```

`forge init` writes each agent's native config from one source. On **Claude Code** the
substrate then runs **on every prompt, automatically** — see [It runs itself](#it-runs-itself).

---

## How it works — three layers

| Layer | Is | What it does | Enforcement |
| --- | --- | --- | --- |
| **tools** | model-invoked skills | know-how loaded on demand: `lean`, `reuse-first`, `atlas`, `recall`, `cognitive-substrate` | the model opts in |
| **crew** | isolated sub-agents | fresh-context specialists: `scout`, `verifier`, `frontend-verifier` | spawned per task |
| **guards** | deterministic hooks | the **only** layer that *enforces*: `protect-paths`, `cost-budget`, `doom-loop`, `cortex` | runs no matter what the model "remembers" |

**The one idea that matters:** rules a model can drift from live in prose; rules it must
**never** break live in **guards** — shell hooks that can't be forgotten after a context
compaction. So Forge moves enforceable invariants (don't touch `.env`, watch the budget,
keep diffs small) out of `CLAUDE.md` prose and into guards, and keeps the prose thin.

Two subsystems build on those layers:

- **Cortex — self-correcting memory.** A model relearns your repo every session and
  repeats last week's correction. Cortex spots a *genuine* recurring mistake (a test that
  failed then passed, a `git revert`, an explicit "undo"), distills a durable lesson, and
  re-confirms it against fresh outcomes. Only independent outcomes (tests, builds, a human)
  move a lesson's confidence — so a wrong one decays out instead of ossifying. Advisory.

- **Cognitive substrate — the check before every edit.** One fast, mostly-deterministic
  command supplies what a frozen model can't: is the task clear enough to start
  (**assumption gate**), which model is cheapest-but-capable (**route**), what an edit will
  break (**impact / blast radius**), what to split into separate sessions (**scope**),
  whether the work has drifted off-goal (**anchor**), and how to prove it worked
  (**verify**) — from the repo you already have, with no extra LLM call.

```bash
forge substrate "Change verifyToken in src/auth.js to require length > 20; update tests"
```

returns, in one pass: the assumption verdict, the cheapest capable model, the predicted
blast radius (**including the coupled files you didn't name**), scope clusters, matching
Cortex lessons, goal-drift, and a verification checklist.

> **Why a "substrate"?** A language model at inference is a fixed function `y = f(x)` —
> frozen weights, a bounded window, no state between calls. Memory, foresight, and
> self-checking can't be prompted into that shape; they have to be supplied from outside.
> The full argument, with evidence graded against primary sources, is the
> [cognitive-substrate white paper](docs/cognitive-substrate/).

## It runs itself

You don't have to remember to use any of this.

- **In Claude Code** — a `UserPromptSubmit` hook runs the substrate on **every prompt** and
  adds a short advisory *only when something needs attention* (unclear task, big blast
  radius, pricey model). It never blocks and never nags on a clean task.
- **In every other tool** — `forge init` writes a rule into the tool's native config telling
  the agent to run the check itself, and exposes it as MCP tools any agent can call
  (`substrate_check`, `predict_impact`, `assumption_gate`, `route_task`, `scope_files`).

Ambient on Claude Code, agent-invoked everywhere else — and Forge says so plainly rather
than pretending it can force a hook into a tool that has none.

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

**→ Every command with a worked example, real output, and how to extend it:
[`docs/GUIDE.md`](docs/GUIDE.md).**

## Honest limits

Forge states its own ceiling everywhere. In short: **guards reduce, don't eliminate** the
"ignored my rules" problem; `recall`/`cortex` are file memory, **not** weight-level
learning; the `atlas`/`impact` graph is regex-approximate (conservative, not a sound call
graph); and the substrate's rubrics are heuristic, not benchmarked. What's *asserted* is
safe to gate on (repo grounding, graph traversal, routing arithmetic, the test commands);
everything else is *advisory*. **Tests and human corrections always win.** Full list:
[docs/GUIDE.md → Honest limits](docs/GUIDE.md#honest-limits).

## Documentation

| Doc | What's in it |
| --- | --- |
| [`ONBOARDING.md`](ONBOARDING.md) | Five minutes to productive + the design principles. |
| [`docs/GUIDE.md`](docs/GUIDE.md) | Every command, worked examples, all cases, how to extend. |
| [`docs/cognitive-substrate/`](docs/cognitive-substrate/) | The white paper, evidence map, ecosystem map, and prototype sources. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The four-layer compiler and the cross-tool emit matrix. |
| [`docs/RELEASING.md`](docs/RELEASING.md) | How releases are cut (tag → npm + GitHub Release). |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed, per release. |

## Community & support

- **Get help** → [SUPPORT.md](./SUPPORT.md) · [Discussions](https://github.com/CodeWithJuber/forgekit/discussions)
- **Contribute** → [CONTRIBUTING.md](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)
- **Direction** → [ROADMAP.md](./ROADMAP.md) · [GOVERNANCE.md](./GOVERNANCE.md)
- **Security** → [SECURITY.md](./SECURITY.md) (report privately) · **Accessibility** → [ACCESSIBILITY.md](./ACCESSIBILITY.md)

## Rebranding

The name lives in one place: `brand.json`. Change it there (plus the `bin` key in
`package.json` and `name` in `.claude-plugin/plugin.json`) and the whole CLI, banner, and
emitted headers follow.

---

MIT licensed. Built by [CodeWithJuber](https://github.com/CodeWithJuber).
