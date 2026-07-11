# 05 — The cost model: the path to ~90 %, stated honestly

> The owner's target is ~90 % cost reduction. This doc gives the composition argument for
> why the target is reachable, the exact formula, which factors are **measured** today
> versus **targets**, and the P8 harness that will replace targets with measurements.
> Discipline per the paper (§4, C6): a number is an assumption until measured.

## 1. The stage model

A task's cost passes through independent multiplicative stages:

```
C = C₀ · (1 − g·h_gate) · (1 − h_cache·σ_cache) · (1 − ρ_ctx) · (1 − r_route)
```

| factor    | stage                                     | meaning                                                                                                                  | status                                                                                      |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `h_gate`  | M2 gate                                   | fraction of requests halted as under-specified (spend ≈ 0 generation tokens; `g` ≈ their share of would-have-been spend) | mechanism **measured** in paper §9 (9/9 halts, zero gen tokens); rate is workload-dependent |
| `h_cache` | reuse ([03](./03-reuse-cache.md))         | hit rate; `σ_cache` = avg saving per hit (≈ 1.0 exact, ≈ 0.85 near, ≈ 0.5 adapt)                                         | **target** — P8 measures                                                                    |
| `ρ_ctx`   | assembly ([04](./04-context-assembly.md)) | input-token reduction from knapsack + compression ladder vs. read-everything baseline                                    | **target** — P8 measures                                                                    |
| `r_route` | M1 routing                                | tier selection saving on remaining generation                                                                            | **0.62 measured live** (paper §9, real tokens, real ladder)                                 |

Secondary effects deliberately **excluded** from the multiplication (they'd double-count
or are unpriceable now): doom-loop halts (avoided thrash loops), M5 lean (fewer generated
tokens), avoided-rework from the completeness gate (C2's "almost right" loop). These are
tracked in P8 as separate counters, reported alongside — upside, not arithmetic.

## 2. What the target requires

With routing fixed at its measured 0.62, reaching 90 % total requires the _other_ stages
to jointly remove ≈ 74 % of the remaining cost:

```
(1 − h_cache·σ) · (1 − ρ_ctx) · (1 − g·h_gate) ≤ 0.10 / 0.38 ≈ 0.263
```

Example compositions that satisfy it:

| scenario                                         | h_cache·σ | ρ_ctx | g·h_gate | total reduction |
| ------------------------------------------------ | --------- | ----- | -------- | --------------- |
| repeat-heavy team (CRUD, components, migrations) | 0.55      | 0.35  | 0.10     | **90.2 %**      |
| moderate reuse                                   | 0.40      | 0.30  | 0.10     | 85.6 %          |
| cold start (fresh repo, empty ledger)            | 0.05      | 0.25  | 0.05     | 74.3 %          |

Read the table honestly: **~90 % is credible on repeat-heavy team workloads once the
ledger is warm, and is not credible cold.** The cache factor dominates, and it _grows_
with team adoption (every teammate's verified artifact is everyone's hit —
[02](./02-team-memory.md)) and with time (ledger accumulation). The floor — routing +
assembly + gate alone — is ≈ 75 %, already substantial.

## 3. Measurement plan (P8)

**Instrumentation** — every stage emits one line to `.forge/metrics.jsonl`:

```
{ t, task, stage: "gate|cache|context|route|generate|verify",
  tokens_in, tokens_out, tier, outcome, saved_estimate, ref }
```

Written by the existing guard layer (`cost-budget.sh` already meters spend; it gains
stage tags), `substrateCheck()`, and the reuse/context modules. `forge cost` learns a
`--stages` report; `forge dash` charts it.

**Harness** — extend `src/eval.js` (which already does precision/recall for impact):

1. **Replay corpus:** N ≥ 100 real tasks captured from session traces (spec + repo state
   ref + outcome), stratified: repeat-heavy / mixed / cold.
2. **Paired runs:** baseline (always-premium, read-everything, no cache) vs. substrate,
   same tasks — the paper §9 methodology (identical tokens repriced) extended to all four
   stages, so every saving is arithmetic on measured tokens, never an estimate.
3. **Correctness guard:** a saving only counts if the external verifier passes the output
   (paper §9.3's rule: "routing down only counts as a win if the cheap tier is still
   correct" — applied to every stage; a cache hit that gets reverted is a _negative_
   entry).
4. **Report:** per-stage factors with confidence intervals → `reports/cost-eval.md`;
   the README claim gets updated to whatever the harness measured, with the workload
   caveat attached. Until then the README may say "62.1 % measured (routing); ~90 %
   composed target" — never "90 % achieved".

## 4. Cost of the substrate itself

The overhead side of the ledger, counted against the savings in P8:

- Deterministic stages (gate, knapsack, cache lookup, atlas query) are CPU-cheap and
  token-free — the paper's atlas figures (1.9k-node graph in 91 ms, sub-ms queries)
  bound the latency class.
- Injected context (claims, blast radius, checkpoints) _spends_ tokens to save tokens;
  the assembly budget `B` caps it structurally, and `ρ_ctx` is measured net of it.
- The opt-in LLM adjudication layer (`FORGE_LLM=1`) is priced per call in
  `model_tiers.json` and appears as its own metrics stage.
