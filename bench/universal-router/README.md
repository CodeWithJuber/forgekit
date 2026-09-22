# Universal router: shipped prior

`data/router_prior.json` is the fit the universal router uses until a project records its own
outcomes (`forge route outcome`, then `forge route fit`). It was fitted from public per-task
results:

- **Tasks:** the 500 issues of SWE-bench Verified (dataset revision `78f471b`); the issue text is the task.
- **Runs:** eleven models from seven providers, each run once per issue with the same agent scaffold (mini-SWE-agent 2.0.0), taken from SWE-bench/experiments @ `40f164d` (runs dated 2026-02-17). Each run gives a verified resolved/unresolved outcome and the observed cost.

To regenerate it, build the input JSON, then run:

```bash
# harness-bench writes the input from SWE-bench Verified + SWE-bench/experiments.
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

The fit chooses the latent dimension k and the prior scale by 3-fold cross-validation. That selection is recorded in `selection` inside the file.

Raw per-task results are not redistributed here, only the fitted parameters and their provenance.

## Independent replication (2026-09-22)

The run-4 benchmark and this prior were re-run from scratch on a second machine (Windows, Node 24, Python 3.12). The inputs were fetched as above, and the code was forgekit at `c5227db` (router code unchanged since the fit).

| What | Result |
|---|---|
| Data | 11 runs × 500 issues; 616 KB of `per_instance_details.json` |
| Split | dev 150 and held-out 350: the same issue ids as the original run |
| Held-out test (`hbench test universal`) | 217 of 218 metric values identical; the only difference is wall-clock `fitSeconds` (37.6 s vs 45.9 s) |
| Headline | router 76.3% solved at $0.093 per task; best single model chosen on dev 75.1% at $0.364; pre-registered endpoint met |
| Prior refit (`fit_prior.mjs`, all 500 issues) | all 176 fitted values identical to `data/router_prior.json` (k=1, scale 4); only `provenance.fittedAt` differs |

Two portability fixes were needed on Windows:
- `fit_prior.mjs`'s default `--out` path (fixed here).
- harness-bench's `adapters/forgekit_universal.mjs`, which passes plain paths to `import()` and so needs `pathToFileURL(...).href`. That file lives in harness-bench, not in this repo.

Neither fix changes a measured value.
