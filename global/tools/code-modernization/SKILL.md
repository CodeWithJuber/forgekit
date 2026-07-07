---
name: code-modernizer
description: >-
  Modernize or refactor a legacy codebase incrementally while preserving business
  logic. Replaces hand-rolled logic with the standard library, a native feature,
  an already-installed dependency, or (only after live research) a well-vetted new
  package, then applies minimal design patterns to whatever custom code remains.
  Confirms scope first (full-codebase, one module/partial, or only the exact lines
  named) and flags file count, line count, and breaking-change risk before
  generating a large diff, asking instead of assuming when scope, a library choice,
  or a behavior change is unclear.
  Use for migrations (framework/language/version upgrades), killing tech debt,
  refactoring an old project, or "bring this up to date". Use whenever the user
  asks to refactor, modernize, de-bloat, clean up, simplify, upgrade, or audit
  code; asks "is there a library for this", "don't reinvent the wheel", "replace
  with a framework", "reduce boilerplate", or "apply proper design patterns"; wants
  a root-cause fix over a quick patch; says "full upgrade" vs "partial upgrade" vs
  "just fix this one thing"; or wants a legacy-code/tech-debt audit or a
  dependency-choice recommendation.
license: MIT
attribution: >-
  This skill's ladder is adapted from DietrichGebert/ponytail (MIT licensed).
  See "Relationship to ponytail" below.
---

# Code Modernizer

## Philosophy

A senior engineer isn't measured by how much code they wrote today, but by how
little the system needs. Before touching anything, decide whether the code should
be replaced with something already established. If custom code is genuinely
necessary, write the least of it that solves the real problem without dropping
behavior anyone relies on.

This skill's core decision procedure is adapted from Dietrich Gebert's `ponytail`
project (MIT licensed, github.com/DietrichGebert/ponytail). It extends ponytail
two ways: it applies the same ladder retroactively to audit code that already
exists, not just to gate new code being written, and it adds scope control, a
pre-flight cost/impact gate, and a mandatory live-research step for whenever a
genuinely new dependency is on the table. See "Relationship to ponytail" at the
end.

## The ladder

Before writing, keeping, or replacing any piece of logic, stop at the first rung
that holds:

1. **Does this need to exist at all?** (YAGNI). If a feature isn't used, delete it
   instead of modernizing it.
2. **Already solved elsewhere in this codebase?** Reuse it, don't rewrite it.
3. **Standard library does it?** Use it.
4. **Native platform feature does it?** Use it. The browser already has
   `<input type="date">`, so don't reach for a date-picker library.
5. **Already-installed dependency does it?** Use it. Zero new install cost.
6. **Is a new dependency genuinely justified?** Only after the research pass in
   Step 3 below. Never skip straight here.
7. **Can what's left be one line?** Make it one line.
8. **Only then:** write the minimum code that works, shaped by whichever design
   pattern (if any) removes real duplication. See
   `references/design-patterns-cheatsheet.md`.

The ladder runs after understanding the problem, not instead of it. Read the code
and its tests before picking a rung (Step 2).

## Two modes, same ladder

- **Forward** (writing new code): apply the ladder before writing anything.
- **Audit** (existing code): apply the same ladder retroactively. For every
  hand-rolled block in scope, ask: "would rung 3, 4, 5, or a researched rung 6
  now produce less code, or safer code, than what's already here?" If yes, and the
  check in Step 4 clears it, propose the swap. This audit mode is the part
  `ponytail` doesn't cover. It governs new code; this skill governs the code
  that's already sitting in the repo.

## Step 0: Scope handshake (every time, before any real work)

Refactoring has a blast radius. Before generating anything beyond a one-file,
one-function fix, pin down which of these three the user wants:

- **Full**: a comprehensive pass across the named codebase or repo. Expect
  multiple files and possibly breaking changes; produce a migration note.
- **Partial**: bounded to one named module, directory, or feature area. No
  drive-by edits outside that boundary, even if something nearby looks equally
  outdated.
- **Targeted**: only the exact file, function, or lines named. Nothing else
  changes.

If the request already states scope clearly ("just fix this function", "modernize
the whole `utils/` folder"), proceed without asking. If it's ambiguous ("clean up
this codebase", "make this better"), ask one direct question offering these three
options before reading any more files than needed to ask it well. Don't default to
Full because it seems more thorough. Full is the most expensive and highest-risk
option, not the safe default.

## Step 1: Pre-flight scan and cost/impact flag (Full/Partial only, skip for Targeted)

Ground the estimate in real numbers instead of a guess. Run:

```
python3 scripts/preflight_scan.py <path>
```

It's stdlib-only Python, nothing to install. Report back to the user in a short
block before generating anything:

```
Scope: <Full|Partial> on <path>
~<N> files, ~<X> lines in range
Dependencies already available: <short list from the manifest>
Flagged high-cost: <any file over ~800 lines, or the pass touching 15-20+ files, name them>
Estimated: <rough tool-call / diff count>, <low|medium|high> breaking-change risk
Proceed as scoped, narrow it, or switch to Targeted?
```

Treat anything the scan flags as high-cost as its own decision point. Offer full
detail there or a summarized diff, rather than silently generating all of it. Full
rubric, including the flexibility trade-off, in `references/cost-impact-preflight.md`.

## Step 2: Read before you touch (root cause, not a patch)

Before proposing any swap, read what's actually there: the function, its tests,
nearby comments, and the commit that introduced the "ugly" version if it's
available. Hand-rolled code is sometimes just unmaintained. Sometimes it's
load-bearing for an edge case the clean replacement doesn't handle. Confirm which
one is in front of you before replacing it. If the tests don't cover a case the
old code was clearly written for, say so instead of silently dropping it.

## Step 3: Research before recommending a new dependency (mandatory, live)

Rungs 1 through 5 need no research; they're free and already known to be safe.
Rung 6, a genuinely new dependency, is the one place memory goes stale fast: a
library that was the obvious choice eighteen months ago can be unmaintained,
superseded, or carrying an open CVE today. Never recommend a package from memory
alone. Check its current state first, live, with search. Checklist,
current-as-of-lookup sources, and red/green flags are in
`references/research-protocol.md`. Summarize the choice in one or two sentences
per swap in the final answer; this step is not the place to write an essay.

## Step 4: Impact vs. flexibility, before writing the change

Before writing the replacement, work out:

- who else calls this (the blast radius may be bigger than the one call site that
  prompted the change),
- what flexibility the current code buys and whether anyone actually uses it (grep
  before removing), and
- whether the migration cost (call-site updates, type changes, test churn) is
  worth what's gained.

If the trade isn't clearly worth it, say what was found and ask. The user knows
release timing and risk appetite that the code alone doesn't reveal. Full rubric
in `references/cost-impact-preflight.md`.

## Step 5: Output discipline

- Show the diff or the changed function, not the whole file, unless the whole file
  is asked for.
- One consolidated summary per batch of related changes, not a running commentary
  per file.
- Batch logically related edits together instead of narrating each one separately.
- Don't restate the ladder or the research trail in the final answer. The user
  needs the change and a one-line reason, not the process that produced it.

## Incremental modernization methodology (Full/Partial scope)

For legacy/dated codebases, modernize in safe, verifiable increments — never a
big-bang rewrite. Keep a human in the loop at each gate.

### Assess (read-only first)
- Map dependencies and the module graph; identify dead code and the highest-churn,
  highest-complexity, highest-business-value hotspots.
- Use the `serena` LSP + `scout` subagent so this exploration doesn't fill main
  context. Write findings to `MODERNIZATION.md`.
- Verify target frameworks/versions with `tech-selector` (current best, not
  training-data defaults).

### Safety net before changing anything
- Characterize current behavior with tests. If coverage is thin on the code you'll
  touch, add regression tests that pin the *existing* output first — so a refactor
  that changes behavior fails loudly.

### Transform incrementally
- One bounded slice at a time (a module, a route, a component). Preserve business
  logic exactly; modernize the form around it.
- After each slice: run tests + build + lint, and for UI use `ui-workflow`'s
  screenshot check. Commit per slice with a conventional message so each step is
  revertible.

### Verify each slice
- Tests green, build passes, behavior unchanged (diff against the pinned regression
  output). Use the `verifier` subagent on non-trivial slices.
- Patch security issues surfaced along the way (semgrep is installed) but keep them
  as separate commits.

### Document
- Update `MODERNIZATION.md` with what changed and why; capture any institutional
  knowledge recovered from the old code before it's lost.

### Guardrails
- Business continuity first: if a slice can't be proven behavior-preserving, stop
  and surface it rather than guessing.
- No scope creep — modernize what the slice covers, not everything you notice.

## Never lazy about (unchanged from ponytail)

Input validation at trust boundaries, error handling that prevents data loss,
security, accessibility, and anything the user explicitly asked for. These are
never traded away for a smaller diff, no matter which rung of the ladder applies.

## Marking deferred opportunities

When a swap is correct in principle but out of scope for a Targeted request, don't
make it. Leave a one-line marker instead, mirroring ponytail's `ponytail:` comment:

```js
// modernize: could use structuredClone() (Node 17+) instead of this deep-clone helper
```

At the end of a session, list any `modernize:` markers left behind, so "later"
leaves a paper trail instead of quietly becoming "never."

## Ask, don't assume

Stop and ask one direct question, don't proceed on a guess, when:

- Scope isn't stated and can't be inferred confidently (Step 0).
- Two well-maintained libraries are both reasonable and the right one depends on a
  constraint the user hasn't stated (bundle size vs. features, already using a
  sibling package from one ecosystem, etc.).
- The swap is a breaking change to a public API or an exported function.
- The "clean" replacement doesn't obviously cover an edge case the current code
  handles.

## Example

**Request:** "This `debounce` function in `hooks/useDebounce.ts` looks
hand-rolled, can you clean it up?"

This names an exact file and function, so it's **Targeted**; skip Step 1. Step 2:
read it and its tests; it correctly cancels on unmount, which a naive replacement
might miss. Step 3: `lodash` is already an installed dependency (rung 5) with a
well-tested `debounce`, so no new dependency and no research pass are needed.
Step 4: one call site, low risk, no flexibility lost. Result: a 3-line wrapper
around `lodash.debounce` that preserves the unmount-cancel behavior, with a
one-line note on why. Not a rewrite, not an essay, not a new package.

## Relationship to ponytail

This skill deliberately does not re-implement ponytail's own commands
(`/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, its lite/full/ultra
intensity dial). That would be exactly the kind of reinventing this skill exists
to prevent. For governing new code as it's written, install ponytail itself in
Claude Code: it's free, MIT-licensed, actively maintained, and benchmarked at
roughly half the code and 20% lower cost against a no-skill baseline.

```
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
```

The two compose cleanly. Ponytail keeps new code minimal as it's written; this
skill audits and modernizes what's already in the repo, with the scope control,
cost/impact gate, and live research discipline the ladder alone doesn't cover.

## Reference files (load only when the step above points here)

- `references/research-protocol.md`: vetting a candidate library, current sources
  to check, red/green flags, decision template.
- `references/design-patterns-cheatsheet.md`: smell → pattern → when to skip it,
  compact table.
- `references/cost-impact-preflight.md`: full pre-flight output template and the
  impact/flexibility rubric.
- `scripts/preflight_scan.py`: stdlib-only scanner for file count, LOC, and
  dependency manifests.
