# Can Atlas edge weights identify affected tests?

The shipped reverse graph found **6 of 15** observed affected test files on six later ForgeKit changes. Uniform edges and weights estimated from seven earlier changes found the same six. Keep the published weights advisory. ForgeKit needs complete, current dependency evidence before it can narrow a test run. The full suite is the fallback.

## What was observed

The corpus covers 13 JavaScript changes in `CodeWithJuber/forgekit`. Each case records the full parent and child Git IDs, the date, changed paths under `src/`, and before-and-after outcomes by test file. Test candidates were a fixed roster covering the graph, ledger, routing, stack and scoring, plus test files published with the change. This enriches the sample for observable changes. It does not estimate the prevalence of failures across the repository. [Case data and implementation](https://github.com/CodeWithJuber/forgekit/issues/262)

For each pair, Atlas predicted from the parent tree before the later tests were introduced. The same child tests then ran against both product snapshots on Node 24. An affected file passed on the child and either failed an assertion on the parent or required an internal project module or export missing there. A file that passed on both revisions was a measured negative in this comparison. Timeouts, missing external dependencies and other ambiguous failures were excluded. A newly introduced test with no parent graph edge still counted as a miss. The corpus includes multiple changes to the same subsystem in a single repository and language.

## Comparison on later commits

Seven commits through September 21, 2026 supplied the calibration evidence. Six commits from September 23 through November 3 were held out. The three rankings used the production reverse walker with the same six-hop horizon and reporting threshold. Uniform traversal sets all edge priors and extraction confidences to one, leaving hop distance to break ties. Calibration uses the earlier fraction of affected test files whose strongest default path contains each edge kind, with one positive and one negative pseudocount. The inferred weights were 0.125 for calls and 0.28125 for imports. Other kinds retained their shipped weights. No labels from the six later changes were used to fit a weight.

Of 96 candidate commit/test pairs, 95 could be assessed. Four later test files failed assertions against their parent and eleven exposed a changed project API. Eighty passed against both revisions. Five of the six commits supplied positive observations.

| Ranking | Affected reached | Missed | Tests returned among 95 | Precision | Recall | Mean average precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Shipped edge priors | 6 | 9 | 15 | 40.0% | 40.0% | 0.276 |
| Unweighted reachability | 6 | 9 | 15 | 40.0% | 40.0% | 0.276 |
| Empirically calibrated edges | 6 | 9 | 14 | 42.9% | 40.0% | 0.276 |

Average precision admits tied tests together, gives unreachable positives zero credit and averages over commits with a positive observation. Resampling the six whole commits together with their test outcomes 2,000 times gave a 95% percentile interval of 0.00–0.53 for recall and 0.00–0.60 for mean average precision for each method. The small number of independent changes and concentration of failures in one revision limit inference. The offline report lists all nine missed commit/test pairs, including the path-alias, hook-manifest and session-start suites. One fewer false positive is insufficient evidence to change the production weights.

## Reproduce

Run these commands from a full ForgeKit clone with Node 24, Python 3, Git, tar and the development dependencies installed by `npm ci`. The first command reads the published observations offline. The collector creates disposable snapshots and reruns the historical tests. The selection test checks the shipping gate independently of the experiment.

```sh
python bench/observations/impact-report.py
python bench/observations/collect-impact.py
node --test --import ./test/_setup.js test/atlas.test.js test/test_select.test.js test/smart-test-select.test.js
```

