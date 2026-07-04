# AGENTS.md — <project>

Cross-tool rules (read by Codex, Cursor, Copilot, Gemini, Aider, Zed, and by
Claude Code when CLAUDE.md points here). Keep tool-agnostic and thin.

## Stack
<!-- e.g. Next.js 16 (App Router) · TypeScript · Node · Postgres+pgvector · OpenRouter -->

## Commands
- Install: `npm ci`
- Dev: `npm run dev`
- Test / typecheck / lint: `npm test` · `npm run typecheck` · `npm run lint`
- Build: `npm run build`
- DB migrate: `<command>`

## Rules
- Reuse existing components/utils before writing new; smallest change that works.
- Verify the current best library from live sources before adding a dependency;
  prefer what the project already uses.
- Wrap fallible async in try/catch; guard array/object access; explicit errors.
- UI: build + check mobile AND desktop; clear loading/empty/error states; follow
  `DESIGN.md` if present.
- Verify before "done": run tests/build/lint and show output; screenshot UI.
- Never commit secrets or `.env*`; never run destructive DB/FS commands without
  confirmation.

## References
- Visual rules: @DESIGN.md (if present)
