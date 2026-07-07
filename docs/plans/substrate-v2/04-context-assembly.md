# 04 — Context assembly: knapsack selection + a set-cover completeness gate

> Fixes the "incomplete context" failure from the root: what goes into the window becomes
> a budgeted optimization, and *whether the context is sufficient* becomes a computed
> set, not a feeling. Supplies the paper's P3 remedy at the system level and gives M2's
> questions a derivation. Phase P4, wired into `src/substrate.js`.

## 0. The two failures this kills

1. **Over-stuffing:** everything competes for the window on equal terms (paper P3 —
   "bounded, undifferentiated context"); MCP setups alone can eat most of it before work
   begins (C11, vendor-reported). Result: the relevant fact is present but drowned.
2. **Under-supplying:** the agent edits a symbol without the callers, the test, or the
   team lesson that would have changed the plan — then "assumes" (M2's root failure,
   C1/C2). Today nothing *computes* what was missing; the user finds out from the bug.

Both are the same problem: context selection has no objective function and no
sufficiency predicate. We give it both.

## 1. Candidate items

For a task `x` targeting symbols `S` (parsed by `src/scope.js` + atlas query), gather
candidates `I`:

| source | items |
|---|---|
| atlas slice | definitions + reverse-dependency neighborhood of `S` (`impact()` output) |
| ledger | top-scoring claims per Eq. 3 (`lesson`, `fact`, `decision`, `diagnosis` in scope) |
| reuse cache | adapt-tier artifacts ([03](./03-reuse-cache.md)) |
| files | source spans for `S` and its direct callers; relevant test files |
| summaries | `summary` claims covering cold ranges (below) |

Each item `i` carries: token cost `tᵢ` (measured, not guessed — `str.length/3.6`
heuristic calibrated in P8), score `sᵢ`, and a **coverage set** `cov(i)` — which required
entities it satisfies.

## 2. Selection — a budgeted knapsack

Given window budget `B` (per-tool cap from `source/substrate.json`, minus fixed
overhead):

```
maximize   Σ sᵢ·xᵢ
subject to Σ tᵢ·xᵢ ≤ B,   xᵢ ∈ {0,1}
```

`sᵢ` = Eq. 3 score ([01](./01-pcm-protocol.md) §4) × source prior (atlas slice and
required files outrank nice-to-have lessons). Solved greedily by density `sᵢ/tᵢ` with the
best-single-item fallback — the classic ½-approximation to 0/1 knapsack; optimality is
not the point, *having an objective* is. Deterministic, O(n log n), zero model calls.

Two refinements:

- **Diminishing returns within a source:** the marginal value of the 4th lesson is below
  the 1st. Score the j-th item taken from one source as `sᵢ·δ^(j−1)` (δ = 0.7) — a lazy
  submodular discount evaluated during the greedy pass.
- **Compression ladder:** every file/graph item exists at up to three granularities —
  full span, signature-only, one-line `summary` claim — with costs `t⁽⁰⁾ > t⁽¹⁾ > t⁽²⁾`.
  The greedy pass may *downgrade* an item's granularity instead of dropping it, provided
  the granularity still covers the entities the gate needs (below). This is the paper's
  "context compression" made explicit: compression is a *lossy move with a known coverage
  cost*, chosen by the optimizer, never silently by scroll-off.

## 3. The completeness gate — set cover, inverted

Define the **required-knowledge set** for an edit — computed, not vibes:

```
R(edit) = defs(S)                      // the symbols being changed
        ∪ blast₁(S)                    // direct dependents (atlas reverse edges, hop 1)
        ∪ tests(S)                     // tests covering S (atlas contains/test edges)
        ∪ contracts(S)                 // types/interfaces S implements
        ∪ lessons*(S)                  // scope-matching lessons with val ≥ 0.8
```

The gate over a selection `X`:

```
missing = R(edit) \ ⋃_{i∈X} cov(i)
gate: missing = ∅ → proceed | missing ≠ ∅ → resolve(missing)
```

`resolve(missing)`, in order:

1. **Auto-fetch** — entity exists in repo/ledger: add it (re-running the knapsack with it
   pinned; something optional gets downgraded/dropped to make room).
2. **Ask** — entity is unknowable from the repo (an unstated requirement, an ambiguous
   target): emit it as an M2 clarifying question. **This upgrades `src/preflight.js`:**
   questions are now *derived from a set difference* — "I cannot see the callers of
   `validatePayment` in `billing/`; is the EU flow in scope?" — instead of
   pattern-matched from lexical cues. The paper's `s(x) < τ` halt rule keeps its
   role for lexical under-specification; the missing-set adds structural
   under-supply.
3. **Block** — under `FORGE_ENFORCE=1`, an edit whose `R` was never covered is refused
   the same way the impact gate refuses (17:36 — no action without knowledge).

Coverage bookkeeping is exact for graph/file items (`cov` = the entities the span
contains, from atlas) and declared for claims (`scope`). `R ⊆ cov(X)` is a set inclusion
check — O(|R|) with a hash set.

## 4. Session dynamics

- **Re-assembly triggers:** target set `S` changes; M4 drift alarm fires
  ([06](./06-faculties-and-mechanisms.md) §5); context usage crosses 70 % (pre-empting
  the "compression wipes the anchor" decay the paper documents in M4). On re-assembly,
  the goal claim and `R`-covering items are pinned — fluff is what gets evicted, never
  the anchor.
- **Write-back:** the selection set is recorded in `informed(action)`; if the task
  outcome contradicts (revert/fail), the *selection itself* is evidence — items that were
  present get nothing, but a post-hoc diagnosis that names an entity absent from `cov(X)`
  mints a `diagnosis` claim that grows `R`'s recipe for that scope. The gate learns what
  "complete" means per codebase.

## 5. CLI + integration

- `forge context <task>` — prints the assembled selection: items, granularity, tokens,
  scores, covered vs. required entities, and the missing-set if any. `--json` for hooks.
- `substrateCheck()` stage order becomes: preflight(lexical) → **context-assemble +
  completeness gate** → reuse → route → impact → lean → verify plan.
- The ambient hook (`substrateContext()`) injects the *rendered selection*, replacing
  ad-hoc "read these files" advisories.

## 6. Honest limits

- `R(edit)` inherits atlas's regex-approximation: over-approximate on dependents (safe —
  more required knowledge), potentially blind where regex misses an edge. The AST-backed
  atlas upgrade ([06](./06-faculties-and-mechanisms.md) §1) tightens both at once.
- Greedy ½-approximation can leave budget value on the table; irrelevant next to the
  failure mode it replaces (no objective at all).
- `lessons*` selection uses `val`, so a young team ledger under-supplies at first — the
  gate's floor (`defs ∪ blast₁ ∪ tests`) is structural and needs no history.
