# Universal router: shipped prior

`data/router_prior.json` is the fit the universal router uses until a project records its own
outcomes (`forge route outcome`, then `forge route fit`). It was fitted from public per-task
results:

- **Tasks:** the 500 issues of SWE-bench Verified (dataset revision `78f471b`); the issue text is the task.
- **Runs:** eleven models from seven providers, each run once per issue with the same agent scaffold (mini-SWE-agent 2.0.0), taken from SWE-bench/experiments @ `40f164d` (runs dated 2026-02-17). Each run gives a verified resolved/unresolved outcome and the observed cost.

To regenerate it, build the input JSON, then run:

```bash
# harness-bench writes the input from SWE-bench Verified + SWE-bench/experiments:
#   python3 -m hbench.cli build universal --swe-exp <experiments checkout> --forgekit <this repo>
#   python3 -c "from hbench.tracks import universal as U; U.export_for_forgekit(Path('universal_all.json'))"
node bench/universal-router/fit_prior.mjs universal_all.json --out data/router_prior.json
```

The fit chooses the latent dimension k and the prior scale by 3-fold cross-validation. That selection is recorded in `selection` inside the file.

Raw per-task results are not redistributed here, only the fitted parameters and their provenance.
