## What & why

<!-- what changes, and the problem it solves -->

## Checklist
- [ ] `npm test` passes (Node 18/20/22)
- [ ] `npm run check` passes (Biome lint + format)
- [ ] New public functions have a test
- [ ] Conventional commit message (`feat:`/`fix:`/`docs:` …)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] No new runtime dependency (dev deps ok)
- [ ] Substrate/docs updated if this changes `forge substrate`, `forge impact`, router/gate, or MCP substrate tools

## Risk & rollback
- Risk level: low / medium / high
- Rollback plan: <how to revert if this breaks>

## Extra checks (tick if applicable)
- [ ] `npm run typecheck` passes
- [ ] Input validated at boundaries; errors handled (no swallowing)
- [ ] Authorization/ownership checked (if it touches access)
- [ ] Logs contain no secrets/PII
- [ ] If AI-assisted: I understand it, verified the package APIs, and it has tests
