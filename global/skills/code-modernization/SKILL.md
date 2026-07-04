---
name: code-modernization
description: Modernize or refactor a legacy codebase incrementally while preserving business logic. Use for migrations (framework/language/version upgrades), killing tech debt, refactoring an old project, or "bring this up to date". Mirrors Anthropic's code-modernization methodology.
---

# Code modernization

For legacy/dated codebases (several of yours qualify). Modernize in safe,
verifiable increments — never a big-bang rewrite. Keep a human in the loop at each
gate.

## 1. Assess (read-only first)
- Map dependencies and the module graph; identify dead code and the highest-churn,
  highest-complexity, highest-business-value hotspots.
- Use the `serena` LSP + `scout` subagent so this exploration doesn't fill main
  context. Write findings to `MODERNIZATION.md`.
- Verify target frameworks/versions with `tech-selector` (current best, not
  training-data defaults).

## 2. Safety net before changing anything
- Characterize current behavior with tests. If coverage is thin on the code you'll
  touch, add regression tests that pin the *existing* output first — so a refactor
  that changes behavior fails loudly.

## 3. Transform incrementally
- One bounded slice at a time (a module, a route, a component). Preserve business
  logic exactly; modernize the form around it.
- After each slice: run tests + build + lint, and for UI use `ui-workflow`'s
  screenshot check. Commit per slice with a conventional message so each step is
  revertible.

## 4. Verify each slice
- Tests green, build passes, behavior unchanged (diff against the pinned regression
  output). Use the `verifier` subagent on non-trivial slices.
- Patch security issues surfaced along the way (semgrep is installed) but keep them
  as separate commits.

## 5. Document
- Update `MODERNIZATION.md` with what changed and why; capture any institutional
  knowledge recovered from the old code before it's lost.

## Guardrails
- Business continuity first: if a slice can't be proven behavior-preserving, stop
  and surface it rather than guessing.
- No scope creep — modernize what the slice covers, not everything you notice.
