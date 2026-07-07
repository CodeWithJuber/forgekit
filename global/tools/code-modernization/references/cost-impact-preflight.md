# Cost / impact pre-flight and flexibility rubric

## Pre-flight output template (Step 1)

Run `python3 scripts/preflight_scan.py <path>` and report:

```
Scope: <Full|Partial> on <path>
~<N> files, ~<X> lines in range
Dependencies already available: <short list from the manifest>
Flagged high-cost: <any file over ~800 lines, or the pass touching 15-20+ files, name them>
Estimated: <rough tool-call / diff count>, <low|medium|high> breaking-change risk
Proceed as scoped, narrow it, or switch to Targeted?
```

### Breaking-change risk levels

| Level | Criteria |
|---|---|
| **Low** | Internal/private functions only; no exported API changes; no type signature changes |
| **Medium** | Exported functions change signature but callers are all in-repo; or a dependency is swapped that has a slightly different API |
| **High** | Public API / SDK changes; cross-repo consumers possible; type changes that propagate through generics; removal of a feature flag or config option |

### High-cost file handling

When a file exceeds ~800 lines or the total pass touches 15–20+ files:

1. Name the files explicitly in the pre-flight report.
2. Offer the user a choice: full detailed diff, summarized diff (key changes
   only), or skip that file for now.
3. Don't silently generate a massive diff — the user may want to split the work
   across PRs.

## Impact vs. flexibility rubric (Step 4)

Before writing each swap, evaluate:

| Question | If yes → | If no → |
|---|---|---|
| Does anyone else call this? | Check all call sites; mention them in the summary | Safe to change in isolation |
| Does the current code handle edge cases the replacement doesn't? | Keep the edge-case handling; wrap the replacement if needed | Straight swap |
| Does the current API surface offer flexibility someone might rely on? | Grep for usage of that flexibility; if unused, remove | Keep the simpler replacement |
| Is the migration cost (call-site updates, type changes, test churn) < the maintenance cost of keeping the old code? | Proceed | Defer — leave a `// modernize:` marker |
| Does the swap change observable behavior (return types, error messages, side effects)? | Treat as a breaking change; flag in the pre-flight report | Transparent swap |

### When to defer instead of swap

- The swap is correct but the module is in active development (merge conflicts).
- The user said "Targeted" and the swap is outside the named scope.
- The migration cost is high and the old code works fine — it's debt, not a bug.
- Two equally good replacements exist and the choice depends on constraints the
  user hasn't stated.

In all these cases, leave a `// modernize:` marker and list it at session end.
