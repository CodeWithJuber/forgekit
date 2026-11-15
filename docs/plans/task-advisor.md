# Task-aware discovery and typed decisions

## Contract

Developers receive task-fit skills, plugins, tools and hooks in `forge evidence`,
`forge develop` and prompt/failure hook context. `forge discover find "<task>"`
performs a fresh lookup. Recommendations name the observed source, lookup time,
maintenance/license unknowns, fit reasons and setup path. "Best" means best among
the returned, relevant candidates, not an exhaustive market claim.

Reuse the existing GitHub/npm/Stack Overflow and Google (Serper)/Brave transports,
cache and adoption catalog. Public searches receive closed-vocabulary task/stack
terms; only an independently supplied `--web` query sends free-form public text.
Retrieved text is evidence, never commands. Discovery does not install anything.
Only reviewed adoption entries can offer Forge's existing install command.

`forge discover setup` saves private preferences for this workspace; `--global`
provides defaults to every repository. Workspace overrides beat global defaults,
explicit call/environment settings beat saved preferences. `reset` restores
inheritance. Keys stay in environment variables. Status reports readiness without
printing credentials. Existing offline and automatic-research switches still work.

The shared decision boundary reuses `src/jev.js` and TypeSafe `/v1/systemone`.
Routing and preflight retain their deterministic reconciliation. New choices for
recommendation ranking, planning focus and debugging next steps use bounded,
application-owned IDs and sanitized signals. Unknown choices, low confidence,
timeouts, unavailable credentials and malformed responses keep deterministic
advice. Model suggestions never mark tests passed or cancel thrash escalation.

## Implementation order

1. Private global/workspace settings and a shared typed-decision boundary.
2. Live candidate discovery, evidence-based ranking and bounded hook delivery.
3. Planning/debugging advice plus routing/preflight configuration integration.
4. CLI setup/status/find, user documentation and generated command references.

## Verification

- Node's existing test runner: configuration precedence, repo isolation, malformed
  settings, opt-out, unavailable credentials and invalid/low-confidence choices.
- Discovery fixtures: task relevance over popularity, all four artifact kinds,
  stale/unknown metadata, deduplication, closed-vocabulary privacy, fresh/cache
  behavior, provider failures, no remote command execution and bounded delivery.
- Existing Jev, evidence, development, diagnosis, routing and hook regressions.
- `npm test`, `npm run typecheck`, `npm run check`, `node src/cli.js docs check`
  and `git diff --check`.
- Live public-search smoke test; authenticated TypeSafe/Google checks require
  available credentials and must be reported separately from fixture evidence.

## Boundaries and conventions

Zero runtime dependencies; ESM JavaScript in `src/`, Node tests in `test/`,
JSDoc at public function boundaries, Biome formatting. Existing conventions:
`choice("Pick one", { reproduce: "Capture the failing case", inspect: "Read callers" })`.
Always preserve verification/approval semantics and secret filtering. Ask before
new dependencies or an installation. Never store secrets or execute retrieved text.

## Verification result (2026-11-15)

- Full Node suite after syncing master: 2,345 passed, 7 skipped, 0 failed, using Node 26.13.0 with its
  paired npm installation. Homebrew's default executable location lacks npm at
  the path the existing adoption resolver expects; Node 20.13.1 also lacks
  `process.getBuiltinModule`, used by an existing test.
- Typecheck, Biome, docs consistency, diff whitespace and package inclusion checks
  passed. Biome retains existing informational/style findings.
- Live GitHub/npm discovery and reviewed Playwright release resolution succeeded.
  Ranking regressions cover incidental testing mentions, unrelated security tools,
  and retaining component libraries for UI implementation.
- Authenticated TypeSafe, Serper and Brave acceptance remains unverified because
  credentials were unavailable. Typed choices and provider fallbacks have fixture
  coverage; that is separate from live authenticated evidence.
- Documentation sweep reviewed: CLI/setup guidance and current Jev claims were
  updated. Remaining matches are existing file links, generic identifiers such as
  `examples`, unchanged routing/secret-detection contracts, and dated benchmark,
  audit or roadmap records. Historical measurements were not rerun or relabeled.
