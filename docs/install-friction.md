# Install friction — head-to-head measurement

**Date:** 2026-10-14 · **Method:** cold `npm i -g` (cache cleared with
`npm cache clean --force` before each run), `--no-audit --no-fund`,
measured on the same Linux VM minutes apart. Wall time from npm's own
"added N packages in Xs" line, cross-checked with `time`. Disk size via
`du -sh` on the installed package dir. No invented numbers.

## Results

| Tool                        | Version | Install time | Installed size | npm packages          | Tarball unpacked |
| --------------------------- | ------- | ------------ | -------------- | --------------------- | ---------------- |
| `@codewithjuber/forgekit`   | 1.12.4  | **3s**       | **3.2M**       | 1 (zero runtime deps) | 2.8M             |
| `@anthropic-ai/claude-code` | 2.1.296 | 36s          | 246M           | 2                     | 0.2M¹            |
| `@openai/codex`             | 0.162.1 | 48s          | 432M           | 2                     | 0.01M¹           |

¹ The tarballs are tiny because both CLIs download platform-native
binaries at install time — that is where the 36–48s and the hundreds of
MB go. forgekit ships pure JS (zero runtime dependencies), so what you
download is what you get.

## Steps to first command

| Tool        | Commands to a working CLI                                                               |
| ----------- | --------------------------------------------------------------------------------------- |
| forgekit    | `npm i -g @codewithjuber/forgekit` → `forge --version` (2 steps)                        |
| claude-code | `npm i -g @anthropic-ai/claude-code` → auth/login → `claude --version` (3 steps + auth) |
| codex       | `npm i -g @openai/codex` → auth/login → `codex --version` (3 steps + auth)              |

forgekit needs no account, no API key, and no login to run its local
commands (`verify`, `impact`, `doctor`, …). The two comparables require
authentication before they do anything useful.

## Takeaway

Install friction is a genuine forgekit advantage, not a claim: **12–16×
faster install, 77–135× smaller on disk, zero dependencies, no auth
gate.** This is the "zero runtime deps" architecture paying off in the
one place every new user feels first. Keep it that way — any future
dependency must justify itself against this table.
