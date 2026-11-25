# Reuse, technology choices and task context

## Detect new duplicate code

Enable this per repository by adding `"duplicates": true` to the `verify` object of `.forge/forge.config.json`. Existing configuration keys stay alongside it. Each developer or CI runner that uses the gate installs the selected scanner outside the checkout. ForgeKit was tested with the following version.

```sh
npm install -g jscpd@5.4.2
forge atlas build
forge hooks on
forge verify
```

An edit hook looks up newly proposed named JS functions, Python definitions, Rust functions and Go functions in the existing atlas and points to declarations in other files. A matching name is a lead for the developer. At verification, jscpd compares code against the Git baseline across its supported languages. A new token clone of at least five lines and 50 tokens fails verification. Identifier renames remain detectable. The report includes locations for up to ten new clone pairs. The detailed report that contains actual source text is transient. An existing clone in the baseline can stay. A missing scanner, missing baseline or unreadable report makes an enabled check incomplete.

`forge verify` compares pending changes to HEAD. After committing the branch, use `forge verify --base origin/master`, substituting the target branch available locally. Use `FORGE_JSCPD_BIN` to point at a trusted absolute executable or the npm package's `run-jscpd.js`. The scanner receives a fixed configuration without semantic/network models. The gate detects token clones, including some renamed copies. Finding two functions that implement the same algorithm with different code still needs review. [jscpd baseline documentation](https://github.com/kucherenko/jscpd)

## Compare libraries, SDKs or frameworks

Start with the repository's own helper and the standard library. When adopting an external dependency is a real option, save a local JSON worksheet, then run:

```sh
forge decide compare ./candidates.json
forge decide compare ./candidates.json --record
```

Supply the following keys in the worksheet:

| Field | Value |
| --- | --- |
| `question` | One complete decision, such as choosing a streaming CSV parser for a Node 20 project. |
| `weights` | An optional map of criterion names to nonnegative weights. Unspecified weights default to one. |
| `candidates` | An array of two to twenty named alternatives, each with `gates` and `scores`. |
| `gates` | Use keys `licenseCompatible`, `maintained`, `noCriticalVulnerability`, `stackCompatible`, `withinBudget`. Each value is an object with `value` and a short, traceable `evidence` reference. Four gates take a boolean. For `maintained`, supply the most recent verified maintenance date (YYYY-MM-DD). |
| `scores` | Use `fit`, `maturity`, `maintenance`, `performance`, `documentation`, `exitCost` and `community`. Each value is an object with a numeric `value` (0–5) and an `evidence` reference. Five means best for this project, including least maintenance and easiest exit. |

For example, an actual stack probe might establish `"stackCompatible": {"value": true, "evidence": "probes/node20.log:7"}`. Record license findings, maintenance/activity dates, advisory results, price and budget from your own investigation. The tool processes the supplied evidence without looking up its contents or interpreting licenses.

A failed gate excludes the option. The maintenance gate covers one calendar year. Missing evidence, a future maintenance date, a tie or a comparison with no qualifying option leaves the decision open. Qualified options receive the weighted mean on a 0–5 scale. `--record` appends the chosen result, comparison digest and gate citations to the existing decisions log when there is a unique supported choice.

## Retrieve context for a particular task

```sh
forge atlas build
forge rank --task "Trace validatePayment in src/payments.js" --top 8 --json
```

The equivalent MCP tool is `rank_code` with `task` and `top`. A symbol name or file in the task seeds the restart distribution of PageRank with damping 0.85. The ranked report includes the number of matching nodes. An unmatched task falls back to the project's global ranking and labels that result. File scores incorporate incident evidence when it exists.

The context assembler gives required source spans and dependencies the first share of the budget. It considers optional ledger facts with query evidence. A fact's marginal value uses its retrieval rank, query overlap and novelty relative to previously included facts, divided by its encoded size. The rendered block includes its separators in the count. Missing and partial inputs travel with the context packet. [Automation contracts](CORE-CONTRACT.md)

## Evaluate a rollout on local team tasks

Collect at least 20 representative tasks before selecting the module. The CLI creates blank worksheets with private file permissions. Place them outside public repositories. Each case names its repository and revision, outcome and executable acceptance or grading rubric. The suite names the two configurations and their shared controls. Freeze the definitions before recording results.

```sh
forge team evaluate init suite.json
# Fill in the tasks and controls.
forge team evaluate freeze suite.json frozen.json
forge team evaluate template frozen.json runs.json
# Fill in observed results for BOTH arms on each task.
forge team evaluate compare frozen.json runs.json
```

Each arm requires wall seconds, USD cost, token count, tool calls, new duplicate count, wrong-package count, a 0–100 quality grade under the same rubric, acceptance, and a distinct run/log locator. Record actual zero only when zero was measured. The evaluator checks the frozen suite digest, pairs by task ID and refuses missing arms or mismatched snapshots. The report gives total cost and time, average quality, how many individual tasks improved and which cases regressed.

For `purpose: "parallel"` in a version 2 suite, declare `targets.speedGainPct` and `targets.qualityGainPoints` before freezing the suite. An acceptance regression or a wrong package prevents eligibility. The evaluator reports the paired wins, losses, ties and one-sided sign-test probability for both metrics. Version 1 keeps its original 20% and 10-point thresholds. A simulation receives its own verdict. The operator supplies distinct, observed evidence for each arm and retains the frozen suite and receipts. How suitable the comparisons are depends on sampling and the controls.

## Decide when to split a task

The lead works alone until the caller supplies a breakdown or selects `--review` for one independent reviewer. This applies to the Engineering and Quran profiles and to the default setup. The same brief works in the CLI and the `forge_team_plan` MCP tool. A handoff is a local preview.

```sh
forge team "Investigate the parser and its client" --brief streams.json --handoff codex
```

```json
{
  "mode": "workflow",
  "owner": "lead",
  "merge": "One table mapping the contract to the failing client case",
  "streams": [
    {
      "id": "contract",
      "role": "requirements",
      "estimatedMinutes": 35,
      "paths": ["docs/contracts"],
      "acceptance": "Cite the versioned field definition and its expected behavior"
    },
    {
      "id": "client",
      "role": "debug",
      "dependsOn": ["contract"],
      "estimatedMinutes": 10,
      "paths": ["src/client"],
      "acceptance": "Return a reproducer and the file and line that handles the field"
    }
  ]
}
```

The client worker in this example waits for the contract report. Remove the dependency if the two investigations can proceed independently. Each stream names a deliverable and concrete file or directory paths. Concurrent scopes must be disjoint. A dependency permits the two workers to inspect the same scope in sequence. The planner rejects cycles, missing dependencies and duplicate IDs before launching workers.

`estimatedMinutes` is optional. The scheduler uses the most recent successful duration from an equivalent local work contract when available. If every worker has a duration or an estimate, it computes the longest remaining dependency path using `priority(i) = duration(i) + max(priority(successors(i)))`, with zero for an empty successor set. If any duration is unknown, it uses dependency depth and leaves `criticalPathMs` empty. Among ready jobs it starts the highest priority first and breaks ties in brief order. This ordering estimates wall time. Shared hardware and provider latency can change actual results.

The workspace concurrency setting and the optional `--max-workers` limit apply to active launches. Remaining work stays queued. A failed worker blocks its dependents. Independent workers can finish and return evidence to the merge owner. Each measured duration includes the time spent preparing that worker’s handoff, exposed separately as `coordinationMs`. Queue wait and human integration time are outside this measurement. The native planner stores the contract hash, these timings, any host-reported cost and a timestamp in private local state. Portable hosts leave cost unknown. Use the paired evaluator to measure the effect on accepted findings, elapsed time and spend for a representative set of tasks.
