---
name: forge-impact
description: Blast-radius analysis before you touch unfamiliar code. Use when estimating what a change to a symbol or file will break, scoping a refactor, or reviewing a PR — run forge impact first, then decide.
license: MIT
allowed-tools: Bash, Read
---

# forge-impact — hazard-aware blast radius

## Install

```bash
# from a forgekit checkout, or: npm install -g forgekit
cp -r skills/forge-impact .claude/skills/
```

Requires the `forge` CLI on PATH.

## When to use

- Before editing a symbol or file you didn't write — *what breaks if I change this?*
- Scoping a refactor — *how big is this really?*
- Reviewing a PR — *did the author miss an affected caller?*
- Triaging a bug — *which files could have caused this symptom?*

Don't use it for a one-line change to a leaf function you own. Do use it whenever
the words "I think this is safe" cross your mind.

## Commands

```bash
forge impact <symbol|file>          # blast radius of a symbol or file
forge impact src/ledger.js          # by file
forge impact computeTax --json      # by symbol, machine-readable
forge impact src/val.js --basic     # fixed threshold, no hazard enhancements (faster)
forge impact <target> --all-relations  # also walk sibling/forward relations (larger, noisier)
forge impact --diff                 # your working diff: coupled invariants first, then dependents
forge impact --staged               # the same, over the index
```

`--diff` flags what no import edge records: a set you grew (an allowlist, a registry)
that code in the same package quantifies over (require-all loops, size checks, switches
missing the new member), and a store you now load into memory while another binary
writes its file. Treat each `!!` line as a file you must open before claiming done.

## How it works (the 30-second version)

1. Builds the repo's reference graph (imports, calls, re-exports).
2. Propagates **backwards** from the target through callers, expanding through
   strongly-connected components (SCCs) — cycles propagate together.
3. Applies a **data-driven threshold**: PageRank centrality of each node plus the
   ledger's incident history (files that caused incidents before rank higher).
4. Reports impacted files, ambiguous references it refused to link, and imports
   it couldn't resolve.

See [references/reading-output.md](references/reading-output.md) for the output anatomy
and [references/thresholds.md](references/thresholds.md) for the hazard model.

## Rules

1. **Impact first, edit second.** The analysis is cheap; the missed caller is not.
2. Treat "ambiguous reference" lines as *unresolved risk*, not noise — a name that
   matched multiple definitions is exactly where bugs hide.
3. `--json` when you're feeding the result into another tool or a review checklist.
4. If the impacted set is bigger than you expected, shrink the change, not the analysis.

## References

- [references/reading-output.md](references/reading-output.md) — output anatomy with an example
- [references/thresholds.md](references/thresholds.md) — SCC expansion + PageRank + incident history
