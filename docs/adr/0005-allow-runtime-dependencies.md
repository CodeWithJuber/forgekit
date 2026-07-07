# ADR 0005: Allow selective runtime dependencies

- Status: accepted (supersedes the blanket rule in ADR-0001)
- Date: 2026-07-07

## Context
ADR-0001 committed the CLI to zero production dependencies, sized for a config emitter
plus advisory gates. Substrate v2 (docs/plans/substrate-v2/) adds capabilities where the
stdlib ceiling has real costs: AST-accurate impact analysis (TypeScript compiler API),
higher-recall semantic matching for the reuse cache and retrieval (embedding backends),
fast ledger indexing at monorepo scale (SQLite), and the UI visual loop (Playwright).
Writing these from scratch would be reinventing mature tools — the exact waste
ARCHITECTURE.md's reuse ledger forbids. Meanwhile the symlink install channel that
motivated ADR-0001 still exists and must not break.

## Decision
Runtime dependencies are permitted under four conditions, each enforced in review:

1. **Core stays stdlib.** Every substrate feature has a pure-JS/stdlib reference path
   (MinHash instead of embeddings, JSON-file scan instead of SQLite, regex atlas tier
   instead of AST). Dependencies buy *better*, never *at all*.
2. **Graceful absence.** A missing optional dependency degrades to the stdlib path with
   a `forge doctor` note — never a crash. The symlink/plugin channels ship the stdlib
   paths and remain dependency-free.
3. **Named tiers.** `dependencies` stays empty; enhancements live in
   `optionalDependencies` or documented opt-in installs, each mapped to the feature it
   unlocks.
4. **Vetting.** Each new dependency passes `forge scan`-grade review (provenance,
   install scripts, transitive count) and is recorded in the reuse ledger with its
   rationale.

## Consequences
- (+) AST-tier atlas, embedding retrieval, SQLite indexes, and the Playwright visual
  loop become buildable without forking the architecture.
- (+) The zero-dep guarantee survives where it matters (plugin/symlink channels, `npx`
  cold start) because it is now a per-path property, not a package-wide one.
- (−) Two code paths per enhanced feature — the fallback must be tested as a first-class
  path (CI runs the suite with optional deps absent *and* present).
- (−) Supply-chain surface grows; bounded by conditions 3–4.
- CI's "dependencies is empty" assertion is kept; a new assertion checks every
  optionalDependency has a registered fallback test.
