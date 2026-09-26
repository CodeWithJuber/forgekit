# 05 — The cost model: a ~90 % target, stated as a hypothesis

> The owner's target is ~90 % cost reduction. This doc states that target, the stage model it
> was argued from, why that argument is **not evidence** of any achieved saving, and the P8
> harness that would replace hypotheses with measurements. Every factor below — routing included —
> is a hypothesis until paired, externally verified runs measure it. Discipline per the paper (§4,
> C6): a number is an assumption until measured.

> **Corrected 2026-09-26.** This page used to open with a factor table whose routing row read
> "`r_route` … **0.62 measured live** (paper §9, real tokens, real ladder)", and §2 derived three
> scenarios "with routing fixed at its measured 0.62": **90.2 %** (repeat-heavy team), **85.6 %**
> (moderate reuse) and **74.3 %** (cold start), concluding that "~90 % is credible on repeat-heavy
> team workloads once the ledger is warm" and that the floor was "≈ 75 %". That 0.62 was the old
> router's 62.1 % saving on the 30 tasks its thresholds were tuned on; on 80 held-out tasks the same
> router's total spend was 20.2 % **higher** than always-premium
> ([research/empirical-refutation/](../../../research/empirical-refutation/)), and it was a
> repricing of measured tokens, not an observed cheaper-model outcome. A footnote conceded the
> refutation while the arithmetic above it still used the number. The scenarios are **retired, not
> re-derived**: §2 explains why multiplying independently estimated stage savings would not give a
> valid total even with honest inputs.

## 1. The stage model — a hypothesis about where cost could fall

A task's cost may pass through these stages:

```
C = C₀ · (1 − g·h_gate) · (1 − h_cache·σ_cache) · (1 − ρ_ctx) · (1 − r_route)
```

| factor    | stage                                     | meaning                                                                                                                  | status                                                                                      |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `h_gate`  | M2 gate                                   | fraction of requests halted as under-specified (spend ≈ 0 generation tokens; `g` ≈ their share of would-have-been spend) | **hypothesis** — the paper §9 demo halted its own under-specified examples with zero generation tokens (the tuned set); on 80 held-out tasks the gate's F1 was 0.37, and the halt rate and its net value on a real workload are unmeasured |
| `h_cache` | reuse ([03](./03-reuse-cache.md))         | hit rate; `σ_cache` = avg saving per hit (≈ 1.0 exact, ≈ 0.85 near, ≈ 0.5 adapt)                                         | **hypothesis** — P8 measures                                                                |
| `ρ_ctx`   | assembly ([04](./04-context-assembly.md)) | input-token reduction from knapsack + compression ladder vs. read-everything baseline                                    | **hypothesis** — P8 measures                                                                |
| `r_route` | routing                                   | tier-selection saving on remaining generation                                                                            | **hypothesis** — no current measurement supports a positive value for this pipeline (components below) |

Routing is two separately versioned components, and neither supplies a measured `r_route`:

- **The old tiered router** — the Python prototype `research/python-prototypes/router_gate/`
  (July 2026; 62.1 % on its 30 tuning tasks, **refuted**: 20.2 % more total spend than
  always-premium on 80 held-out tasks) and its Node descendant `forge route` (`src/route.js`, a
  k-NN rubric over labelled exemplars), which has never been evaluated end to end on cost.
- **The universal router** — `forge route universal` (`src/router/`, prior
  `data/router_prior.json` fitted 2026-09-22 on public SWE-bench Verified outcomes). Its held-out
  headline is repository-reported, comes from an external harness, prices a different scaffold's
  attempts, and says nothing about this pipeline's stages. A new in-repo replay on those
  recorded attempts (2026-09-26) finds it no better than a fixed cascade chosen on the same dev
  tasks, and finds its expected-cost formula under-predicting replayed cost by 5–22%
  ([UNIVERSAL_ROUTING.md](../../UNIVERSAL_ROUTING.md)).

Secondary effects are deliberately **excluded** from the multiplication (they would double-count or
are unpriceable now): doom-loop halts (avoided thrash loops), M5 lean (fewer generated tokens),
avoided rework from the completeness gate (C2's "almost right" loop). These are tracked in P8 as
separate counters, reported alongside — upside, not arithmetic.

## 2. Why the product is not a total

Four separately estimated saving rates cannot simply be multiplied into a total:

- **Cache hits change the routed workload.** The tasks that miss the cache are the novel ones, which
  are likely the harder and more expensive ones; a routing saving estimated on all tasks does not
  carry over to that residue.
- **Context assembly changes quality, and quality changes retries.** Fewer input tokens that cost an
  extra failed attempt or an escalation are not a saving; `ρ_ctx` measured as input-token reduction
  alone ignores that.
- **Halts can defer cost rather than remove it.** A clarified task usually comes back and is paid
  for; a halt saves only if the work it prevents was wrong or unnecessary.
- **Conditional ratios telescope only over one realized pipeline.** `C_final / C₀ = ∏ₖ (Cₖ / Cₖ₋₁)`
  holds when every `Cₖ` is measured on the same tasks in the same run, each stage's denominator is
  the cost that actually reached it, and the ledger includes what the stages themselves add:
  lookups, prompt injection, verification, failed attempts and human recovery.

Two further rules keep numbers honest:

- **Repricing is a price counterfactual.** Repricing one model's measured tokens at another model's
  price is not an observed cheaper-model outcome: the cheaper model would have produced different
  tokens, different failures and different retries. It may be reported, labelled as a
  counterfactual, never as a saving.
- **Name the component and its version.** "Routing saves X" must say which router (the old tiered
  router, `forge route`, or `forge route universal`), which version or prior, and which task set.

The ~90 % figure remains the owner's target and a **hypothesis**. It is never a result, and no
published achieved saving may be derived from this stage model.

## 3. Acceptance rule for any cost headline

A cost figure may be published only with every field below. A figure that cannot fill them is
labelled a target, a hypothesis or a counterfactual; the evidence status is the one recorded in
[`docs/status/claims.json`](../../status/claims.json).

| Field                | What it must say                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Run ID               | the run (or runs) that produced the number, so it can be found and re-read                                |
| Code SHA             | the exact commit of forgekit (and of any external harness) that ran                                      |
| Dataset              | the task set, how it was selected, and whether any of it was used to tune the policy                      |
| Denominator          | per task, or — the primary outcome — per **completed, externally verified** task                         |
| Baseline             | what it is compared with, run with equivalent tools, context and repair opportunity                       |
| Correctness rule     | what counts as success: `tests_passed`, `human_accepted`, `deployed_without_revert` — or `judge_accepted`, named as such |
| Uncertainty          | an interval, its method, and the unit resampled (task, repository, time block)                            |
| Evidence status      | `measured`, `reported` (someone else's number, not reproduced here) or `hypothesis`                       |

No published achieved saving may derive from a factor that has been refuted.

**Cost reporting fields** (for `forge cost`, `forge dash` and any report; see
[GUIDE → `forge cost --stages`](../../GUIDE.md#forge-cost---stages--the-measured-cost-report)):

- currency and the date of the prices used;
- actual spend versus counterfactual (repriced or modelled) spend, never mixed in one number;
- which attempts are included (first attempt only, or every retry and escalation);
- cached tokens, and verifier and tool costs, counted or explicitly excluded;
- missing-data status: a stage or day with no logs is **unknown**, never $0 actual spend;
- beside the primary outcome (total cost per completed, externally verified task), the acceptance
  rate and the abandonment rate;
- stage-level logs diagnose where cost goes; only paired, full-system outcomes judge whether the
  system saves.

## 4. Measurement plan (P8) — status: partial

**Instrumentation (implemented)** — every stage emits one line to `.forge/metrics.jsonl`:

```
{ t, task, stage: "gate|cache|context|route|generate|verify",
  tokens_in, tokens_out, tier, outcome, saved_estimate, ref }
```

Written by the existing guard layer (`cost-budget.sh` already meters spend; it gains
stage tags), `substrateCheck()`, and the reuse/context modules. `forge cost` learns a
`--stages` report; `forge dash` charts it. The per-stage factors it prints are stage
self-estimates over whatever was logged — diagnostics, not a total.

**Harness (not yet run)** — extend `src/eval.js` (which already does precision/recall for impact):

1. **Replay corpus:** N ≥ 100 real tasks captured from session traces (spec + repo state
   ref + outcome), stratified: repeat-heavy / mixed / cold, selected before any policy is tuned
   on them.
2. **Paired runs:** baseline (equivalent tools, context and repair opportunity; always-premium /
   read-everything is reported too, but it is a weak comparator) vs. substrate, same tasks, **each
   policy actually executed**. Repricing the baseline's tokens at a cheaper model's price is a
   counterfactual (§2) and is labelled as one.
3. **Correctness guard:** a saving only counts if an external verifier passes the output
   (`tests_passed` or `human_accepted`); a cache hit that gets reverted is a _negative_ entry, and
   abandoned tasks count against the policy that abandoned them.
4. **Report:** total cost per completed, externally verified task with an interval, acceptance and
   abandonment rates beside it, and per-stage diagnostics → `reports/cost-eval.md`, every field of
   §3 filled. The README may say "~90 % target (hypothesis)" — never "90 % achieved". (It used to
   also say "62.1 % measured (routing)"; that figure came from the 30 tasks the router was tuned on
   and was refuted on 80 held-out tasks, where routing cost 20.2 % more than always-premium — see
   `research/empirical-refutation/`.)

Until the harness has run, P8 is **partial**: instrumentation and the stage report exist, and
[`reports/cost-eval.md`](../../../reports/cost-eval.md) holds no measured end-to-end figure.

## 5. Cost of the substrate itself

The overhead side of the ledger, counted against the savings in P8:

- Deterministic stages (gate, knapsack, cache lookup, atlas query) are CPU-cheap and
  token-free — the paper's atlas figures (1.9k-node graph in 91 ms, sub-ms queries)
  bound the latency class.
- Injected context (claims, blast radius, checkpoints) _spends_ tokens to save tokens;
  the assembly budget `B` caps it structurally, and `ρ_ctx` is measured net of it.
- The opt-in LLM adjudication layer (`FORGE_LLM=1`) is priced per call in
  `model_tiers.json` and appears as its own metrics stage.
