# ADR 0008: No `forge push-gate` CLI command — a client-side gate cannot move the enforcement boundary

- Status: accepted
- Date: 2026-10-11

## Context

ADR 0007 established that pushes via the GitHub Git Data API bypass all git
hooks, and named the in-path gate: the push script itself runs verification
before any Data API write. The workspace's `push_gate.py` is the reference
implementation — one import, `gate_or_die(local_root, changed_paths)`, run
before every push.

A deferral note then asked whether forgekit should ship a `forge push-gate`
CLI command, on the theory that a single CLI entry point would give "any
present or future push script identical enforcement without reimplementing
the logic in Python". This ADR records the honest investigation of that
claim (2026-10-11), and its verdict: the command would be theater.

## Evidence

**What `push_gate.py` enforces** (read in full, `~/workspace/push_gate.py`):
repo-agnostic detection from config files on disk, then per-file
`prettier --check` (or `biome check`), `eslint` (version-aware), full
`npm run typecheck`, repo-specific `npm run lint:reach`, and tiered tests
via the repo's `smart-test-select` (impacted tests for low/medium tiers,
full suite fail-safe). Checks that a repo never configured are skipped, never
faked.

**What the forgekit CLI has today** (`src/cli.js`, `src/commands.js`):
- `forge verify` — project tests + hallucinated-symbol atlas check +
  provenance stamp. It does **not** run format/lint/typecheck.
- `forge precommit` — staged-code completeness + secret scan.
- `forge harden` — installs git hooks (commit path only, per ADR 0007).
- No existing module composes format+lint+typecheck+tests.

**What a `forge push-gate` would add:** a second implementation of the
`push_gate.py` suite, in JavaScript, behind the *identical* adoption
requirement — the push script must call it before writing. The enforcement
boundary does not move: Git Data API writes trigger nothing client-side or
server-side, so every client-side gate is opt-in by construction, in any
language.

**Server-side enforcement already exists where it matters** (verified live
2026-10-11 via the API): `master` has branch protection with
`enforce_admins: true` and required status checks
(`Quality gate / Full quality gate`, `Test (Node 20/22)`, Windows). Nothing
broken reaches `master` through the PR path, with or without any new CLI
command.

**The actual remaining hole is not a missing command.** A scan of the ~60
push scripts in `~/workspace/` found several ref-writing scripts that never
call `gate_or_die` — notably `merge-pr-overlay.py` and
`merge-branch-overlay.py`, which move `refs/heads/main` directly via the API.
A `forge push-gate` does nothing for them that the one-line Python import
does not; the fix is wiring the call, which is a workspace change, not a
forgekit feature.

## Decision

Do **not** implement `forge push-gate` (or any CLI equivalent of the push
gate). `push_gate.py` remains the single in-path gate for API-driven pushes.
Rationale:

1. **It changes nothing at the enforcement boundary.** "Push scripts must
   call the gate" is the whole of the law, regardless of whether the gate is
   spelled `from push_gate import gate_or_die` or
   `forge push-gate --root … --changed …`. A command cannot make a script
   call it.
2. **It doubles the drift surface ADR 0007 warned about.** CI's checks change;
   the gate must follow in lockstep. Two implementations (Python + JS) of the
   same suite means two places to drift. Today the logic is implemented once,
   and push scripts import it rather than reimplement it — the "without
   reimplementing the logic in Python" premise of the proposal is already
   satisfied.
3. **No non-Python push path exists.** All ~60 push scripts in the ecosystem
   are Python; a subprocess call to a Node CLI is strictly less convenient
   than the existing import. Revisit this decision if a non-Python push path
   appears.
4. **What the CLI lacks (format/lint/typecheck composition) is not a gap.**
   That composition is CI's job server-side and `push_gate.py`'s job in the
   push path. `forge verify`'s scope (tests + symbols + provenance) is
   deliberate.

## Consequences

- (+) No theater shipped: no second gate implementation to maintain, test,
  and keep in sync with CI.
- (+) The gate logic stays in one place, imported — not copied — by every
  push script.
- (−) The genuinely ungated ref-writers (`merge-*-overlay.py`) stay ungated
  until someone wires `gate_or_die` into them. That work is tracked
  separately; this ADR must not be read as claiming the push path is fully
  gated.
- (−) `push_gate.py` remains an unversioned workspace file rather than a
  versioned forgekit feature. If the single-implementation argument ever
  flips (e.g. non-Python push tooling), prefer *moving* the gate into
  forgekit over *duplicating* it.

## What would be a real fix (not this command)

1. Wire `gate_or_die` into the ungated merge/ref-update scripts before any
   ref write.
2. Remove the automation token's branch-protection bypass (if any — not
   verifiable from here), so even direct API ref updates to `master` require
   green CI. Only GitHub-side permissions can enforce what client-side code
   cannot.
3. Optionally, a post-push workflow that flags or reverts red commits
   landing on `master` outside the PR path — server-side remediation, the one
   thing no client gate can provide.
