# Reading `forge impact` output

Real example (forgekit's own `src/ledger.js`):

```
target: src/ledger.js  ✓ found
impacted files: 114  (nodes: reverse 267)
  - .github/workflows/reusable-quality-gate.yml
  - ACCESSIBILITY.md
  - docs/GUIDE.md
  - docs/adr/0006-proof-carrying-memory.md
  - bench/bench.mjs
  … 94 more
! 210 reference(s) to this target's name(s) matched more than one definition and were not linked
· 2 local import(s) in the repo did not resolve to a file
```

## The lines

- **`target … ✓ found`** — the symbol/file resolved to exactly one definition.
  If it doesn't, disambiguate before trusting anything below.
- **`impacted files: N (nodes: reverse M)`** — N files reachable by backward
  propagation; M is the raw reverse-graph node count before thresholding.
  The gap (267 → 114 here) is the hazard threshold doing its job.
- **the file list** — every file you should at least glance at. Docs and CI
  configs appear when the target is load-bearing (they are, here).
- **`! … ambiguous … not linked`** — references the analyzer refused to attribute.
  Read these as *known unknowns*: the true blast radius includes some of them.
- **`· … did not resolve`** — broken imports in the repo. Fix them; they also
  blind the analysis.

## Using `--json`

Machine-readable report: target, impacted files with centrality scores, ambiguous
references, unresolved imports. Pipe it into review checklists or a second agent
doing the actual edit — the JSON is the contract between analysis and action.

## What it can't see

- **Dynamic dispatch** (`obj[method]()`, plugin registries) — string-built call
  targets don't appear in the graph. Grep for the name as a string too.
- **Cross-repo effects** — the graph ends at the repo boundary. Published
  packages need their own impact run in the consumer.
- **Runtime config** — a flag flip in config can widen any radius. The analysis
  is static; your judgment isn't.
