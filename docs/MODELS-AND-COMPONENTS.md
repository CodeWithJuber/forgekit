# Model discovery and standalone components

## Find models for your account and workload

Look up what the installed ForgeKit package provides. Use the runtime inventory for your account's model IDs. Provider listings can include models with unknown inference entitlement. A host can control its own model independently of a ForgeKit HTTP profile.

```sh
forge models --schema 2 --refresh --json
forge models --offline --profile openai --workload repair --json
forge route universal "Review the parser" --provider openai --band high --workload repair
forge agents list --json
forge skills list --json
forge hooks list --json
```

Plain `forge models --json` returns profile rows in schema 2. Use `forge models --schema 1 --json` for the historic tier response. Private snapshots retain the last complete listing, scoped to the provider and credential. Cache filenames are keyed to this installation. Removing `model-scope.key` from private ForgeKit state starts a fresh cache on the next use. If the key cannot be read or created, a live lookup can still return models for that request. The command reports partial refreshes, denied access, absent credentials and cache age. A public catalog reports public listings. Refreshing requests metadata without starting a paid inference. OpenAI-compatible custom endpoints register with `forge config provider add NAME --base-url URL --format openai`. An exact per-call model takes precedence over a profile default set by `forge config model --exact ID --profile NAME`.

Filter by provider-declared metadata with `forge models --capability input:image --availability public-listed --max-age 1d`. Capability terms can be a provider operation such as `generateContent`, an explicit capability, or an advertised input modality, output modality or parameter such as `parameter:tools`. `--capability unknown` selects rows without this information. `--max-age` accepts whole seconds or a duration ending in `s`, `m`, `h` or `d`. Undated evidence cannot satisfy an age bound. Profiles with no matches still report their listing status.

`forge models --availability recently-callable --max-age 2h --offline` requires a successful Forge HTTP call on that exact profile, credential and model within the chosen window. A successful request for an alias remains visible as observed-only when a refreshed catalog lists a different canonical ID. An observed-only alias has no catalog check timestamp. The latest successful or denied HTTP request supplies its timestamp, elapsed latency and returned model when present. Local private metadata contains no prompt or response text. An explicit denial removes eligibility. Calls through other tools do not establish Forge HTTP access. Select `--availability unknown` to see declared models that have neither a dated listing nor an observed call for this credential. Detected native clients show their last explicitly reported session-start model and timestamp when supplied.

Provider catalog prices include currency, units and available cache read/write rates. An exact registry match can supply a labeled reference price, with its own provenance date. A provider-reported charge belongs to the individual call. Workload mean attempt cost uses only local outcome rows with an operator-reported dollar amount. Unknown charges and latency stay unknown.

A workload band compares first attempts on the same tasks with authenticated verification outcomes. Scores are relative to that cohort. The inventory leaves models unrated when it lacks three clearly separated groups. With two models, both stay `unrated` even if their measured intervals do not overlap. Their sample sizes, scores and confidence intervals are still available. A scoped band recommendation requires a current listing, a matching provider binding in the routing registry and usable cost data. The verification receipt authenticates the task verdict. Recorded model attribution is operator supplied.

In the local dashboard, open **Models** and enter a workload to inspect cached listings, dates and matched task counts. MCP clients can call `forge_models` for the same offline inventory and `route_task` with a task, profile and optional band for a scoped recommendation. Run `forge models --refresh` in the CLI when fresh listings are needed. Each automatic recommendation needs a fresh account listing and priced, verified first attempts on common workload tasks. Explicitly selected IDs carry a configured status and no inferred score.

To constrain a Forge harness run, use `forge harness run "Review the change" --route reviewed --model MODEL_ID --model-profile NAME`. The configured route must agree with the exact ID and the profile's endpoint and credential slot. The existing harness trust and spend checks still apply. A resumed run checks the original route fingerprint. Native coding clients control their own models.

Component lists enumerate the manifests in the package. Instruction skills supply a brief. A command binding identifies a packaged executable action. A hook invocation evaluates a normalized lifecycle event. Host clients differ in their ability to block, deliver context or modify output.

## Packaged capability reference

<!-- forge:render:component-model-contracts:begin (generated by `forge docs render` — do not edit) -->
Model inventory schema **2**. Standalone component catalog schema **1**.

### Built-in model profiles

| Profile      | Legacy routing aliases             |
| ------------ | ---------------------------------- |
| `anthropic`  | `haiku`, `sonnet`, `opus`, `fable` |
| `openrouter` | `haiku`, `sonnet`, `opus`, `fable` |
| `litellm`    | `haiku`, `sonnet`, `opus`, `fable` |
| `openai`     | `haiku`, `sonnet`, `opus`, `fable` |
| `gemini`     | `haiku`, `sonnet`, `opus`, `fable` |

### Packaged agents, skills and hooks

| Collection | ID                     | Mode         | Event or binding     |
| ---------- | ---------------------- | ------------ | -------------------- |
| agents     | `coder`                | role         | —                    |
| agents     | `debugger`             | role         | —                    |
| agents     | `doc-sync`             | crew         | —                    |
| agents     | `frontend-verifier`    | crew         | —                    |
| agents     | `independent-reviewer` | crew         | —                    |
| agents     | `memory-recorder`      | role         | —                    |
| agents     | `orchestrator`         | role         | —                    |
| agents     | `planner`              | role         | —                    |
| agents     | `researcher`           | role         | —                    |
| agents     | `reviewer`             | role         | —                    |
| agents     | `scout`                | crew         | —                    |
| agents     | `security-reviewer`    | role         | —                    |
| agents     | `tester`               | role         | —                    |
| agents     | `verifier`             | crew         | —                    |
| skills     | `atlas`                | instructions | —                    |
| skills     | `catchup`              | instructions | —                    |
| skills     | `code-modernization`   | instructions | —                    |
| skills     | `cognitive-substrate`  | instructions | —                    |
| skills     | `cost-guard`           | instructions | —                    |
| skills     | `design-md`            | instructions | —                    |
| skills     | `dev-radar`            | instructions | —                    |
| skills     | `explore-plan-code`    | instructions | —                    |
| skills     | `forge-impact`         | command      | `forge-impact`       |
| skills     | `forge-ledger`         | command      | `forge-ledger`       |
| skills     | `forge-verify`         | command      | `forge-verify`       |
| skills     | `handoff`              | instructions | —                    |
| skills     | `lean`                 | instructions | —                    |
| skills     | `problem-solver`       | instructions | —                    |
| skills     | `recall`               | instructions | —                    |
| skills     | `reuse-first`          | instructions | —                    |
| skills     | `self-improve`         | instructions | —                    |
| skills     | `sync-docs`            | instructions | —                    |
| skills     | `taste`                | instructions | —                    |
| skills     | `tech-selector`        | instructions | —                    |
| skills     | `ui-workflow`          | instructions | —                    |
| hooks      | `completion-gate`      | hook         | `Stop`               |
| hooks      | `cortex-capture`       | hook         | `PostToolUse`        |
| hooks      | `cortex-failure`       | hook         | `PostToolUseFailure` |
| hooks      | `cortex-pre-edit`      | hook         | `PreToolUse`         |
| hooks      | `cortex-preflight`     | hook         | `UserPromptSubmit`   |
| hooks      | `cortex-prompt`        | hook         | `UserPromptSubmit`   |
| hooks      | `cortex-session-start` | hook         | `SessionStart`       |
| hooks      | `cortex-stop`          | hook         | `Stop`               |
| hooks      | `cost-budget`          | hook         | `PreToolUse`         |
| hooks      | `dep-gate`             | hook         | `PreToolUse`         |
| hooks      | `doom-loop`            | hook         | `PreToolUse`         |
| hooks      | `format-on-edit`       | hook         | `PostToolUse`        |
| hooks      | `lean-guard`           | hook         | `Stop`               |
| hooks      | `pre-edit-impact`      | hook         | `PreToolUse`         |
| hooks      | `protect-paths`        | hook         | `PreToolUse`         |
| hooks      | `recall-load`          | hook         | `SessionStart`       |
| hooks      | `secret-redact`        | hook         | `PostToolUse`        |
| hooks      | `session-learner`      | hook         | `Stop`               |

### Host hook adapters

These rows describe the shipped adapter contract. A native-client test establishes behavior for its specific host version and install mode.

| Host           | Adds context at prompt submission | Checks tools before execution                              | Adds context after a tool failure |
| -------------- | --------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| Claude Code    | `UserPromptSubmit`                | `PreToolUse`                                               | `PostToolUseFailure`              |
| Codex          | `UserPromptSubmit`                | `PreToolUse`                                               | —                                 |
| Gemini CLI     | `BeforeAgent`                     | `BeforeTool`                                               | —                                 |
| Cursor         | —                                 | `beforeShellExecution`, `beforeMCPExecution`, `preToolUse` | `postToolUseFailure`              |
| GitHub Copilot | —                                 | `preToolUse`                                               | `postToolUseFailure`              |
| Kimi Code      | `UserPromptSubmit`                | `PreToolUse`                                               | —                                 |
| OpenCode       | `UserPromptSubmit`                | `PreToolUse`                                               | —                                 |
| Devin          | `UserPromptSubmit`                | `PreToolUse`                                               | —                                 |
<!-- forge:render:component-model-contracts:end -->


### One lifecycle hook in Claude Code

Run `forge hooks enable protect-paths --host claude` to register that packaged guard for this project on your machine. The command writes `.claude/settings.local.json` with the installed Node and ForgeKit paths. A matching full project hook or enabled user bundle takes precedence. Run `forge hooks disable protect-paths --host claude` to remove the individual registration. Customized entries require manual review. Other hosts can invoke a component directly with `forge hooks invoke`, or enable their supported full bundle with `forge hooks on`.
