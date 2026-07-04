# Hostlelo — project instructions

Drop this into a Hostlelo repo root. Adds project context on top of the global
`~/.claude/CLAUDE.md`. Keep it lean; prune anything Claude gets right without it.

Shared cross-tool rules (stack, commands, engineering rules) live in **@AGENTS.md**
so Cursor/Codex/Gemini read the same source. This file holds only Claude-specific
+ Hostlelo-specific bits. Keep CLAUDE.md thin; put general rules in AGENTS.md.

## Stack
- Runtime: Node.js. DB: self-hosted Postgres (18+) with **pgvector** on the VPS.
- LLM: routed through **OpenRouter** — never hardcode a single provider; use the
  configured routing/env, and pick cheap models for classify/embed, stronger
  models only for hard generation.
- Delivery surfaces: customer AI **chat widget** (`widget.js`) and **Telegram**
  owner control plane. Infra: Linode VPS + Cloudflare Tunnel/Access.

## Non-negotiables
- **Grounding-first.** Customer-facing answers (esp. prices/plans) must come from
  the verified KB, never guessed. If unverified, say so or defer — do not invent
  numbers, features, or availability.
- **Secrets** live in env / the secrets store, never in code, logs, or commits.
  `.env*` and key files are hook-protected — don't work around it.
- Neutral, worldwide tone in customer replies (no forced regional greeting).

## Workflow
- Prefer readymade, well-maintained OSS libraries/SDKs over hand-rolled code —
  it's faster and cheaper to run. Justify any new dependency briefly.
- Before DB or deploy changes: read the migration/deploy path first; never run
  destructive SQL (`DROP`/`TRUNCATE`) or touch prod without explicit confirmation.
- Verify every change: run the app's tests/typecheck/build and show output.
- Deploy via the `hostlelo-deploy` skill (safe, staged, with rollback notes).

## Commands
<!-- Fill these in from package.json so Claude doesn't guess: -->
- Install: `npm ci`
- Dev: `npm run dev`
- Test / typecheck / lint: `npm test` · `npm run typecheck` · `npm run lint`
- Build: `npm run build`
- DB migrate: `<your migrate command>`
