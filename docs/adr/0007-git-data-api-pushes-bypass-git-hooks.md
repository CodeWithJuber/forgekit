# ADR 0007: Pushes via the Git Data API bypass git hooks — gate the push path, not just the commit path

- Status: accepted
- Date: 2026-10-11

## Context

`forge harden` installs a pre-commit hook (`commit_gate.js`) that runs gitleaks plus
`forge precommit` before a commit is created. Pre-push hooks installed the same way
guard `git push`. Both assume the push travels through a local git client.

Automation increasingly pushes through the GitHub Git Data API instead (trees, commits,
and ref updates created server-side): the API writes objects directly to the remote, so
no local hook ever executes — pre-commit, pre-push, and any client-side gate are all
skipped silently. This was learned the hard way: repeated CI failures (format drift,
lint, unpushed test files) were all code pushed via the Git Data API, where CI was the
first gate that ever ran.

## Decision

The in-path gate for API-driven pushes is pre-push verification run by the push script
itself, before any Git Data API write: format:check + eslint + lint:reach + typecheck
on the changed files, then the impacted tests (or the full suite when trigger files
changed). The workspace's `push_gate.py` is the reference implementation — every push
script imports `gate_or_die()` and aborts on failure. The full CI mirror
(`ci-gate.py`) remains the deep-verification option.

## Consequences
- (+) The same failures client hooks would have caught are caught before the push
  lands, regardless of transport (git CLI or Data API).
- (+) `forge harden`'s guarantees are explicitly scoped: it hardens the *commit* path.
  The push path needs its own gate, and this ADR names it.
- (−) Every push script must remember to call the gate — there is no server-side
  enforcement. A new script that forgets the import re-opens the hole silently.
- (−) Gate drift: if CI's checks change, `push_gate.py` must be updated in lockstep,
  or the gate certifies something CI no longer checks.
