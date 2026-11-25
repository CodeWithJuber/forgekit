---
name: forge-verify
description: Run forgekit's turn-commit-PR verification-gate lattice before you commit or push. Use when starting a task (preflight), staging a commit (precommit), or opening a PR (verify) — never push without verify + precommit green.
license: MIT
allowed-tools: Bash, Read
---

# forge-verify — the pre-push verification gate

## Install

With the packaged CLI installed, run `forge skills install forge-verify --host codex` in the target project. Choose `claude`, `copilot`, `cursor`, `gemini`, `opencode` or `portable` for another destination. Use `forge skills show forge-verify` to inspect the playbook without installation.

To copy the instructions from a ForgeKit checkout by hand, run `mkdir -p .claude/skills && cp -r skills/forge-verify .claude/skills/` or copy the same folder to your host's project skill directory. The bound command requires the ForgeKit CLI.

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
