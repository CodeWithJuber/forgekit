# Copilot instructions for forgekit

forgekit is a Node.js CLI (`forge`) + MCP server: reliability infrastructure for AI
coding agents (evidence-linked memory, blast-radius analysis, guardrails, cost
governance). Zero runtime dependencies — `package.json` must keep `dependencies: {}`
(the quality gate asserts this; `npm pack --dry-run` is part of CI).

## Non-negotiable gates (all run in CI)

- **Tests:** `npm test` (node:test + vitest suites). New/changed behavior needs tests.
  POSIX-only tests (shell stubs on PATH, symlinked dirs) must `skip` on win32 —
  follow the existing `noTimeoutSkip` convention in `test/guards.test.js`.
- **Lint/format:** `biome check` with the repo's `biome.json` (2-space, lineWidth 100).
  Never run biome without the repo config — defaults silently reformat whole files.
- **Types:** `tsc -p tsconfig.json` (`checkJs` on `src/**`). New JS needs JSDoc
  typedefs. Two checkJs quirks: a JSDoc discriminated union does NOT narrow with
  `!v.ok` — use `v.ok === false`; tuple literals don't infer as tuples — prefer
  small object literals over `[a, b]` pairs.
- **Docs reconciliation:** `test/docs_check.test.js` reconciles the `COMMANDS`
  registry (`src/commands.js`) against README.md, docs/GUIDE.md, mintlify pages and
  CHANGELOG.md. If you add/change a command or flag, update the registry AND every
  doc surface, then run `forge docs render` after any CHANGELOG.md edit (it
  regenerates `mintlify/changelog/overview.mdx`).
- **Docs honesty:** never document a flag/behavior the code doesn't have, and never
  leave code undocumented. Claims in docs/ carry their evidence; deflate, don't
  inflate ("proof-carrying memory is a name, not a formal proof").

## Conventions

- Executable shell files need the git executable bit (100755) — the install-smoke
  CI fails otherwise. Via the Git Data API, blobs default to 100644: set
  `mode: "100755"` explicitly.
- `FORGE_*` env vars are the configuration surface; `src/docs_check.js`
  (`envVarsRead`) flags any `process.env.FORGE_*` read that no doc mentions.
- Releases: the `bump` workflow cuts `v*` tags; `release.yml` publishes to npm
  (with provenance) and cuts the GitHub Release. Never hand-edit versions —
  use the workflow.
- Commit style: short imperative summaries (`fix: …`, `docs: …`); one concern per
  commit; PRs target `master` and merge only with green CI.
