# Examples

Short, copy-pasteable walkthroughs. forgekit is one brain for every AI coding agent — the
cognitive substrate (memory, foresight, guardrails) that a stateless model is missing. These
examples show that brain doing its job: gating an edit before it happens, and carrying what
your team learns from one machine to the next.

## 1. First run — install, scaffold, see the gate

Install the CLI, scaffold configs for every tool from one source, and health-check the setup:

```bash
npm i -g @codewithjuber/forgekit
forge init          # emit every tool's native config from one source
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
the extra rules are appended to every tool's config (AGENTS.md, CLAUDE.md, Cursor, Gemini, …).

## Cortex demo

[`cortex-demo.mjs`](./cortex-demo.mjs) is a runnable script that walks the self-correcting
learned-lessons loop (`forge cortex`) — how a lesson earns confidence from independent oracles
and decays out when it stops holding up.
