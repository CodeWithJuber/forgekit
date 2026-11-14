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

The context assembler keeps required definitions, tests and direct dependents ahead of optional evidence. For optional facts it selects the greatest marginal value per estimated token, subtracting 0.5 times maximum similarity with an already selected fact and discounting repeated sources. Identical normalized sketches produce one excerpt. The budget uses the existing character-based estimator. The final model input and any vendor prompt-cache behavior depend on the host.

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

Use `purpose: "parallel"` to test the plan's 20% aggregate wall-time saving or 10-point mean quality gain. An acceptance regression or a wrong package prevents an eligible result. `routing` requires lower cost, and `context` requires fewer tokens, both at equal or better quality without acceptance regressions. Independent trials on realistic team tasks determine whether the result generalizes. The CLI reports the decision without changing any host settings. A `source: "simulation"` run always returns `simulation-only`. A caller's `observed` label identifies externally collected measurements. The evaluator cannot authenticate a remote log, establish the price charged or guarantee when someone froze the tasks. Commit the frozen suite to a private repository before the pilot to establish chronology.

## Decide when to split a task

With the Engineering or Quran profile selected, the lead works alone by default. A request for an independent review creates a single read-only reviewer. For parallel research, the lead supplies a decomposition. The planner uses the caller's estimates and stated scopes. It cannot measure how long a task will take or prove there are no hidden shared dependencies.

```sh
forge team "Investigate the parser and its client" --brief streams.json --handoff codex
```

```json
{
  "mode": "parallel",
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
      "estimatedMinutes": 40,
      "paths": ["src/client"],
      "acceptance": "Return a reproducer and the file and line that handles the field"
    }
  ]
}
```

The total limit under the profile is a lead plus three workers. Each parallel stream has concrete, disjoint file or directory scopes, an estimate of at least 30 minutes and an acceptance check. A third stream requires `three-option-research` or `build-review-eval`. The repository's existing concurrency cap can lower the limit. `{"mode":"review"}` selects the independent reviewer exception. Workers return evidence to the named merge owner. Use the paired evaluator to see whether adding workers earned its cost on actual tasks.
