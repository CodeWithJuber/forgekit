# forgekit — contributor instructions

## Stack

- Node.js >=20, pure ESM (`"type": "module"`), zero runtime dependencies.
- Linter/formatter: Biome 2.6.3 (dev dependency; `npx biome migrate --write` after an upgrade).
- Types: TypeScript via JSDoc annotations — no `.ts` files, checked by `tsc`.

## Commands

- Install: `npm ci`
- Test: `npm test` (node:test, 1000+ tests)
- Lint + format: `npm run check` (the npx package is `@biomejs/biome`, not `biome`)
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
- Changelog entries go in a NEW file `changelog.d/<branch>.md` (Keep a Changelog sections:
  `### Added`, `### Fixed`, …), never under `[Unreleased]` in `CHANGELOG.md` — the docs check
  refuses that, and one file per change is what keeps open PRs from conflicting. The release
  script folds the files into `CHANGELOG.md`.
- After editing commands/MCP tools (or a released `CHANGELOG.md` section), run
  `node src/cli.js docs render`: it regenerates the machine-owned blocks, including the
  Mintlify changelog page (`mintlify/changelog/overview.mdx`), which the docs check fails on
  when stale. Never edit between `forge:render` markers by hand.
- Version lives in `package.json` — `scripts/bump.mjs` keeps all manifests in sync.
