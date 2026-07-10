# forgekit — contributor instructions

## Stack
- Node.js >=20, pure ESM (`"type": "module"`), zero runtime dependencies.
- Linter/formatter: Biome 2.5.2 (dev dependency).
- Types: TypeScript via JSDoc annotations — no `.ts` files, checked by `tsc`.

## Commands
- Install: `npm ci`
- Test: `npm test` (node:test, 471+ tests)
- Lint + format: `npx biome check` (or `npm run check`)
- Typecheck: `npm run typecheck`
- Build pages: `npm run pages:build`

## Rules
- **Zero runtime dependencies** — CI enforces this. Everything uses Node.js built-ins.
- ESM only — use `import`, never `require`.
- Match existing patterns: dynamic `await import()` for optional modules, brand
  tokens from `src/brand.js` (never hardcode "Forge"/"forge"), `BRAND.root` for
  package root paths.
- Run `npm test && npx biome check && npm run typecheck && node src/cli.js docs check`
  before committing — the docs check fails CI when commands/env vars/MCP tools/CHANGELOG
  drift from the code, so update docs IN THE SAME CHANGE, not later.
- Version lives in `package.json` — `scripts/bump.mjs` keeps all manifests in sync.
