# Global Claude Code config

A balanced, low-overhead Claude Code setup, grounded in Anthropic's
[best-practices](https://code.claude.com/docs/en/best-practices) +
[prompt-caching](https://code.claude.com/docs/en/prompt-caching) docs and a
cross-checked survey of community benchmarks (see `RESEARCH-claude-config.md`).

Everything here is **additive** — it never overwrites your existing CLAUDE.md,
settings.json, memory, or rules. `install.sh` backs up any file it would replace.
See `RUN.md` for the full command sheet and `PLAYBOOK.md` for how to use it.

## Install
```bash
cd claude-global-config && bash install.sh
```
Copies the whitelisted items in `global/` into `~/.claude/` and makes the
`bin/` scripts available as commands (via `~/.local/bin`).

## What's in it

**Skills** (`~/.claude/skills/`, load on demand)
- `tech-selector` — pick the current best library from live sources (Context7 + web + GitHub health), not training data.
- `reuse-first` — reuse before building; patterns, testability, testing, verify; per-stack cheatsheet → `rules/stack-notes.md`.
- `ui-workflow` — one visual direction + shadcn MCP + screenshot-verify.
- `design-md` — per-project `DESIGN.md` convention + template.
- `dev-radar` — on-demand current-dev signal (GitHub trending, Reddit, papers, blogs), hype-filtered, cited.
- `code-modernization` — incremental legacy migration with a regression safety net.
- `cost-guard` — low-cost/high-performance playbook + prompt-cache hygiene.
- `explore-plan-code` — the four-phase workflow for non-trivial changes.
- `self-improve` — in-session self-correction + cross-session lesson capture.

**Agents** (`~/.claude/agents/`, isolated context)
- `scout` (haiku) — cheap read-only codebase exploration.
- `verifier` (sonnet) — independent diff review.
- `frontend-verifier` (sonnet) — screenshots UI at desktop+mobile, checks a11y.

**Rules** (`~/.claude/rules/`)
- `tech-currency` — verify current best tools from live sources.
- `stack-notes` — dated verified stack baseline (refresh with `/dev-radar`).
- `self-correction` — verify-fix loop + learn-from-correction.

**Hooks** (`~/.claude/hooks/`)
- `protect-paths` (PreToolUse) — blocks writes to `.env`/keys/secrets + destructive cmds.
- `format-on-edit` (PostToolUse) — auto-formats edited files (no model tokens).
- `learn-session` (Stop) — **opt-in** end-of-session learner (Haiku), off until `ENABLE_SESSION_LEARNING=1`.

**Status line** (`statusline.sh`) — `dir · branch · model · $cost · +/-lines · ⚡cache%`.

**Commands** (`~/.local/bin/`)
- `claude-init` — scaffold per-repo `AGENTS.md` + thin `CLAUDE.md` (auto-detects stack).
- `claude-taste [name]` — enable ONE UI taste skill for the current repo (list with no arg).
- `claude-learn-consolidate` — merge/dedupe/prune accumulated learned lessons (weekly).

## Installed separately (their own installers, already done live)
- **Graphify** (`uv tool install graphifyy` → `graphify install`) — queryable code+schema+infra graph; `/graphify .`, `graphify hook install` for self-updating. ~71× fewer tokens than reading files.
- **Ponytail** (`claude plugin marketplace add DietrichGebert/ponytail` → `install`) — benchmarked minimalism enforcer (`/ponytail`, `/ponytail-review`). ~983 tok always-on, net cheaper.

## Layers
- **Global** — the above, in `~/.claude/`.
- **Project** — `hostlelo-project-layer/` is the drop-in template (`AGENTS.md` + thin `CLAUDE.md` + deploy skill). `claude-init` generates this for any repo.

## Docs in this bundle
- `RUN.md` — full command sheet + what's applied vs. pending.
- `PLAYBOOK.md` — how to drive it per situation (new project, bug, security, testing, UI…).
- `RECONCILE.md` — the original live-machine audit.
- `RESEARCH-claude-config.md` — cited research on best configs + gaps.

## Reversibility
Restore `~/.claude/settings.backup.*.json`, `mv ~/.claude/skills-archive/* ~/.claude/skills/`, re-add pruned allow-entries from `~/.claude/allow-pruned-*.json`, or re-enable a plugin in `enabledPlugins`.
```
Recommended CLIs (present): uv, node, jq, gh, ripgrep, graphify.
```
