# The hazard model — SCC expansion + PageRank + incident history

A naive blast radius is "all transitive callers". That's usually either trivially
small (misses real coupling) or uselessly large (every util function "impacts"
the world). `forge impact` corrects both failure modes.

## 1. SCC-aware propagation

The reference graph's strongly-connected components are computed first. A cycle —
A calls B calls A — propagates as a unit: changing any member risks all members.
Without this, cycle members leak out of the radius one hop at a time and the
analysis under-reports exactly the most coupled code.

## 2. PageRank centrality threshold

Every node gets a PageRank score over the reference graph. High-centrality nodes
(utils, registries, base classes) legitimately touch many files; low-centrality
nodes don't. The inclusion threshold is *data-driven*: it adapts to the graph
instead of a fixed hop-count, so a 2-hop change through a god-object still shows
up while a 5-hop chain through leaf code doesn't drown the report.

`--basic` skips both enhancements: fixed threshold, no SCC expansion. Faster,
blunter — fine for a first pass.

## 3. Ledger incident history

If the repo keeps a forge ledger, past incidents weight the ranking: files that
caused real incidents before are surfaced higher. The analysis learns from the
repo's own scar tissue. (No ledger yet? The other two signals still work.)

## Calibrating

- Radius much bigger than expected → the target is more central than you thought.
  Shrink the change or accept the review surface.
- Radius suspiciously small → check the `!`/`·` lines: ambiguous references and
  unresolved imports are where the graph is blind.
- `--all-relations` walks sibling and forward relations too — much larger and
  noisier. It's a recall instrument for audits, not for everyday edits.
