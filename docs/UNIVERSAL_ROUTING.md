# Universal routing

`forge route universal` recommends a model, or a cascade of models ("try A; if a check fails, try B"), for a task. It works with any provider's models.

The router code names no vendor, model, tier or threshold, and a test enforces that. Models come from data (`data/models.json`, plus `.forge/models.json` in a project). What each model can do and what it costs is learned from recorded outcomes.

> **Evidence status (2026-09-26).** Three results, kept apart:
>
> - **The run-4 held-out headline** (76.3% solved at $0.093 per task) is **repository-reported**. It was produced by an external harness (harness-bench) that is not shipped here; its split ids, pre-registration and metric code are not in this repository, and it has not been independently reproduced.
> - **The shipped prior's refit is reproduced in this repository.** `bench/universal-router/reproduce.sh` downloads the pinned, sha256-checked public inputs and refits `data/router_prior.json`; on 2026-09-26 all 176 fitted values came out identical (only `provenance.fittedAt` differs). That shows the calculation reproduces. It is the project's own run, not an independent third-party replication (see [Reproducibility](#reproducibility)).
> - **A new held-out replay in this repository** (a different split, not run 4) finds that the router does **not** beat a fixed cascade chosen on the same dev tasks: 80.0% solved at $0.124 per task, against the cascade's 80.6% at $0.136 ([details](#a-new-held-out-replay-in-this-repository-2026-09-26)).
>
> The shipped prior is a useful initialization, not a guarantee about your workload. The universal router is a separately versioned component from the old tiered router whose 62.1% saving was refuted (`research/empirical-refutation/`); neither result transfers to the other.

## The model

**1. Who solves what: multidimensional item response theory.**

```
P(model m solves task j | θ_j) = σ( a_m − w·x_j + λ_m·θ_j ),   θ_j ~ N(0, I_k)
```

| Symbol | Meaning |
|---|---|
| `a_m` | the ability of model m |
| `x_j` | task features (text; repository signals when a repo is present) |
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

**When no cascade satisfies the objective.** A `budget:B` or `target:p` that nothing can meet is reported as infeasible, never as a quiet best effort: the result carries `feasible: false`, `budgetMet: false` for a budget objective, the `minimumExpectedCost` any candidate cascade achieves, the `maxPossibleCost` of the recommended cascade (the sum of all its attempts' costs — the worst case), and a `reason`, and `forge route universal` prints an explicit `INFEASIBLE` line. The caller must choose a fallback. Expected cost, the maximum possible cascade cost and the cost actually charged are three different numbers; forgekit advises, and enforcing a hard spend cap belongs to whatever runs the attempts.

**4. Learning locally.**
- `forge route outcome "<task>" --model <id> --pass|--fail [--cost <usd>] [--attempt <id>] [--verify-run <run id>]` records the result of one attempt. Only a hash of the task and its features are stored, never the text. The pass/fail is entered by the caller, so a record is labelled `provenance: "self-reported"`; with `--verify-run`, naming a `forge verify` run in this checkout's verifier-event log whose PASS or FAIL agrees with it, the record is labelled `provenance: "verify-event"` instead (a disagreeing or missing run is refused). Every record carries an `attemptId` (`--attempt`, or a fresh id when omitted), and recording the same attempt id again counts once, so a retry or a replayed outcomes file cannot count one attempt twice. Records are schema-validated when written and when read.
- `forge route fit` refits with the shipped fit as the prior mean. It is a MAP, empirical-Bayes-style **shrinkage** update — a few local outcomes barely move it and many outcomes dominate — not a maintained posterior: it returns a point estimate and carries no covariance over from the shipped fit.
- Cost intercepts are updated with a unit-information prior.
- A model in the registry but not in the fit enters "cold", at the population-mean ability and loadings, until outcomes arrive. Its point estimate hides a large epistemic uncertainty.

**5. Candidates.**
- `--provider <name>` limits the candidates to models that provider can serve (the `providers` map in the registry).
- `--provider any` (the default) gives advice across every model.
- The shipped registry gives provider ids only for Anthropic models; the other seven registry entries are recommended by id but cannot be applied until you add a provider id. Add ids for OpenRouter, a LiteLLM gateway or a native API in `.forge/models.json`. Registry presence is not availability: a model with no provider id is advice only. The CLI marks such a cascade step `no provider id` and prints an `advice only` line; `--json` gives each step its `providers` and `costSource`, plus `applicable: false` and the `unmapped` models. Where the registry has prices, each carries its source and the date it was checked.

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

## Reproducibility

| Part | Where | Status |
|---|---|---|
| Public inputs | Hugging Face `SWE-bench/SWE-bench_Verified` @ `78f471b` (not `princeton-nlp/SWE-bench_Verified`, which does not contain that revision); the eleven `per_instance_details.json` files at SWE-bench/experiments `40f164d` | Pinned with URL, revision, size and sha256 in `bench/universal-router/sources.json`; `build_input.py` checks every download against them |
| Building the fit input (`universal_all.json`) | `bench/universal-router/build_input.py` | **In this repository**; no harness-bench needed |
| Prior refit | `bench/universal-router/reproduce.sh` (build the input, refit with `fit_prior.mjs`, compare with `compare_priors.mjs`) | **Reproduced exactly in this repository (2026-09-26).** From an empty work directory, all 176 fitted values are identical to `data/router_prior.json` (only `provenance.fittedAt` differs), with the router code of `d2abfa6` and again with the review changes committed in `aedddf5`. The refit takes about 7 minutes (413–424 s on a 4-vCPU Intel Xeon @ 2.80GHz, Node v22.22.2, Python 3.11.15). The external review of 2026-09-26 stopped its refit at a 180-second limit, which was too short: not evidence against the fit. The 37.6 s and 45.9 s in the 2026-09-22 report are the 150-issue dev fit inside the held-out test, not this 500-issue refit. These are the project's own runs: the calculation reproduces; no third party has replicated it |
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

## Relation to `forge route`

`forge route` (tiered: haiku / sonnet / opus / fable) is unchanged and remains the default for Claude Code model selection. The universal router is opt-in: run `forge route universal`, or set `route.objective` in `.forge/config.json` to choose its default objective.
