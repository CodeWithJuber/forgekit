# Universal router: shipped prior

`data/router_prior.json` is the fit the universal router uses until a project records its own
outcomes (`forge route outcome`, then `forge route fit`). It was fitted from public per-task
results:

- **Tasks:** the 500 issues of SWE-bench Verified (Hugging Face `SWE-bench/SWE-bench_Verified`, revision `78f471b`). The issue text (`problem_statement`) is the task.
- **Runs:** eleven models from seven providers, each run once per issue with the same agent scaffold (mini-SWE-agent 2.0.0), taken from SWE-bench/experiments @ `40f164d` (runs dated 2026-02-17). Each run gives a verified resolved/unresolved outcome and the observed cost.

The fit chooses the latent dimension k and the prior scale by 3-fold cross-validation. That selection is recorded in `selection` inside the file.

Raw per-task results are not redistributed here, only the fitted parameters and their provenance.
The scripts below download them from the pinned public sources into a work directory outside the
repository. Do not commit what they write.

## Reproduction status (2026-09-26)

| What | Status | Evidence |
|---|---|---|
| Source availability | Public and pinned | `sources.json` pins all twelve source files: URL, revision or commit, size and sha256, plus the git blob id of each GitHub file. Revision `78f471b` is in `SWE-bench/SWE-bench_Verified`; `princeton-nlp/SWE-bench_Verified` does not contain it. |
| Calculation: refit the shipped prior from public data | Reproduced exactly, from this repository alone | `reproduce.sh`, run from an empty work directory: all 176 values identical to `data/router_prior.json` (k=1, scale 4), with the router code of `d2abfa6` and again with the review changes later committed as `aedddf5` (runs below). Only `provenance.fittedAt` differs. |
| Pipeline: the run-4 held-out headline | Not reproducible from this repository | The 76.3% solved at $0.093 per task result comes from harness-bench. Its 150/350 split ids, pre-registration, baseline selection and metric aggregation are not in this repository. `holdout_eval.mjs` (below) is a different experiment and does not stand in for it. |
| Independent external replication | Repository-reported only | The 2026-09-22 replication at the end of this file is reported by this repository and has not been checked by a third party. The refits below ran in the project's own development environment: they show that the calculation reproduces, not that someone else replicated it. The external review of 2026-09-26 stopped its refit at a 180 s limit; the refit takes about 7 minutes on the machine below. |

The refit runs of 2026-09-26, each from an empty work directory, on Node v22.22.2, Python 3.11.15,
pyarrow 25.0.1, Linux x64, Intel Xeon @ 2.80GHz (4 vCPU):

| Router code the fit ran | Values of the shipped prior reproduced | Values only in the refit | Fit time |
|---|---|---|---|
| HEAD `d2abfa6`, no uncommitted change to `src/router`, `src/route.js` or `data/models.json` (`git status` before and after; router code unchanged since the fit) | 176 of 176, identical | 8: `provenance.build` | 413 s |
| HEAD `d2abfa6` plus uncommitted changes to `src/router/cost.js`, `index.js`, `policy.js` and `registry.js` (review F11/F12; 290 lines added, 41 removed), byte-identical to those files as later committed in `aedddf5` | 176 of 176, identical | 35: `provenance.build`, and the new cost diagnostics `method`, `s2Source`, `counts`, `alphaSE`, `excluded` | 424 s |

## Reproduce the shipped prior

```sh
sh bench/universal-router/reproduce.sh [WORK_DIR]
```

This is the one entry point. It needs network access to huggingface.co, raw.githubusercontent.com
and PyPI, `python3` 3.10 or newer with the `venv` module, and `node` 20 or newer. It writes only
under `WORK_DIR` (default `${TMPDIR:-/tmp}/forgekit-router-repro`):

| Step | What runs | Writes |
|---|---|---|
| 1 | a virtual environment with the pinned pyarrow (`requirements.txt`) | `venv/` |
| 2 | `build_input.py`: downloads the files pinned in `sources.json`, checks each one's size and sha256 (and git blob id for the GitHub files), writes the fitting input | `cache/`, `universal_all.json` |
| 3 | `fit_prior.mjs`: refits the prior (single-threaded; minutes), timed | `router_prior.json`, `environment.txt` |
| 4 | `compare_priors.mjs`: checks that every value of `data/router_prior.json` is reproduced | `prior-comparison.json` |

`environment.txt` records the Node, Python and pyarrow versions, the CPU, the fit time, and the
code the fit ran: the git HEAD and any uncommitted change to `src/router`, `src/route.js` or
`data/models.json`.

It exits 0 when the refit reproduces every value of the shipped prior except
`provenance.fittedAt`, and 1 when any value differs or is missing. The comparison is exact:
numbers must be the same doubles. For each field (for example `mirt.L`) the report gives the
number of values that differ and the largest absolute difference. Values that only the refit has
are listed as added, not counted as a mismatch: `provenance.build` from the builder, and any field
newer code writes (such as the cost diagnostics in the status table). `compare_priors.mjs --strict`
also fails on additions. A rerun reads `cache/` instead of downloading, and
`build_input.py --offline --cache DIR` never downloads.

What goes into the input, and why:

- **Task text:** `problem_statement`, verbatim (252 statements keep their CRLF line endings). The builder reads only the `instance_id` and `problem_statement` columns. The parquet also holds the gold patch, the test patch and the evaluation fields, and none of them leave the builder. Keep that evaluator/agent boundary: `universal_all.json` carries outcome labels and costs, so it is training data for the fitter and must never be given to a coding agent as a prompt.
- **Order:** tasks by `instance_id` ascending (also the parquet's row order and the key order of every run file), models by registry id ascending. Bit-for-bit equality depends on both: feature means are summed in task order, and cross-validation folds are assigned by task index.
- **Models and runs:** `sources.json` maps each registry id to its run. The builder stops if `data/models.json` names a different `benchmark_run`.
- **Feature version:** the sha256 of `src/router/features.js` and of `src/route.js` (which holds the rubric and its exemplars), with CRLF read as LF. It is written to `source.build.featureVersion`, which a refit carries into `provenance.build`.
- **Zero-cost attempts:** Gemini 3 Flash's failed attempts on `django__django-15731` and `django__django-15814` are recorded at cost 0. They stay in the input as failures, which the ability model uses. The cost model uses only positive costs, so `cost.n` is 5,498 of 5,500.

If a refit ever disagrees, look at `features` and `cost` first. Neither depends on the MIRT
optimiser, so a difference there points at the input: task text, order or registry prices.

## Held-out replay in this repository (a new split, not run 4)

`holdout_eval.mjs` is a new experiment on the same 500 tasks, with its own split. It does not
reproduce or test the run-4 headline, whose split and metric code are not here.

```sh
node bench/universal-router/holdout_eval.mjs WORK_DIR/universal_all.json --out WORK_DIR/holdout.json
```

- **Split:** a Fisher-Yates shuffle of the ids in input order, driven by mulberry32 with seed 20260926 (`--seed`). The first 150 ids are dev and the other 350 are held out. Both id lists are in the output.
- **Fit:** `buildPrior(input, devIds)` on the 150 dev tasks only. The shipped prior, fitted on all 500 tasks, is never used.
- **Router:** `routeUniversal` with the dev fit, objective `match-best-single`, cascades of up to three models, over a registry restricted to the eleven fitted models. It sees only the task text.
- **Replay:** try the cascade's models in order until one's recorded attempt resolved the task. The cost is the sum of the recorded costs of the attempted models.
- **Baselines, chosen on dev only:** the model that solved the most dev tasks; the model with the lowest dev mean cost; and the cheapest fixed cascade of up to three models (1,111 considered) that solves at least as many dev tasks as that model, which is the router's own objective applied to dev outcomes.
- **Uncertainty:** paired bootstrap over held-out tasks, 10,000 seeded draws, 95% percentile intervals.
- **Record:** the output holds the seed, both id lists, the dev fit's selection table, every held-out decision, and the code the run loaded: the sha256 of each `src/router` file, `src/route.js` and `data/models.json`, the git HEAD and any uncommitted change. With a `target:` or `budget:` objective that no cascade can meet, the router returns its least-bad cascade as a fallback; the replay runs it and counts the task as infeasible (`match-best-single` is always feasible).

Result for seed 20260926, run on 2026-09-26 (dev fit: k=1, scale 2, 58 s). The numbers are the
same with the router code of `d2abfa6` and with the review changes to `src/router` later
committed as `aedddf5` (see the status table).

| Held-out, 350 tasks | Solved | Cost per task | Cost per solved task |
|---|---|---|---|
| Router | 80.0% | $0.124 | $0.155 |
| Best single model on dev: claude-opus-4.5 | 76.0% | $0.768 | $1.011 |
| Cheapest single model on dev: gpt-5-mini | 57.4% | $0.047 | $0.082 |
| Best fixed cascade on dev: minimax-m2.5 > gpt-5-mini > kimi-k2.5 | 80.6% | $0.136 | $0.169 |

| Router minus | Solve rate, points [95% CI] | Cost per task [95% CI] | Tasks only one of the two solved (router, baseline) |
|---|---|---|---|
| Best single model | +4.0 [+0.6, +7.4] | -$0.644 [-$0.698, -$0.594] | 26, 12 |
| Cheapest single model | +22.6 [+18.3, +27.1] | +$0.077 [+$0.060, +$0.095] | 80, 1 |
| Best fixed cascade | -0.6 [-1.4, 0.0] | -$0.012 [-$0.024, -$0.003] | 0, 2 |

What this shows:

- Against the model that looked best on dev, the router solves more held-out tasks at about a sixth of the cost. Most of that comes from one cheap model: the router opened with minimax-m2.5 on 308 of the 350 tasks, and minimax-m2.5 alone solved 76.0% of the held-out tasks at $0.077 per task.
- Against a fixed cascade chosen on the same dev tasks, the router shows no advantage. It solved no task the cascade missed, the cascade solved two that it missed, and it cost $0.012 less per task. This agrees with `docs/UNIVERSAL_ROUTING.md`: with a 150-issue fit the router does not beat a fixed cascade chosen on the same dev data.
- Five more seeds (1 to 5), run after the result above as a sensitivity check, show the same picture. Against the dev-chosen fixed cascade, the router's difference ranged from -0.6 to +1.1 points and from -$0.012 to +$0.026 per task, and in no split was it both more accurate and cheaper. Against the best single model on dev, the result depends on which model won dev. When an Opus model won (3 of 6 splits), the router saved $0.46 to $0.64 per task and solved 2.9 to 4.0 points more, with an interval excluding zero only for seed 20260926. When minimax-m2.5 won (the other 3), the router solved 0.0 to 1.1 points more at $0.003 to $0.026 more per task.
- The chosen cascades' predicted success averaged 80.2% against 80.0% observed (across the six splits, predicted minus observed ranged from -2.8 to +9.1 points). Their expected cost was $0.102 per task against $0.124 replayed, and cost was under-predicted in all six splits, by 5% to 22% of the replayed cost. In these runs a failed attempt costs on average 1.2 to 2.0 times as much as a successful one, for every model, and a cascade reaches its second model only after a failure. The cost model does not condition on the outcome.

Limits that apply to every number above:

- One scaffold (mini-SWE-agent 2.0.0), one recorded attempt per model and task, twelve Python repositories (django alone is 231 of the 500 tasks), and the costs the runs recorded in February 2026, not today's prices.
- The replay assumes a perfect, free check between cascade attempts: it stops at the first attempt whose recorded SWE-bench label is resolved. A deployed cascade needs its own verifier, which can be wrong and costs money.
- The shipped prior is fitted on all 500 tasks, so it cannot be evaluated out of sample on them. `holdout_eval.mjs` refits on the dev tasks for that reason.
- One 150/350 split is small, and the six splits above differ by several points.
- SWE-bench Verified has known validity problems. OpenAI's analysis of 2026-02-23 found test flaws in 59.4% of an audited subset of 138 hard problems (not 59.4% of all 500 tasks) and reported evidence of contamination. Read these results as a historical comparison of routing policies on one benchmark, not as evidence of current coding ability or of present-day costs.

## The original pipeline: harness-bench (run 4)

The shipped prior and the run-4 held-out test were first built with harness-bench, which is not
part of this repository and is still the only way to rerun run 4:

```bash
# `build routing` makes the 150/350 split that `build universal` reads, so it runs first:
#   python3 -m hbench.cli build routing   --swe-exp <experiments checkout>
#   python3 -m hbench.cli build universal --swe-exp <experiments checkout> --forgekit <this repo>
#   python3 -c "from hbench.tracks import universal as U; U.export_for_forgekit(Path('universal_all.json'))"
node bench/universal-router/fit_prior.mjs universal_all.json --out data/router_prior.json
```

The experiments checkout only needs the eleven runs' `per_instance_details.json` at `40f164d`.
A sparse, blob-less fetch of that commit brings down under 1 MB:

```bash
git init swe-exp && git -C swe-exp remote add origin https://github.com/SWE-bench/experiments
git -C swe-exp sparse-checkout set --no-cone evaluation/verified/20260217_mini-v2.0.0_<run>/per_instance_details.json  # ×11
git -C swe-exp fetch --depth 1 --filter=blob:none origin 40f164d5b8f1d249bf95a6df8b74b577fd8e519d
git -C swe-exp checkout FETCH_HEAD
```

`build_input.py` needs neither harness-bench nor a checkout, and the prior refitted from its input
matches the shipped one bit for bit.

## Replication reported on 2026-09-22

The run-4 benchmark and this prior were re-run from scratch on a second machine (Windows, Node 24, Python 3.12). The inputs were fetched as above, and the code was forgekit at `c5227db` (router code unchanged since the fit). This is the repository's own report; no third party has checked it.

| What | Result |
|---|---|
| Data | 11 runs × 500 issues; 616 KB of `per_instance_details.json` |
| Split | dev 150 and held-out 350: the same issue ids as the original run |
| Held-out test (`hbench test universal`) | 217 of 218 metric values identical; the only difference is wall-clock `fitSeconds` (37.6 s vs 45.9 s) |
| Headline | router 76.3% solved at $0.093 per task; best single model chosen on dev 75.1% at $0.364; pre-registered endpoint met |
| Prior refit (`fit_prior.mjs`, all 500 issues) | all 176 fitted values identical to `data/router_prior.json` (k=1, scale 4); only `provenance.fittedAt` differs |

The `fitSeconds` values belong to the held-out test, which fits on the 150 dev issues. The refit
on all 500 issues takes several times longer: 413 s on the machine in the status table, where a
150-issue fit takes 58 s.

Two portability fixes were needed on Windows:
- `fit_prior.mjs`'s default `--out` path (fixed here).
- harness-bench's `adapters/forgekit_universal.mjs`, which passes plain paths to `import()` and so needs `pathToFileURL(...).href`. That file lives in harness-bench, not in this repo.

Neither fix changes a measured value.
