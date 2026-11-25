# Model routing

## Repository recommendations

`forge route "<task>"` selects an exact wire ID for the active provider when the operator has chosen a model or the repository has evidence. Without either it returns `status: "unrated"` and a null model. `forge route universal "<task>" --provider NAME` compares first attempts for the account-listed models bound to that profile. Filters include an explicit workload and a measured high, medium or low band. These recommendations are advisory. Native coding clients control their own model. [Provider inventory and configuration](MODELS-AND-COMPONENTS.md)

A local verifier event authenticates an attempt’s pass or fail verdict for the checkout and code state. The operator reports the task, model, workload and cost. The interval describes the recorded cohort. Selecting among candidate sequences on that cohort and changes behind a stable model alias can affect performance on future tasks. Outcomes with a recorded registry binding include the profile, wire model and transport fingerprint. Renaming a deployment or changing the endpoint makes its previous samples ineligible for account-scoped recommendations. Older rows without this binding remain readable for benchmark fitting. For each model and task, the first verified attempt is eligible. Replays and retries cannot improve the rate. For an exact repeat, the cohort is that task. Otherwise, models must have common tasks with a finite, nonnegative cost for every compared model. An empty intersection, an all-failing cohort or a stale provider listing yields no automatic selection.

For a candidate sequence and each common task, replay its recorded attempts in order until one passes. Divide the tasks solved by the number of tasks to obtain the observed success proportion. Sum the costs of the attempts reached on each task and average across tasks. This replay preserves correlations in both failures and attempt costs. Within a cohort the estimate comes with a descriptive two-sided 95% Wilson interval. The default chooses the cheapest sequence equaling or exceeding the best single model’s lower success bound. Every candidate has the same denominator. An explicit budget, target probability, or value per solved task changes the objective. The interval is descriptive after model selection and gives no guarantee of future success or charges.

Ordinary routing compares single models. For example, `forge route universal "Update the parser" --provider lab --workload repair --depth 2 --objective target:0.8` can compare one- and two-model sequences. A target must be met by the lower Wilson bound. An infeasible objective returns a labeled fallback. `forge route calibrate --workload repair` reports per-model leave-one-task-out Brier scores from verified first attempts when at least two tasks exist.

## Offline benchmark comparison

Without a provider, `forge route universal` uses the public SWE-bench fit or a local refit. Registry-only models with no fitted outcomes are excluded. The public experiment estimates results on its historical scaffold. Current account inventory and local workload evidence are separate sources.

On 2026-11-25 the prior was refitted from 5,500 scored attempts on 500 public tasks across 11 models. Its inputs are the logarithms of prompt character count and newline count, and half the count of Markdown code fences. All coefficients were refitted after removing the handwritten rubric features. The all-task fit selected one latent dimension and prior scale 4. A second fit reproduced all 162 values compared by the strict reproduction script, excluding the timestamp. The seeded replay trained on 150 development tasks and evaluated on 350 held-out tasks. It solved 80.0% at $0.128 per task. The development-selected fixed cascade solved 80.6% at $0.136. The paired bootstrap difference in success was −0.6 percentage points (95% interval −1.4 to 0.0). Results below dated September describe the previous feature set. [Inputs and reproduction commands](../bench/universal-router/README.md)

[![Three observed text measurements and fitted costs produce an offline benchmark comparison of cascades. A caller verifies attempts and records their outcomes.](diagrams/router-cascade.svg)](https://jubershaikh.com/forgekit/diagrams/router-cascade.html)

## The model

**1. Who solves what: multidimensional item response theory.**

```
P(model m solves task j | θ_j) = σ( a_m − w·x_j + λ_m·θ_j ),   θ_j ~ N(0, I_k)
```

| Symbol | Meaning |
|---|---|
| `a_m` | the ability of model m |
| `x_j` | three observable text counts standardized on training data |
| `w` | learned weights that turn features into a difficulty, so unseen tasks get one |
| `θ_j` | the difficulty the features miss, shared by all models through their loadings `λ_m` |

The shared `θ_j` is what makes failures correlated: if one model fails a task, others are more likely to fail it too. On the public data, P(Opus 4.5 solves | MiniMax M2.5 failed) is 0.25, against 0.77 unconditionally.

**Fitting.**
- The fit maximises the marginal posterior, with θ integrated by Gauss–Hermite quadrature. The nodes are computed with Golub–Welsch, not tabulated.
- The optimiser is L-BFGS with analytic gradients.
- Observations can be sparse: each task may have been tried by any subset of models.
- The latent dimension k and the prior scale are chosen by K-fold cross-validated likelihood, and the scale grid expands past its edge while the likelihood improves.

**2. What an attempt costs.**

```
log cost = α_m + β·x + ε,   E[cost] = exp(α_m + β·x + s²/2)
```

- `α_m` and the shared slope `β` are fitted by least squares on observed attempt costs.
- A model that has prices but no observed attempts takes `α_m` from its price. For models with both, `α − log(blended price)` is close to constant, and the input/output blend is chosen to make it most constant.

**3. Choosing a cascade.** For a cascade s = (m₁, m₂, …), with node probabilities `P[m][q]` and weights `w_q`:

```
P(s solves)  = 1 − Σ_q w_q Π_{m∈s} (1 − P[m][q])
E[cost of s] = Σ_i c_{m_i} · Σ_q w_q Π_{l<i} (1 − P[m_l][q])
```

Every ordered cascade of up to 3 candidates is evaluated; `--depth` bounds the search. The objective is the user's stated preference:

| Objective | Chooses | What it is not |
|---|---|---|
| `match-best-single` (default, no parameter) | the cheapest cascade at least as likely to succeed as the best single candidate for this task | — |
| `target:p` | the cheapest cascade with predicted P(success) ≥ p | not a guarantee of success ≥ p: predicted success was optimistic by 4–6 points on the run-4 test split (see [Modeling limits](#modeling-limits)) |
| `value:V` | the cascade that maximises V·P(success) − E[cost] | — |
| `budget:B` | the most likely cascade with **expected** cost E[cost] ≤ B | not a runtime spend cap: one task's cascade can cost up to the sum of every attempt in it, and E[cost] itself is under-predicted (see [Modeling limits](#modeling-limits)) |

**When no cascade satisfies the objective.** A `budget:B` or `target:p` that nothing can meet is reported as infeasible, never as a quiet best effort: the result carries `feasible: false`, `budgetMet: false` for a budget objective, the `minimumExpectedCost` any candidate cascade achieves, the `estimatedCostIfAllAttemptsRun` of the recommended cascade (the sum of every attempt's expected cost — a modeled figure for the path where each stage runs, not a bound on what a run can bill; formerly `maxPossibleCost`), and a `reason`, and `forge route universal` prints an explicit `INFEASIBLE` line. The caller must choose a fallback. Expected cost, the estimated cost if every attempt runs, and the cost actually charged are three different numbers; forgekit advises, and enforcing a hard spend cap belongs to whatever runs the attempts.

**4. Learning locally.** Record a result using `forge route outcome "<task>" --model REGISTRY_ID --pass --cost USD --verify-run RUN_ID`. A self-reported outcome remains inspectable. Only authenticated verdicts are eligible for fitting. `forge route fit` updates the benchmark’s ability and cost parameters toward local observations. It rejects an empty verified training set. Historical outcome vectors are read using their three shared measurements. Older fitted coefficients require a new fit.

## Shipped prior

`data/router_prior.json` was fitted on public per-task results, and `bench/universal-router/README.md` shows how to regenerate it:

- **Tasks:** the 500 SWE-bench Verified issues (Hugging Face `SWE-bench/SWE-bench_Verified`, revision `78f471b`; that revision is not in `princeton-nlp/SWE-bench_Verified`).
- **Runs:** eleven models from seven providers with the same scaffold (mini-SWE-agent 2.0.0), one attempt each, dated February 2026.
  - Anthropic: Claude Haiku / Sonnet / Opus 4.5 and Opus 4.6
  - OpenAI: GPT-5.2 and GPT-5 mini
  - Google: Gemini 3 Flash
  - Moonshot: Kimi K2.5
  - MiniMax: M2.5
  - DeepSeek: V3.2
  - Z-AI: GLM-5
- **Selection:** cross-validation chose k = 1 at prior scale 4. Scale 2 had been the edge of the first grid, so the grid kept expanding until the held-out likelihood stopped improving.

**What the shipped prior can and cannot tell you.**
- It is fitted on **all 500** tasks, so it cannot be evaluated out of sample on any of them. The 150/350 experiments below fit a *different* model on 150 tasks; their numbers are not a test of the shipped prior, and the two must stay separate.
- The outcomes come from one scaffold, on Python repositories, at February 2026 prices. They are a historical, relative comparison of those runs, not present-day model economics or general coding capability.
- The benchmark itself has known label problems. OpenAI's 2026-02-23 analysis ([why OpenAI no longer evaluates SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)) reports flawed tests in **59.4% of an audited 138-problem hard subset** — not 59.4% of all 500 tasks — plus evidence of training-data contamination. More benchmark volume alone does not fix contamination or label validity.

## Held-out benchmark (repository-reported)

> Repository-reported; produced by an external harness (harness-bench) that is not shipped here; not independently reproduced as of 2026-09-26.

harness-bench run 4 is pre-registered. It fits on 150 dev issues and scores 350 held-out issues against each model's real outcome and cost.

| Policy | Solved | $ per task |
|---|---|---|
| universal router, `match-best-single` | 76.3% | $0.093 |
| best single model chosen on dev (Gemini 3 Flash) | 75.1% | $0.364 |
| always Claude Opus 4.5 | 77.4% | $0.760 |
| universal router, `target:0.9` | 81.4% | $0.260 |

**Against the best single model:** non-inferior (+1.1 points, CI [−2.0, +4.3]) at 74% lower cost. In 5-fold cross-validation it is +3.2 points (CI [+0.4, +6.2]) at −$0.58 per task.

**Against a fixed cascade — the baseline that matters.** Most of the gain comes from choosing across providers. On the 150-issue fit the router does **not** beat a fixed cascade chosen on the same dev data; with 400 training issues its target modes are cheaper than the fixed equivalents (repository-reported). The in-repo replay below finds the same on a new split. A fixed cascade selected on dev data is an essential baseline for any routing claim.

**Re-run reported by the project (2026-09-22).** The project reports re-running run 4 from the pinned public data on a second machine with the same external harness: 217 of 218 held-out metric values identical (only the wall-clock `fitSeconds` of the 150-issue dev fit differs, 37.6 s against 45.9 s), and the shipped prior refit identical. This is the repository's own report, not an independent third-party replication. See `bench/universal-router/README.md`.

## A new held-out replay in this repository (2026-09-26)

> A new experiment, not a reproduction of run 4. Source: `bench/universal-router/README.md`, run on 2026-09-26.

`bench/universal-router/holdout_eval.mjs` shuffles the same 500 tasks with seed 20260926 into 150 dev and 350 held-out tasks, fits on the dev tasks only (the shipped prior is never used), routes each held-out task from its text with `match-best-single`, and replays the cascade against the recorded outcomes and costs. Every baseline is chosen on dev only. Intervals are 95% paired-bootstrap intervals over held-out tasks (10,000 draws).

| Held-out, 350 tasks | Solved | $ per task |
|---|---|---|
| universal router, `match-best-single` (dev fit) | 80.0% | $0.124 |
| best single model on dev (claude-opus-4.5) | 76.0% | $0.768 |
| cheapest single model on dev (gpt-5-mini) | 57.4% | $0.047 |
| best fixed cascade on dev (minimax-m2.5 > gpt-5-mini > kimi-k2.5) | 80.6% | $0.136 |

- **Against the fixed cascade the router shows no advantage on solve rate:** −0.6 points [−1.4, 0.0] at −$0.012 per task [−$0.024, −$0.003]. It is marginally cheaper; it solved no task the cascade missed, and the cascade solved two that it missed. Five further seeds, run after this result as a sensitivity check, keep it within −0.6 to +1.1 points of the dev-chosen fixed cascade, and in no split is it both more accurate and cheaper.
- **Against the best single model on dev** it solves +4.0 points [+0.6, +7.4] at −$0.644 per task, mostly because one cheap model (minimax-m2.5) opens 308 of the 350 cascades. That comparison depends on which model wins dev: across the six splits the interval excludes zero only for seed 20260926.
- **The replay is optimistic about deployment.** It stops at the first attempt whose recorded label is "resolved", which assumes a perfect, free check between attempts; a deployed cascade needs its own verifier, which can be wrong and costs money. The same data limits apply as to the shipped prior: one scaffold, one attempt per model and task, twelve Python repositories, February 2026 costs.

## Historical reproduction record (2026-09-26)

| Part | Where | Status |
|---|---|---|
| Public inputs | Hugging Face `SWE-bench/SWE-bench_Verified` @ `78f471b` (not `princeton-nlp/SWE-bench_Verified`, which does not contain that revision); the eleven `per_instance_details.json` files at SWE-bench/experiments `40f164d` | Pinned with URL, revision, size and sha256 in `bench/universal-router/sources.json`; `build_input.py` checks every download against them |
| Building the fit input (`universal_all.json`) | `bench/universal-router/build_input.py` | **In this repository**; no harness-bench needed |
| Prior refit | `bench/universal-router/reproduce.sh` (build the input, refit with `fit_prior.mjs`, compare with `compare_priors.mjs`) | **Reproduced exactly in this repository (2026-09-26).** From an empty work directory, all 176 fitted values were identical to the prior shipped at that revision (only `provenance.fittedAt` differs), with the router code of `d2abfa6` and again with the review changes committed in `aedddf5`. The refit takes about 7 minutes (413–424 s on a 4-vCPU Intel Xeon @ 2.80GHz, Node v22.22.2, Python 3.11.15). The external review of 2026-09-26 stopped its refit at a 180-second limit, which was too short: not evidence against the fit. The 37.6 s and 45.9 s in the 2026-09-22 report are the 150-issue dev fit inside the held-out test, not this 500-issue refit. These are the project's own runs: the calculation reproduces; no third party has replicated it |
| Run-4 held-out benchmark (150/350 split ids, pre-registration, metric aggregation, bootstrap) | harness-bench `test universal` | **Not reproducible from this repository**; the split ids, harness, metric JSON and environment lock would have to be published or pinned for a cold machine to reproduce the table above |
| A new held-out replay (a different split; not run 4) | `bench/universal-router/holdout_eval.mjs` | **In this repository**; refits on dev tasks only and compares against baselines chosen on dev, including a fixed cascade. Results [above](#a-new-held-out-replay-in-this-repository-2026-09-26); it does not stand in for run 4 |

## Modeling limits

- **Conditional independence and point estimates.** The MIRT factor integrates a latent task difficulty, which is a reasonable way to model correlated failures, but the model still assumes attempts are conditionally independent given the latent variables, and it uses fitted point estimates of the parameters.
- **Local refits shrink; they do not track uncertainty.** `forge route fit` is a MAP update centred on the shipped parameters, not a posterior with transferred covariance, and cold models at population-mean ability carry substantial epistemic uncertainty the recommendation does not display.
- **The cascade cost formula under-predicts cost.** `E[cost of s]` multiplies each attempt's unconditional expected cost by the probability of reaching it, which assumes `E[cost_i | earlier attempts failed, x] = E[cost_i | x]`. On the recorded data that assumption does not hold. In the in-repo replay (seed 20260926) the chosen cascades' expected cost was $0.102 per task against $0.124 replayed, and cost was under-predicted in all six splits, by 5% to 22% of the replayed cost: a failed attempt costs on average 1.2 to 2.0 times as much as a successful one, for every model, and a later attempt is reached only after a failure (source: `bench/universal-router/README.md`). Until the cost model conditions on earlier outcomes, read `E[cost]`, and so `budget:B`, as optimistic.
- **Targets are optimistic.** Predicted cascade success was optimistic by 4 to 6 points on the run-4 test split (repository-reported), so `target:p` lands below p. In the in-repo replay (`match-best-single`), predicted minus observed success ranged from −2.8 to +9.1 points across six splits (80.2% predicted against 80.0% observed for seed 20260926). `target:p` is not a guarantee until there is an out-of-fold calibration map, reliability intervals and an explicit abstention policy.
- **Budgets are expectations.** `budget:B` constrains expected cost, not spend; see the infeasibility contract above.
- **One scaffold, text-only features.** The data is one agent scaffold and text-only features, with February 2026 prices. Re-fit on your own outcomes.

## Next evidence

The evidence that would test the router rather than its training data: fresh, time-held-out tasks (private or permissioned) or unseen repositories; another agent scaffold; another language; and actual end-to-end spend under an external hard cap, not repriced tokens. SWE-bench Multilingual can support a separate transfer study only after its license and task setup are checked — its [dataset documentation](https://www.swebench.com/SWE-bench/guides/datasets/) describes 300 tasks across nine languages. Report the full cost/success curve with paired uncertainty, and the fixed-cascade baseline beside it.

## Monitor a frozen model for regressions

Run `forge route monitor observations.json --json` on an exported set of anchor results. The command reads a local JSON file of up to 16 MiB and prints `cold-start`, `normal` or `review`. Every valid outcome is advisory and exits successfully. Invalid evidence exits with an error. Review the underlying test results before changing a model’s band. The command makes zero model requests and writes no routing or model configuration.

Freeze the provider, exact model ID, immutable deployment revision and evaluation protocol before collection. The protocol digest should cover the anchor definitions, grader, sampling settings, retry policy, tools and execution environment. If a provider supplies only a mutable alias and no deployment identifier, the model revision cannot be established for this comparison. A run is a fresh independent repetition of **every** anchor. Fix the evaluation horizon in runs, the smallest meaningful absolute decrease in pass rate, and the per-window false-alarm budget before inspecting outcomes.

This empty, synthetic specification returns `cold-start`. Replace its identifiers and example digest with recorded provenance before evaluating a model.

```json
{
  "schemaVersion": 1,
  "subject": {
    "provider": "example", "model": "model-A", "revision": "release-001",
    "protocolSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "anchors": ["rename", "review"],
  "alpha": 0.05, "meaningfulDrop": 0.10, "horizon": 8,
  "independentRuns": true, "stableHistory": true,
  "fit": [], "calibration": [], "evaluation": []
}
```

Place baseline runs in `fit`. Put separate stable windows inside `calibration`, each containing exactly `horizon` runs. Put the subsequent window of runs directly in `evaluation`. Each run has a unique `id`, a UTC ISO `at` timestamp (seconds or milliseconds), a copy of the four `subject` fields and an `outcomes` object such as `{"rename":true,"review":false}`. All three splits use the identical anchor IDs. Run timestamps increase strictly across the entire file. Exclude infrastructure outages from collection only under a predeclared missing-data policy. Record such exclusions in the study log to avoid selectively dropping failures.

For each run, compute its fraction of failed anchors `f`. Let `b` be the mean failure fraction across the fit runs and `d` the predeclared meaningful drop. Reset the one-sided CUSUM at the start of each window and update `C = max(0, C + f − b − d/2)`. Each stable calibration window supplies its maximum `C`. With `n` stable windows, the boundary is the `ceil((n+1)(1−alpha))`-th smallest calibration maximum. If the required rank exceeds `n`, the result is `cold-start`. At `alpha=0.05`, at least 19 complete calibration windows are needed. A missing fit or unfinished evaluation also returns `cold-start`.

An evaluation maximum strictly above the boundary returns `review`, including the first crossing run ID. A tie returns `normal`. The empirical p-value is `(1 + number of calibration maxima ≥ evaluation maximum)/(n+1)`. Under exchangeable stable calibration and evaluation windows conditional on the separate fit data, this limits the marginal false-review probability for one fixed horizon. The input declarations describe the data collector’s assumptions. Duplicate IDs and mixed protocols can be detected from the file. Honest independence, version immutability and environmental stability require collection receipts. Repeated monitors, overlapping windows, post-hoc parameter choices and pooled model comparisons need their own error-budget design. A normal window can still miss a small degradation. [Page’s CUSUM procedure](https://doi.org/10.1093/biomet/41.1-2.100) · [Introduction to conformal prediction](https://arxiv.org/abs/2107.07511)
