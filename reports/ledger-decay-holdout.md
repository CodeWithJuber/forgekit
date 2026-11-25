# Does elapsed time help predict the next ledger outcome?

The current 45-day decay improved prediction on long-lived default-branch checks. The difference was small and inconclusive on short pull requests. Keep the existing default. Both samples measure public CI outcomes. Human corrections and private team lessons need their own longitudinal evidence before this result can justify a change to their policy.

## Observation and authority

One observation is the first concluded success or failure for a workflow and distinct tested commit in its scope. A default-branch stream is one workflow on `master`. A pull-request stream is CI on a single PR targeting `master`. The collector associates PRs by repository, branch and open interval and accepts only unique matches. It excludes cancellations, ambiguous matches and incomplete attempts. Repeated deliveries, workflow reruns and repeated citations of the same event cannot add votes. The source snapshot spans July 1 through November 23, 2026. Four default-branch workflows were queried. CI, Smoke and CodeQL returned qualifying push runs. The docs-links workflow had none. [Archived data and collector](https://github.com/CodeWithJuber/forgekit/issues/263)

For each forecast made from October 1 onward, the evaluator supplied `val()` only the evidence that had finished **before** that run started. It compared the published half-life with infinite half-life using the same oracle, evidence weights, prior, deduplication and trust caps. Confirmations are successes and contradictions are failures. Default-branch records cite a full Git commit verified in the local clone. PR evidence uses its public CI run locator, which receives the normal format-only trust cap. A sensitivity check also scores the default branch using only CI locators. Run IDs in the TSV resolve under `https://github.com/CodeWithJuber/forgekit/actions/runs/`.

## Time-ordered results

Brier loss is the mean squared distance between a forecast and the observed zero-or-one result. Lower is better. Signed calibration bias is the mean forecast minus the observed success fraction. The paired interval resamples seven-day blocks, preserving correlations across workflows in each block.

| Scope | Archived outcomes | Held-out forecasts | Observed success | Brier, 45 days | Brier, no decay | Calibration bias, 45 days / no decay | 95% interval for paired Brier difference |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Three default-branch workflows | 832 | 198 | 99.5% | 0.04962 | 0.09581 | −0.1722 / −0.2442 | −0.04760 to −0.04451 |
| CI on 235 pull requests | 444 | 144 | 65.3% | 0.2283 | 0.2284 | −0.2097 / −0.2103 | −0.00023 to +0.00005 |

Only one default-branch holdout run failed. Using CI locators for that cohort increased Brier loss to 0.2030 with decay and 0.2055 without it. Of the PR holdouts, 85 had zero or one earlier result. On that sparse subset, losses were 0.243235 and 0.243229 respectively. A completely unseen stream starts at 0.5 under either model. There were seven occupied held-out blocks on the default branch and eight on PRs. The intervals describe this repository and these periods.

At the cutoff and at the end, both models kept all three observed default-branch streams above the ledger's dormancy boundary. The PR cohort retained 179 of 182 observed streams at the cutoff and 228 of 235 at the end under either model. This measures eligibility under `isDormant()`. The usage-driven archival policy is a separate decision.

The evaluator is read-only. It never publishes or reactivates a lesson. A tombstone retires a claim. Serving a v2 correction still requires authenticated local corroboration or explicit approval of the exact revision. Human approvals are outside both measured cohorts. [Memory operating guide](../docs/MEMORY.md)

## Reproduce

The first two commands replay the frozen data offline in a full clone. Refreshing the source export additionally requires GitHub CLI access to the public Actions API. GitHub retention can change which historical run records remain available.

```sh
node bench/observations/ledger-decay.mjs master
node bench/observations/ledger-decay.mjs pr
python bench/observations/collect-ledger.py
```

