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

```bash
# clone, then:
bash install.sh          # symlinks into ~/.forge + ~/.claude, puts `forge` on PATH
forge init               # in any repo: emit every tool's config from one source
forge doctor             # verify everything is wired
```

Prefer a plugin? `/plugin marketplace add <this-repo>` then `/plugin install forgekit`.
Prefer npm? `npx forgekit init`. All three channels drive the **same** `global/` tree.

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

## Commands

```
forge init        emit this repo's config for every tool (one command)
forge sync        recompile source/ → each tool's native files (idempotent)
forge doctor      pass/fail health check (layers, install, drift, cortex)
forge catalog     Start-Here index of every tool/crew/guard
forge cortex      self-correcting memory — status / why <symbol>
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
