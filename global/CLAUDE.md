# Global instructions (all projects)

A template for your user-level `~/.claude/CLAUDE.md`. Neither `install.sh` nor the plugin
installs it (that would overwrite yours), so copy in the parts you want. Once there, Claude
Code loads it every session. Keep it short — long files get ignored. Prune ruthlessly.

## Workflow
- Explore → plan → code → verify. For multi-file or unfamiliar changes, use plan mode first. Skip planning for one-line/obvious fixes.
- Never mark work done without a check Claude can run: tests, build exit code, linter, or a diff against expected output. Show the evidence (command + result), don't just assert success.
- Fix root causes, not symptoms. Don't suppress errors to make a check pass.

## Context & cost (balanced)
- Prefer `rg`/`grep` and targeted reads over reading whole files or directories.
- For broad codebase investigation, delegate to the `scout` subagent so exploration doesn't fill main context.
- Use the `verifier` subagent for an independent review of non-trivial diffs.
- Between unrelated tasks, expect a `/clear`. Don't carry stale context forward.

## Code style
- Match the surrounding file's conventions over any personal default.
- Prefer the project's existing libraries; don't add dependencies without reason.
- No comments that restate the code; comment only non-obvious "why".

## Safety
- Never write secrets, tokens, or keys into code or commits. `.env*` and key files are protected by a hook — don't work around it.
- Ask before: force-push, history rewrite, `rm -rf`, dropping DB tables, or touching production.

## Memory
- The `recall` skill records durable, cross-session facts to `$XDG_STATE_HOME/forgekit/recall/` (default `~/.local/state/forgekit/recall/`; `FORGE_HOME` overrides).
- Save only what's non-obvious and lasting (env quirks, decisions, gotchas). Never save secrets or PII.

## Tools
- Use CLI tools when available: `gh` (GitHub), cloud CLIs, etc. — most context-efficient.
- Learn unknown CLIs with `<tool> --help` before guessing flags.
