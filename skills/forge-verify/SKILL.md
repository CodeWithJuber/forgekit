---
name: forge-verify
description: Run forgekit's turn-commit-PR verification-gate lattice before you commit or push. Use when starting a task (preflight), staging a commit (precommit), or opening a PR (verify) — never push without verify + precommit green.
license: MIT
allowed-tools: Bash, Read
---

# forge-verify — the pre-push verification gate

## Install

```bash
# from a forgekit checkout, or: npm install -g forgekit
# then copy the skill into your project (or ~/.claude/skills for global use):
cp -r skills/forge-verify .claude/skills/
```

Requires the `forge` CLI on PATH (`npm install -g forgekit`, or `node <checkout>/src/cli.js`).

## When to use

- **Starting any coding task** → run `forge preflight` first.
- **About to `git commit`** → run `forge precommit` first.
- **About to `git push` or open a PR** → run `forge verify` first.
- CI failed and you want the same checks locally before pushing again.

## The lattice

```
task start            commit                    push / PR
    │                   │                           │
    ▼                   ▼                           ▼
forge preflight → forge precommit ──green──→ forge verify ──green──→ push
```

Each gate is independent and evidence-producing: it prints what it checked and what
failed, so a red gate tells you exactly what to fix. See [references/gate-lattice.md](references/gate-lattice.md)
for the full turn ⊂ commit ⊂ PR model.

## Commands

```bash
forge preflight     # assumption check: what the task names that the repo doesn't define
forge precommit     # commit-level gate: staged code w/o docs + secret scan
forge verify        # independent verification: tests + hallucinated-symbol + provenance
forge verify --deep # multi-lens consensus (slower, for risky changes)
```

`FORGE_COMMIT_GATE=block|warn|0` tunes how hard `precommit` fails (default: warn).

## Rules

1. **Never push without `forge verify` + `forge precommit` passing.** That is the whole point.
2. A red gate is a finding, not a suggestion — fix the code, don't argue with the gate.
3. If a gate fails intermittently, re-run it once before investigating (flakes happen);
   if it fails twice, it's real.
4. `--deep` is for risky changes (security, migrations, public API). Routine edits use
   the default gate.

## References

- [references/gate-lattice.md](references/gate-lattice.md) — the turn ⊂ commit ⊂ PR model
- [references/what-verify-checks.md](references/what-verify-checks.md) — what each gate actually runs
