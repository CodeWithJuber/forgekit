# ADR 0001: Zero runtime dependencies

- Status: accepted
- Date: 2026-07-05

## Context
forgekit installs three ways (Claude plugin, `install.sh` symlink, npm). The installer
symlinks files without running `npm install`, so any runtime dependency would break that
channel. Supply-chain risk also scales with dependency count.

## Decision
The CLI ships **zero production dependencies** — everything uses the Node stdlib. Dev
dependencies (Biome, test tooling) are allowed. CI asserts `dependencies` is empty.

## Consequences
- (+) The same code runs across all three install channels; tiny attack surface; instant `npx`.
- (−) We occasionally write a few lines instead of pulling a package (arg parsing, a YAML
  block writer). Accepted — the constraint is a feature, not a limitation.
