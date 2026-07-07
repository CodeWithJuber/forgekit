---
name: reuse-first
description: Engineering standards for writing production code — reuse before building, follow existing patterns, testable/reusable design, and verify. Use for any non-trivial feature, refactor, or "add X" task, and when choosing what to build vs. adopt.
---

# Reuse-first engineering

Default to reusing and following what exists. New code is a liability; the best
change is the smallest one that fits the codebase.

## 1. Reuse before building
- **Ask the proof-carrying cache first**: `forge reuse query "<what you're about to
  build>"`. A hit is code this team already generated AND verified — its test/accept
  evidence travels with it (`forge ledger blame <id>` shows why to trust it):
  - **EXACT / NEAR hit** → use that artifact; do not regenerate.
  - **ADAPT hit** → read it, start from it, generate only the delta.
  - **miss** → build it, then `forge reuse mint "<spec>" --file <path> --ref <test-run>`
    so the next teammate (or session) gets the hit.
- Search the repo next (`grep`/`glob`/serena LSP): is there an existing util,
  component, hook, service, or pattern that already does this? Extend it.
- If not in-repo, is there a maintained library? Vet it with `tech-selector`
  (current best from Context7 + web + GitHub health) before adding a dependency.
- Only write from scratch when reuse genuinely doesn't fit — and say why.

## 2. Follow the codebase's patterns
- Match the existing architecture and idioms over any personal preference or
  textbook pattern. Consistency beats cleverness.
- Apply a design pattern only when it removes real duplication or coupling — not
  for its own sake. Prefer composition over inheritance; keep modules cohesive and
  loosely coupled; push side effects to the edges.

## 3. Design for reuse + testability
- Small, single-purpose functions with typed inputs/outputs. Separate pure logic
  from I/O so the logic is testable without mocks.
- No hidden globals; pass dependencies in. Name things for intent.

## 4. Test
- Write tests with the code, not after. Unit-test the pure logic; cover the edge
  cases the task named (empty, error, boundary). Prefer real inputs over heavy
  mocking.
- For a bug fix, first write a failing test that reproduces it, then fix.

## 5. Verify (don't assert "done")
- Run the project's tests + typecheck + lint and show the output. UI → screenshot
  check via `ui-workflow`. Non-trivial diff → `verifier` subagent.
- Fix root causes; never suppress an error to make a check pass.

## Per-stack starting points (verify currency with `tech-selector` before adopting)
The dated verified baseline lives in `~/.claude/rules/stack-notes.md` (refresh via
`/dev-radar`). Quick defaults below — treat as candidates, confirm live per use case:
- **Web app**: Next.js (App Router) / React; SvelteKit or Astro for content-led.
- **Styling/UI**: Tailwind + shadcn/ui (Radix) — pull real component code via the
  shadcn MCP, don't hand-roll.
- **Data/state**: TanStack Query for server state; Zustand for light client state.
- **Forms/validation**: React Hook Form + Zod (Zod schemas shared client↔server).
- **DB/ORM (Node + Postgres/pgvector)**: Drizzle or Prisma; raw SQL for hot paths.
- **Auth**: the framework's first-party option or a maintained provider — don't
  roll your own crypto/session logic.
- **Testing**: Vitest (unit) + Playwright (e2e) for JS; pytest for Python.
- **Python**: `uv` for env/deps, `ruff` (lint+format), `pydantic` for schemas.
- **Deploy**: match the project (Vercel for Next.js; your VPS + Cloudflare for
  Hostlelo services).
Never present these as settled because they were popular at training time — run
`tech-selector` and cite the version + date.
