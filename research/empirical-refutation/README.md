# Replication package

*Static Impact Analysis Does Not Transfer: A Pre-Registered Refutation of Two LLM-Agent Reliability Mechanisms*

> **Corrected 2026-09-21** — see [Corrections](#corrections-2026-09-21) at the end. The PDFs in
> this directory predate the corrections; the LaTeX and HTML sources carry them.

This package contains everything needed to check every number in the paper. It is organised so that
a reviewer can start from the frozen protocol and work forward, in the order the work was actually
done.

**Read `protocol/PRE_REGISTRATION.md` first.** It was written and frozen before any repository was
cloned, and it fixes every threshold, filter, and selection rule used downstream. Its own stated
rule is the one thing that makes the rest of this package meaningful: *if a downstream number looks
bad, the fix is to report it, not to edit this file.* Amendments were permitted only as dated,
append-only addenda; three were filed, all documenting the corpus-selection funnel.

## What is here

### `protocol/` — the frozen contract
| File | What it is |
|---|---|
| `PRE_REGISTRATION.md` | Nine corpus eligibility criteria, commit filters, threshold grid, bootstrap seeds. Frozen before data collection. |
| `corpus_manifest.json` | The nine repositories with exact clone SHAs, the eligibility decisions, and every substitution logged. |
| `SPLIT_DECLARATION.json` | The tuning/held-out repository split for the repair, declared before any repair code was written. |
| `FROZEN_PARAMETERS.json` | The eight repair parameters, fixed on tuning repositories only, before the held-out set was touched. |

### `data/` — the ground truth
| File | What it is |
|---|---|
| `cochange_groundtruth.parquet` | 801 labelled files across 9 repositories. For each file, the other Python files that co-changed with it in the same non-merge commit, after the pre-registered filters. |
| `heldout_taskset.json` | 80 tasks drawn from real GitHub issues and PRs, with full provenance (repo, number, URL, verbatim text), gold labels, the labelling protocol, and a second independent labelling pass. |

### `results/` — every number in the paper
| File | What it is |
|---|---|
| `cochange_results.json` | Per-repo and pooled P/R/F1 with bootstrap CIs, the full threshold sweep, the per-file recall distribution. |
| `cochange_failure_modes.json` | All 18,221 false negatives classified structurally, with the ground-truth ceiling. |
| `cochange_report.md` | The written evaluation, including threats to validity. |
| `heldout_results.json` | Routing and gate metrics with CIs, inter-rater agreement, calibration bins, and the full cost accounting. |
| `repair_results.json` | The (a)–(g) repair sequence: as-shipped reproduction, each fix, tuning and held-out results. |
| `repair_report.md` | The written before/after. |
| `novelty_assessment.json` | Five claimed contributions graded against closest prior work, including the scoop. |
| `related_work.md`, `related_references.json` | The full survey and 52 graded references. |
| `internal_review_findings.json`, `internal_review_report.md` | Our own adversarial review of this paper, and what it found wrong. Included deliberately: it lists four numbers we had stated incorrectly before correction. |

### `prototypes/` — the code under test
| File | What it is |
|---|---|
| `impact_oracle_v1_as_shipped.zip` | The version whose claims the paper refutes. 36 tests. |
| `impact_oracle_v2_src.zip` | The repaired version. 49 tests, including the stdlib-collision safety case. |
| `router_gate_src.zip` | The router and assumption gate, thresholds exactly as evaluated. 19 tests. |

Each package runs with `python -m pytest` from its own root (a `conftest.py` handles the path).
The oracle needs `networkx`; the router needs only `pytest`.

### `figures/`, `paper/`
The six figures at full resolution, and the paper with its LaTeX source and bibliography.

## Verifying the headline claims

**The refutation.** `results/cochange_results.json` → `pooled_metrics.oracle_by_threshold["0.02"]`
gives precision 0.398, recall 0.022, F1 0.042 from tp/fp/fn = 409/618/18221. The grep baseline in the
same file gives F1 0.437. Every F1 in the paper is computed from raw counts and rounded once.

**The ceiling.** `results/cochange_failure_modes.json` → the three failure categories
(94.68% sibling, 2.13% forward-only, 3.19% no static path) sum over the 18,221 false negatives.
The 3.19% figure is what bounds achievable recall at 96.88%.

**The repair.** `results/repair_results.json` → `d_defect1and2_heldout_HEADLINE`. The paper headlines
`metrics_at_canonical_0.02` (F1 0.416), not the higher `metrics_at_best_threshold` (0.428), because
the latter's threshold was selected on the tuning repositories.

**The held-out collapse.** `results/heldout_results.json` → `tuned_vs_heldout_comparison`.
Note `cost_analysis.n_execution_verified = 0`: no held-out task admitted execution-based
verification, so correctness used a weaker model-based criterion.

**The cost inversion.** `results/heldout_results.json` → `cost_analysis` carries four figures along two
orthogonal axes, and the paper reports all four rather than the most favourable one. Framing:
`first_attempt_framing` counts only the initially-routed attempt; `escalation_inclusive_framing` counts
everything the pipeline spent retrying up the tier ladder. Gating: `raw_saving_pct` credits every dollar
saved, `correctness_gated_saving_pct` credits only dollars saved on output that verifies. The tuned
demonstration's 62.1% corresponds to first-attempt/ungated (59.5% held out). The honest total-spend,
ungated figure is **−20.2%**: the router costs more than always using the premium tier. The source's own
`honesty_note` states this.

## What this package cannot establish

The pre-registration, the split declaration, and the parameter freeze were all self-administered
within one continuous working session. There is no external timestamping authority. A reader can
verify internal consistency and the append-only amendment trail, but must take the ordering on
trust. We regard this as the central weakness of a self-evaluation and state it in the paper rather
than resting on the protocol's authority.

Co-change is a proxy for semantic impact and errs in both directions: files co-change for reasons no
static analysis can predict, and an over-warning may be a correct dependency that has not yet
co-changed. The 96.9% ceiling is measured on the graph the as-shipped oracle builds, and reachability
in a dense graph is a weak property — it bounds what any static method could attain, and is not
evidence that a reachable pair is causally related.

## Corrections (2026-09-21)

An external deep review of the repository recomputed every statistic from this package. The
counts reproduced exactly; some inferences did not. `paper/main.tex` (in this directory) and
`extended_preprint.html` are corrected in place, with dated Corrections sections that quote the
original wording. **`paper.pdf` and `extended_preprint.pdf` predate the corrections** (no TeX or
WeasyPrint toolchain was available to rebuild them), and the copies of the paper inside
`replication_package.tar.gz` are left exactly as published.

- **Cluster the bootstrap.** Every ground-truth pair is mirrored (all 20,144 pairs among the 801
  labelled files are counted from both ends) and files cluster in nine repositories, so the
  file-resampled intervals are too narrow. Resampling repositories (seed 1234, 20,000 resamples):
  oracle precision [0.15, 0.91], recall [0.0005, 0.052]; the refutation survives, oracle F1
  [0.001, 0.093] against grep's [0.381, 0.539].
- **801 vs 759.** 801 files are labelled; 759 are evaluated, because the pre-registered cap of 200
  files per repository cut pytest from 242 to 200.
- **The repair does not demonstrably beat grep.** Paired ΔF1 is +0.044 at t = 0.02; at t = 0.10
  all three held-out repositories favour the oracle, but three out of three is a one-sided
  sign-test p of 0.125, pytest supplies 71% of the held-out pairs, and the choice of which
  relations to add was made on all nine repositories.
- **One model made the labels.** The gold labels and the second pass are the same model with two
  prompts (n = 30), and it is also the judge and the mid-tier executor, so κ measures prompt
  robustness, not label validity.
- **Cost per accepted output.** $1.06 for the pipeline against $1.76 for always-premium, from 6 and
  3 accepted outputs of 64; 58 of 64 tasks failed at every tier, which is what makes the −20.2%
  largely mechanical.
- **The ceiling** counts pairs with any static path, treats symmetric co-change as directional
  impact, and had no random-pair control, so "96.8% fixable" is now read as a bound.
- **Calibration.** Bins held 27/5/28/4/16 tasks because of ties; ECE is 0.103 or 0.078 depending on
  tie handling; the 2-of-4 bin has p = 0.028 against the middle bin's accuracy, so it is not "well
  within sampling noise".

Re-derive them with [`../recompute_corrections.py`](../recompute_corrections.py) (standard-library
Python): extract this package and run `python research/recompute_corrections.py <dir>/repro`.
