# Contributing to forgekit

Thanks for your interest. forgekit stays small and dependency-free — please read
this before opening a PR.

## Ground rules

- **Zero runtime dependencies.** forgekit ships with no production `dependencies`.
  PRs adding one are rejected unless there's an exceptional, discussed reason. Dev
  dependencies (test/lint tooling) are fine.
- **Node.js ESM only.** All code is ES modules (`"type": "module"`). No CommonJS.
- **Supported Node versions:** 18, 20, 22.
- **Cross-tool first.** New behavior should work across the tools forgekit targets
  (Claude Code, Codex, Cursor, Gemini, Aider, …), emitted from one source — not
  Claude-only. Say so in the PR if a piece is unavoidably tool-specific.

## Getting started

```bash
git clone https://github.com/CodeWithJuber/forgekit.git
cd forgekit
npm ci
npm test          # node --test
npm run check     # Biome lint + format check
```

## Making changes

1. Branch: `git checkout -b feat/my-change`.
2. Write the change **plus tests** — every new public function needs at least one
   test. Shell guards are tested via `spawnSync` (see `test/guards.test.js`).
3. Run `npm test` and `npm run check:fix` before committing.
4. Use [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(scope): description`, `fix: …`, `docs: …`.
5. Add a line to `CHANGELOG.md` under `## [Unreleased]`.
6. Open a PR. CI (tests on Node 18/20/22, Biome, shellcheck) must pass.

## Project shape

- `src/` — the zero-dep CLI + emitters + subsystems (verify, brain, atlas, …).
- `source/` — the single rule + MCP source that `forge sync` compiles.
- `global/` — what installs into `~/.forge`: `tools/` (skills), `crew/` (agents),
  `guards/` (hooks).
- `test/` — `node --test` suites.

By contributing you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
