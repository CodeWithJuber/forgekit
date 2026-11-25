# Cost evaluation — measured stage factors (P8)

> Status: **no data yet.** This document is the artifact the P8 harness
> ([docs/plans/substrate-v2/05-cost-model.md](../docs/plans/substrate-v2/05-cost-model.md) §3)
> fills with measurements. Until a cell below holds a measured number, there is no claimable
> saving. The paper's 62 % routing saving (paper §9) was measured on the 30 tasks its
> thresholds were tuned on and is **refuted**: on 80 held-out tasks, counting every escalation,
> routing cost 20.2 % _more_ than always-premium ([research/empirical-refutation/](../research/empirical-refutation/)).
> The plan's ~90 % figure is a **target** and a hypothesis, not a result, and does not appear in this table.
>
> **Corrected 2026-09-26.** The methodology below used to say the cost model "is multiplicative —
> `C = C₀ · Π(1 − fᵢ)` over independent stages — so each stage factor is measured separately and
> composed arithmetically", and that paired runs reprice "identical tokens". Stage savings interact
> (cache hits change the routed workload, context changes retries, halts can defer work), so the
> per-stage factors are diagnostics, not a total; and repricing tokens at another model's price is a
> counterfactual, not an observed outcome. The acceptance rule for any cost headline is in
> [05-cost-model.md §3](../docs/plans/substrate-v2/05-cost-model.md#3-acceptance-rule-for-any-cost-headline).

## Methodology

Each stage factor is measured separately as a diagnostic; the system is judged only on paired,
full-system outcomes (total cost per completed, externally verified task), never on a product of
stage factors:

1. **Instrumentation.** Every substrate stage appends one line to `.forge/metrics.jsonl`
   (`{t, stage, outcome, tokensIn, tokensOut, tier, savedEstimate, ref}` — `src/metrics.js`).
   `forge cost --stages` computes the per-stage factors from those lines (`src/cost_report.js`);
   a stage with no events reports **no data**, never a default.
2. **Paired runs.** Baseline (equivalent tools, context and repair opportunity; always-premium /
   read-everything reported too) vs. substrate over the same replay corpus (N ≥ 100 real tasks,
   stratified repeat-heavy / mixed / cold), each policy actually executed. Repriced tokens are a
   labelled counterfactual, not a measured saving.
3. **Correctness guard (spec §3).** A saving counts only if the external verifier passes the
   output. A routed-down answer that fails is not a saving; a cache hit that gets reverted is
   recorded as a *negative* entry.

## Run the paired pilot locally

The CLI accepts a frozen task list and two independently measured outcomes per task. It reads local files and writes new worksheets with owner-only permissions. Paid task execution, participant consent and independent verification happen in the operator's environment. The committed tests use synthetic observations. A production measurement still requires consented task records and actual bills.

```sh
forge cost pilot init suite.json
# Fill the task definitions, controls, consent reference and margins before freezing.
forge cost pilot freeze suite.json frozen.json
forge cost pilot template frozen.json runs.json
# Run both configurations against each frozen starting revision and fill both arms.
forge cost pilot compare frozen.json runs.json --json
```

1. **Freeze the design.** Record the ForgeKit revision, selection method, consent reference, held-out status, billing scope and the controls common to both arms. Use 100 or more distinct tasks for an eligibility decision. Each task needs a repository, full commit, task text, observable rubric and one workload stratum (`repeat-heavy`, `mixed` or `cold`). Select allowed quality and completion regressions before running the trial. The template suggests five points on the 0–100 quality scale and five percentage points of completion rate. Its consent fields start empty.
2. **Record every outcome.** Keep the generated arm configuration, starting revision and task/rubric fingerprint. For each arm record `status` (`verified`, `failed`, `abandoned`), the independent rubric's quality score, a distinct evidence locator and `actualUsd`. Include retries, escalations and failed attempts. Document any exclusions for verifier, tooling and cached usage in the frozen billing scope. Supply a billing reference for every observed charge, including a zero charge. Use JSON `null` for missing bills. Set the run ID, ISO billing date and both execution/verification attestations. Choose `source: "simulation"` for a dry run. Evidence locators and consent are operator attestations, suitable for subsequent review.
3. **Read the comparison.** Total spend divided by independently verified completions includes spend on failed and abandoned tasks. The report shows the known subtotal, missing bill count, completion rate and abandonment rate for each arm. Missing bills or a zero verified denominator leave the affected ratio unknown. The 95% cost interval resamples matched task pairs inside each frozen workload stratum, with 2,000 draws seeded from the suite hash. It estimates each arm’s USD per verified task and the paired candidate-minus-baseline difference. A bootstrap draw with a zero denominator leaves the cost interval unavailable.
4. **Interpret eligibility.** Each paired completion or quality difference is decomposed into a bounded gain and a bounded loss. Inverting the Bernoulli KL-Chernoff tail bound on their means and combining four tails yields a conservative 95% interval per endpoint, including when all observed differences are zero. The lower endpoints must clear the frozen noninferiority margins. Eligibility also requires an observed source, complete bills, all three strata, at least 100 tasks and a cost interval entirely below zero. Simulations always receive `simulation-only`. The decision applies to the frozen workload mix and assumes independent task pairs. Teams with related tasks from the same repository or time period should re-evaluate uncertainty at the repository or time-block level before generalizing. The comparator changes no runtime configuration.

## Measured factors

| stage | factor | events | measured? |
|---|---|---|---|
| gate (M2 halt rate) | — | 0 | no data yet — run with metrics enabled |
| cache (reuse, tier-weighted) | — | 0 | no data yet — run with metrics enabled |
| route (vs always-premium) | — | 0 | no data yet — run with metrics enabled |
| context (assembly ρ) | — | 0 | no data yet — run with metrics enabled |
| **composed (measured stages only; diagnostic, not a total)** | — | 0 | nothing to compose yet |

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
- The composed reduction covers **measured stages only** and is **not a bound**: unmeasured
  stages contribute nothing rather than a target, and a measured stage can be negative (it
  raised cost), so measuring another stage can lower the figure.
- Until the paired-run harness with the correctness guard has run, per-stage factors from
  live metrics are unguarded observational numbers, not eval results.
