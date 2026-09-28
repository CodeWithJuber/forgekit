# Examples

Short, copy-pasteable walkthroughs. forgekit is one brain for every AI coding agent — the
cognitive substrate (memory, foresight, guardrails) that a stateless model is missing. These
examples show that brain doing its job: gating an edit before it happens, and carrying what
your team learns from one machine to the next.

## 1. First run — install, scaffold, see the gate

Install the CLI, scaffold config for the tools this repo uses from one source, and health-check the setup:

```bash
npm i -g @codewithjuber/forgekit
forge init          # emit native config for Claude + the tools this repo uses (--tools all: every tool)
forge doctor        # health-check tools, guards, MCP, and drift
```

Now ask the substrate to look at a change *before* any model edits code. `forge substrate` is
the one pre-action gate — it runs assumptions, routing, blast-radius impact, scope, reuse,
context, and memory in a single pass and returns a verdict:

```bash
forge substrate "add rate limiting to the login route"
```

By default the verdict is advisory (it tells you what's underspecified or what the edit is
predicted to touch). Set `FORGE_ENFORCE=1` to make it a hard block on the strongest signals —
a vacuous prompt, un-assemblable context, or a blast radius over threshold:

```bash
FORGE_ENFORCE=1 forge substrate "add rate limiting to the login route"
```

## 2. Team memory — learn once, share via git

The ledger is proof-carrying memory: every fact and lesson is a claim that carries its own
evidence, git-committable and conflict-free to merge. Record a durable fact, check the store,
then fold in a teammate's ledger after a pull:

```bash
forge remember "login-rate-limit" "auth uses a sliding-window limiter in src/mw/rate.js"
forge ledger stats                     # what's in the store, and its confidence

git pull                               # pick up a teammate's committed ledger
forge ledger merge .forge/ledger       # union-merge their claims into your view
```

Because git *is* the sync, there's no server: knowledge one teammate earned reaches everyone
else's model on the next pull.

## Per-repo rule override

[`rules.override.json`](./rules.override.json) shows a project adding its own rules on top of
forgekit's shared source. Copy it to `.forge/rules.json` in your repo, then run `forge sync` —
the extra rules reach every emitted tool's config (AGENTS.md, CLAUDE.md, Cursor, Gemini, …).

## Cortex demo

[`cortex-demo.mjs`](./cortex-demo.mjs) is a runnable script that walks the self-correcting
learned-lessons loop (`forge cortex`) — how a lesson earns confidence from independent oracles
and decays out when it stops holding up.

## Pain-point solutions

Each pain point Forge solves gets a self-contained example: a scenario you run
in a scratch directory, with the exact commands and what to look at. New
solutions ship with a new example — one pain point per release.

| Example | Pain point | What it shows |
|---|---|---|
| [cost-governance](cost-governance/) | runaway agent spend | per-task budgets, spend alerts, the `--hard` circuit breaker |
| [adversarial-doctor](adversarial-doctor/) | guardrails you can't trust | `forge doctor --adversarial` fuzzes Forge's own hooks |

Conventions every example follows:

- works in a scratch dir (`mktemp -d`) — nothing touches your real setup
- `README.md` has copy-paste steps; `demo.sh` is the same steps as a script
- `demo.gif` is rendered from captured real CLI output
  (`scripts/make-*.py`) into `mintlify/images/` and linked from the example —
  never hand-drawn

To add one, copy [`_template/`](_template/) and fill in the blanks.
