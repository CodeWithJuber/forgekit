---
name: forge-ledger
description: Evidence-referenced team memory — record decisions with their evidence, query past incidents, blame a claim back to its source. Use when a decision needs a durable record, when "who decided this and why" matters, or before repeating a past mistake.
license: MIT
allowed-tools: Bash, Read
---

# forge-ledger — evidence-referenced memory

## Install

```bash
# from a forgekit checkout, or: npm install -g forgekit
cp -r skills/forge-ledger .claude/skills/
```

Requires the `forge` CLI on PATH.

## When to use

- Recording a decision: *we chose X because of Y* — with Y attached, not remembered.
- Before a risky change: *did this ever bite us?* → `forge ledger query`.
- "Who claimed this and on what evidence?" → `forge ledger blame`.
- A claim turned out wrong → `forge ledger retract` (with a reason — history is append-only).
- Human sign-off on a machine-recorded claim → `forge ledger ratify`.

Don't use it as a notebook for trivia. Do use it for anything a future-you (or a
teammate, or an auditor) will need to trust.

## Commands

```bash
forge ledger stats                    # ledger health: claims, evidence links, staleness
forge ledger query "<text>"           # find claims by content
forge ledger show <id>                # one claim with its evidence
forge ledger blame <id>               # who recorded it, when, from what source
forge ledger at <date>                # what the ledger knew on that date
forge ledger diff <since> [<until>]   # what changed between two points
forge ledger ratify <id>              # human signs off on a claim
forge ledger retract <id> --reason "<why>"   # a claim was wrong — recorded, not erased
forge ledger verify                   # re-check every claim's evidence still holds
forge ledger compact                  # distill without losing provenance
forge ledger merge <path>             # merge another ledger in
forge ledger sync [--remote <name>]   # share with the team
```

Append `--json` for machine-readable output, `--personal` for the personal (non-team) ledger.

## The one rule

**Every claim carries its evidence.** A claim without a source is a rumor with a
database entry. `blame` exists so that six months from now, someone can ask "says
who?" and get an answer — a commit, a log line, a measurement — not a shrug.

See [references/evidence-model.md](references/evidence-model.md) for the claim lifecycle
and [references/subcommands.md](references/subcommands.md) for the full command reference.

## References

- [references/evidence-model.md](references/evidence-model.md) — claims, evidence, ratify/retract lifecycle
- [references/subcommands.md](references/subcommands.md) — every subcommand with examples
