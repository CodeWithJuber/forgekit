# Forge

[![CI](https://github.com/CodeWithJuber/forgekit/actions/workflows/ci.yml/badge.svg)](https://github.com/CodeWithJuber/forgekit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/forgekit.svg)](https://www.npmjs.com/package/forgekit)
[![license: MIT](https://img.shields.io/npm/l/forgekit.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/forgekit.svg)](https://www.npmjs.com/package/forgekit)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

**One config, every AI coding tool.**

> **Status: beta.** The core (`sync`, `verify`, `brain`, `scan`, `cost`, guards) is tested
> and in daily use; some flags/APIs may still change before `1.0`.

Forge is a cross-tool configuration layer for agentic AI coding assistants. You
author your rules and workflow **once**; Forge emits each tool's native config,
enforces the non-negotiables as deterministic guards, and adds a code-graph,
cross-session memory, and a cost governor. Works with **Claude Code, Codex,
Cursor, Gemini CLI, Aider, Copilot, Windsurf/Devin, and Zed**.

**Install** — pick one:

```bash
# A) Claude Code / Codex — as a plugin (recommended)
/plugin marketplace add CodeWithJuber/forgekit
/plugin install forgekit

# B) Clone and run the installer (puts `forge` on your PATH)
git clone https://github.com/CodeWithJuber/forgekit.git
cd forgekit && bash install.sh
```

**Use** — in any repository:

```bash
forge init               # emit every tool's config from one source
forge substrate "task"   # assumption gate + route + impact + scope + verify
forge doctor             # verify everything is wired
```

<details>
<summary>CI / devcontainer install via npm (GitHub Packages)</summary>

Forge publishes to GitHub Packages as `@codewithjuber/forgekit`. GitHub Packages requires a
token even for public installs, so authenticate the scope once, then run it:

```bash
echo "@codewithjuber:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc   # needs read:packages
npx @codewithjuber/forgekit init
```

</details>

All channels drive the **same** `global/` tree.

## Why

A single developer now juggles several AI coding tools, and each one:

- reads a **different** config file (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `GEMINI.md`…),
- **acknowledges your rules then ignores them**, especially after context compaction,
- has **no memory** across sessions, and
- can quietly rack up a surprise token bill.

Forge answers each of these with a specific mechanism, not a vibe — see
[ARCHITECTURE.md](ARCHITECTURE.md) for the evidence behind every one.

## Start Here — `forge catalog`

| Layer      | What                                                 | Examples                                                       |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| **tools**  | model-invoked skills (know-how, on demand)           | `lean` · `reuse-first` · `tech-selector` · `atlas` · `recall`  |
| **crew**   | isolated-context sub-agents                          | `scout` · `verifier` · `frontend-verifier`                     |
| **guards** | deterministic hooks — the only layer that _enforces_ | `protect-paths` · `cost-budget` · `lean-guard` · `recall-load` |

Run `forge catalog` for the full list with a one-line _why_ per item.

## The one idea that matters

**Rules the model can drift from live in prose; rules it must never break live in
guards.** A guard is a shell hook — it runs regardless of what the model
"remembers." So Forge demotes enforceable invariants (don't touch `.env`, watch
the token budget, keep diffs small) out of `CLAUDE.md` prose and into guards, and
keeps the prose thin and single-sourced. Guards _reduce_ the "ignored my rules"
problem to the semantic rules that genuinely can't be a hook — and says so plainly.

## Forge Cortex — self-correcting project memory

An LLM is stateless: it relearns your repo every session and repeats the correction you
gave it last week. **Cortex** is the layer that fixes that. It watches for a _genuine_
recurring mistake on this repo — a test that failed then passed after edits, a `git revert`,
repeated edits to the same symbol, an explicit "undo" — distills a durable lesson, and
re-confirms it against fresh outcomes. Next time you touch that file, the lesson is there.

What keeps it trustworthy (this is the hard part, and it's built in):

- **Injection is never confirmation.** Only independent outcomes (tests, builds, a human)
  move a lesson's confidence — it can't grade its own homework.
- **A green build / human reversal always wins.** A mistake is a bad _outcome_, not
  "differs from a lesson"; change your mind and the lesson retires instead of fighting you.
- **A wrong lesson decays out.** Confidence is a time-decayed `Beta` posterior; unconfirmed
  or contradicted lessons quarantine, then retire. It can't ossify.
- **Advisory, never blocking.** The hooks are fail-safe by construction — worst case, they
  do nothing.

On **Claude Code** it's fully ambient (hooks). Other tools read the lessons from `AGENTS.md`
and a zero-dependency MCP server (`forge cortex-mcp`). Everything lives in `.forge/lessons/`
— git-committable and auditable. Try it: `node examples/cortex-demo.mjs`.

## Forge Cognitive Substrate — the check that runs before every edit

A frozen model can't remember, can't foresee, and can't see what an edit will break. The
**cognitive substrate** supplies those faculties from the outside: a fast, mostly-deterministic
check (no extra LLM call) that runs _before_ the agent touches code. One command does it all:

```bash
forge substrate "Change verifyToken in src/auth.js to require length > 20; update tests"
```

It returns, in one contract: the **assumption gate** (is the task clear enough to start?),
the cheapest **capable model**, the predicted **blast radius** (which files an edit breaks),
**scope** clusters (what to split into separate sessions), relevant **Cortex lessons**,
**minimality** warnings, and a **verification** checklist.

**It runs itself.** In Claude Code a `UserPromptSubmit` hook fires the substrate on every
prompt and adds a short advisory only when something needs attention — never blocking, never
nagging on a clean task. Other tools (Codex, Cursor, Gemini, Aider…) get a rule in their
config telling the agent to run it, plus the MCP tools `substrate_check`, `assumption_gate`,
`predict_impact`, `route_task`, and `scope_files`.

Each check is also its own command:

| Command                       | Answers                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `forge preflight "<task>"`    | Is this clear enough to start? (flags unknown names + vague words) |
| `forge route "<task>"`        | Cheapest capable model — Haiku → Sonnet → Opus → Fable             |
| `forge impact <symbol\|file>` | What will this edit break? (reverse-dependency blast radius)       |
| `forge scope <file…>`         | Independent vs. coupled files → separate sessions                  |
| `forge uicheck <fg> <bg>`     | Exact WCAG contrast math for UI work                               |

Deterministic checks (repo grounding, graph traversal, routing arithmetic) are **asserted**;
model fit, minimality, and memory relevance stay **advisory**. Everything is advisory overall
and never blocks — tests and human corrections always win.

**→ Full guide with worked examples, auto-use setup, and how to extend it:
[`docs/cognitive-substrate/`](docs/cognitive-substrate/)** (also holds the white paper,
evidence map, and ecosystem map).

## Commands

```
forge init        emit this repo's config for every tool (one command)
forge sync        recompile source/ → each tool's native files (idempotent)
forge doctor      pass/fail health check (layers, install, drift, cortex)
forge catalog     Start-Here index of every tool/crew/guard
forge cortex      self-correcting memory — status / why <symbol>
forge substrate   full pre-action cognitive-substrate check
forge impact      predict blast radius for a symbol or file
forge preflight   assumption check — what a task names that the repo doesn't define
forge route       cheapest capable model for a task (+ gateway config)
forge scope       decompose files into independent clusters
forge uicheck     deterministic WCAG contrast check
forge atlas       build/query the code-graph (where-is-X, has-symbol)
forge recall      cross-session memory (list/add/consolidate)
forge brand       show the brand token map
```

## What's honest about it

- **Guards reduce, don't eliminate**, the "ignored my rules" problem — semantic
  rules still live in prose and can still be missed.
- **`recall` is file + prompt memory**, not weight-level learning. No RL, no
  fine-tuning. Consolidation is deterministic (exact-dupe prune), not a model call.
- **`atlas` v1 indexes symbol definitions + membership**, not a full call graph.
  It flags likely-hallucinated symbols; it does not certify correctness.
- **Cortex is new and unproven on your repo.** The signal thresholds are hand-tuned and the
  learned predictor starts with zero data — it holds itself to the heuristic until it earns
  more. It's advisory memory, not a guarantee; judge it after a couple of weeks of real use.

## Layout

One tree, three front doors — `install.sh`, the plugin manifest, and the npm bin
all point at `global/` and `source/` (no duplication). See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full map, and [ONBOARDING.md](ONBOARDING.md)
to get productive in five minutes.

## Community & support

- **Get help / ask questions** → [SUPPORT.md](./SUPPORT.md) · [Discussions](https://github.com/CodeWithJuber/forgekit/discussions)
- **Contribute** → [CONTRIBUTING.md](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)
- **Direction & decisions** → [ROADMAP.md](./ROADMAP.md) · [GOVERNANCE.md](./GOVERNANCE.md)
- **Security** → [SECURITY.md](./SECURITY.md) (report privately) · **Accessibility** → [ACCESSIBILITY.md](./ACCESSIBILITY.md)

## Rebranding

The name lives in one place: `brand.json` (`FORGE_BRAND`). Change it there (plus the
`bin` key in `package.json` and `name` in `.claude-plugin/plugin.json`) and the whole
CLI, banner, and emitted headers follow.

MIT licensed.
