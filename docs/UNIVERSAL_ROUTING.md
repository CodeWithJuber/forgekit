# Universal routing

`forge route universal` recommends a model, or a cascade of models ("try A; if a check fails, try B"), for a task. It works with any provider's models.

The router code names no vendor, model, tier or threshold, and a test enforces that. Models come from data (`data/models.json`, plus `.forge/models.json` in a project). What each model can do and what it costs is learned from verified outcomes.

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

| Objective | Chooses |
|---|---|
| `match-best-single` (default, no parameter) | the cheapest cascade at least as likely to succeed as the best single candidate for this task |
| `target:p` | the cheapest cascade with P(success) ≥ p |
| `value:V` | the cascade that maximises V·P(success) − E[cost] |
| `budget:B` | the most likely cascade with E[cost] ≤ B |

**4. Learning locally.**
- `forge route outcome "<task>" --model <id> --pass|--fail --cost <usd>` records a verified result. Only a hash of the task and its features are stored, never the text.
- `forge route fit` refits with the shipped fit as the prior mean. This is a Bayesian update: a few local outcomes barely move it, and many outcomes dominate.
- Cost intercepts are updated with a unit-information prior.
- A model in the registry but not in the fit enters "cold", at the population-mean ability, until outcomes arrive.

**5. Candidates.**
- `--provider <name>` limits the candidates to models that provider can serve (the `providers` map in the registry).
- `--provider any` (the default) gives advice across every model.
- The shipped registry gives provider ids only for Anthropic models. Add ids for OpenRouter, a LiteLLM gateway or a native API in `.forge/models.json`.

## Shipped prior

`data/router_prior.json` was fitted on public per-task results, and `bench/universal-router/README.md` shows how to regenerate it:

- **Tasks:** the 500 SWE-bench Verified issues.
- **Runs:** eleven models from seven providers with the same scaffold (mini-SWE-agent 2.0.0), one attempt each, dated February 2026.
  - Anthropic: Claude Haiku / Sonnet / Opus 4.5 and Opus 4.6
  - OpenAI: GPT-5.2 and GPT-5 mini
  - Google: Gemini 3 Flash
  - Moonshot: Kimi K2.5
  - MiniMax: M2.5
  - DeepSeek: V3.2
  - Z-AI: GLM-5
- **Selection:** cross-validation chose k = 1 at prior scale 4. Scale 2 had been the edge of the first grid, so the grid kept expanding until the held-out likelihood stopped improving.

## Measured

harness-bench run 4 is pre-registered. It fits on 150 dev issues and scores 350 held-out issues against each model's real outcome and cost.

| Policy | Solved | $ per task |
|---|---|---|
| universal router, `match-best-single` | 76.3% | $0.093 |
| best single model chosen on dev (Gemini 3 Flash) | 75.1% | $0.364 |
| always Claude Opus 4.5 | 77.4% | $0.760 |
| universal router, `target:0.9` | 81.4% | $0.260 |

**Against the best single model:** non-inferior (+1.1 points, CI [−2.0, +4.3]) at 74% lower cost. In 5-fold cross-validation it is +3.2 points (CI [+0.4, +6.2]) at −$0.58 per task.

**Limits (measured):**
- **Where the gain comes from.** Most of it comes from choosing across providers. On the 150-issue fit the router does not beat a fixed cascade chosen on the same dev data; with 400 training issues its target modes are cheaper than the fixed equivalents.
- **Targets are optimistic.** Predicted cascade success is optimistic by 4 to 6 points on the test split, so `target:p` lands below p. A cross-validated calibration map is the planned fix.
- **One scaffold, text-only features.** The data is one agent scaffold and text-only features, with February 2026 prices. Re-fit on your own outcomes.

## Relation to `forge route`

`forge route` (tiered: haiku / sonnet / opus / fable) is unchanged and remains the default for Claude Code model selection. The universal router is opt-in: run `forge route universal`, or set `route.objective` in `.forge/config.json` to choose its default objective.
