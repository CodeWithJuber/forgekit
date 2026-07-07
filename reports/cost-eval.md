# Cost evaluation — measured stage factors (P8)

> Status: **no data yet.** This document is the artifact the P8 harness
> ([docs/plans/substrate-v2/05-cost-model.md](../docs/plans/substrate-v2/05-cost-model.md) §3)
> fills with measurements. Until a cell below holds a measured number, the only claimable
> figures are the paper's: 62 % routing saving on live tokens (paper §9). The plan's ~90 %
> composed figure is a **target**, not a result, and does not appear in this table.

## Methodology

The cost model is multiplicative — `C = C₀ · Π(1 − fᵢ)` over independent stages — so each
stage factor is measured separately and composed arithmetically, never asserted:

1. **Instrumentation.** Every substrate stage appends one line to `.forge/metrics.jsonl`
   (`{t, stage, outcome, tokensIn, tokensOut, tier, savedEstimate, ref}` — `src/metrics.js`).
   `forge cost --stages` computes the per-stage factors from those lines (`src/cost_report.js`);
   a stage with no events reports **no data**, never a default.
2. **Paired runs.** Baseline (always-premium, read-everything, no cache) vs. substrate over
   the same replay corpus (N ≥ 100 real tasks, stratified repeat-heavy / mixed / cold), the
   paper §9 methodology: identical tokens repriced, so every saving is arithmetic on measured
   tokens.
3. **Correctness guard (spec §3).** A saving counts only if the external verifier passes the
   output. A routed-down answer that fails is not a saving; a cache hit that gets reverted is
   recorded as a *negative* entry.

## Measured factors

| stage | factor | events | measured? |
|---|---|---|---|
| gate (M2 halt rate) | — | 0 | no data yet — run with metrics enabled |
| cache (reuse, tier-weighted) | — | 0 | no data yet — run with metrics enabled |
| route (vs always-premium) | — | 0 | no data yet — run with metrics enabled |
| context (assembly ρ) | — | 0 | no data yet — run with metrics enabled |
| **composed (measured stages only)** | — | 0 | nothing to compose yet |

Secondary counters (doom-loop halts avoided, M5 lean, avoided rework) are reported alongside
when populated — they are deliberately excluded from the multiplication (spec §1).

## How to populate this table

Metrics accrue as the substrate is actually used — each command below appends stage-tagged
lines to `.forge/metrics.jsonl`:

```sh
# gate + cache: every explicit pre-action check meters both stages
forge substrate "<task>"

# cache: explicit reuse queries and mints
forge reuse query "<what you are about to build>"

# then read the measured factors (and paste them here):
forge cost --stages          # human table
forge cost --stages --json   # machine-readable, for this report
```

Route and context events are emitted via `recordRoute` / a future context-assembly hook
(`src/cost_report.js`) as those stages gain live wiring.

## Caveats that ship with any number placed here

- Stage rates are **workload-dependent**: factors describe the recorded traffic of one repo,
  not a general claim (spec §2 — repeat-heavy warm-ledger workloads differ from cold starts).
- The composed reduction is a **lower bound from measured stages only**; unmeasured stages
  contribute nothing rather than a target.
- Until the paired-run harness with the correctness guard has run, per-stage factors from
  live metrics are unguarded observational numbers, not eval results.
