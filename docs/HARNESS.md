# Supervised coding runs

ForgeKit can run a task through a model, a gated tool registry and a verifier. The CLI, the ForgeKit MCP server and the job worker use the same executor. A run ID identifies its task, decisions, tool calls, usage and final evidence. A model saying it has finished starts verification.

## Start with your coding hosts

Use a checkout of the project you want to work on. Install this version of the ForgeKit CLI on your PATH. Use Node 20+ and a Python installation outside the project with SQLite support. The Codex configuration check uses Python 3.11+ for TOML. Generated control files use JSON syntax, which is valid YAML. Install PyYAML for the selected interpreter if you want to use indented YAML syntax.

```sh
forge harness init --hosts kimi,codex --supervised
forge harness status
forge harness drift --hosts kimi,codex
forge harness routes
```

Fresh initialization creates five files under `harness/` and records a private activation for this checkout. Review version-controlled configuration from another checkout, then run `forge harness trust` locally. Review and repeat trust after changing the four control files. The lockfile uses separate per-extension approval. On an existing initialized project, change `policy.yaml` to select `nativeMode` and `hosts`, trust the change, then set up the chosen hosts using `forge init --tools kimi,codex` and `forge hooks on --hosts kimi,codex`. A second harness initialization preserves existing controls.

| File | What the team chooses |
| --- | --- |
| `policy.yaml` | Profiles, stages, tool permissions, native host mode, optional memory scopes and trusted extension hooks. |
| `routing.yaml` | OpenAI-compatible Chat Completions endpoints, model IDs, step types, strength, request limits and prices. |
| `budgets.yaml` | Per-priority turns, tokens, elapsed milliseconds, tool calls, cost, repairs and context window, plus daily and total project spend ceilings. |
| `jobs.yaml` | Cron jobs, missed-run behavior and named condition or authenticated webhook triggers. |
| `lockfile.json` | Names, exact versions, workspace directories and reviewed digests of extension packages. |

Use `--supervised` for a project whose native pre-tool hooks should send work through ForgeKit. The ordinary `parallel` mode leaves the existing coding client in charge while the CLI and MCP harness remain available. A native hook can mediate the events the host actually sends. An editor operation, shell, provider call or another MCP client outside that channel still has its own permissions and billing.

| Host | Activation and boundary |
| --- | --- |
| Kimi Code | Trust the workspace. Run the printed `/plugins install /absolute/path/to/forgekit` command, then `/reload`. The native plugin is per user. The project MCP file is `.kimi-code/mcp.json`. |
| Local Codex | Open a trusted project and inspect the generated commands in `/hooks`. The MCP config and native hooks are under `.codex/`. |
| Claude Code, Gemini CLI, Cursor, Copilot | Select the host at setup. ForgeKit translates the supported pre-tool events into the client’s deny or allow response. Trust, reload, cloud availability and tool naming are client-specific. |
| Other MCP hosts | Register `forge` with arguments `["cortex-mcp"]` as a stdio server in the target project. Use `forge_harness_run` and `forge_harness_status`. A shell-only or instruction-only agent can invoke the CLI. |

In supervised projects the ForgeKit MCP server accepts those two harness tools. An MCP run accepts `task` and an optional array of `acceptance` strings. Approval administration, extension review, route trust and memory sharing are operator commands. The client hook fixtures and the read-only drift check exercise six host dialects. A green drift report establishes the managed entries on disk. The [host matrix](INTEGRATIONS.md) records separate native-client delivery results.

## Select and verify a model route

The default route is the local Chat Completions endpoint at `http://127.0.0.1:11434/v1`, model `qwen2.5-coder:7b`. Start a compatible server and install that model yourself, or configure a route for your own model. Initialization makes no download or paid call. Endpoints must support the tool-call message format. Runtime credentials come from the environment variable named by the route.

After editing routing, run `forge harness trust` and inspect `forge harness routes`. A custom route requires its exact reviewed fingerprint, including a custom loopback route. Set `FORGE_HARNESS_TRUSTED_ROUTES` to the printed fingerprint, or a comma-separated list. A paid deployment also needs positive per-run, daily and total project ceilings, with explicit input and output prices. Reservations account for parallel processes and linked worktrees. An ambiguous provider response can consume its entire reservation. Usage and estimates depend on the configured route prices.

For a repeatable fixture without a paid provider, run the following in the ForgeKit source checkout. The router test starts an ephemeral HTTP server on loopback, captures the outbound Chat Completions request and returns a structured tool call. The loop tests use synthetic models and controlled verifiers. The default route need not be running for either test.

```sh
node --test --import ./test/_setup.js test/harness_router.test.js test/harness_loop.test.js
```

## A first verifiable run

This example uses a new disposable Git repository with the local model route running. The task has one observable requirement. Because this example repository declares no test suite, the operator can bind its verifier to a specific file assertion.

```sh
git init -q
forge harness init
printf '%s\n' '{"status":"ready"}' > issue.json
cat > check-ready.json <<'JSON'
{
  "mode": "assertions",
  "runId": "ready-example",
  "task": "Read issue.json and report its status.",
  "acceptance": ["status equals ready"],
  "assertions": [
    {"criterion": 0, "path": "issue.json", "jsonPath": ["status"], "equals": "ready"}
  ]
}
JSON
forge harness run "Read issue.json and report its status." \
  --id ready-example --accept "status equals ready" --verifier check-ready.json
forge harness show ready-example
forge harness replay ready-example
forge harness audit ready-example
```

Read `status`, `reason`, `evidence` and `usage` together. A completed file assertion proves the listed property. For a normal project with tests, choose an appropriate verifier.

| Verifier | Evidence and usage |
| --- | --- |
| Default `receipt` | Run `forge verify` on a checkout whose tests you trust. The harness accepts an authenticated passing suite receipt for the current checkout and code state. A subsequent edit invalidates that proof. The receipt identifies the suites and their exit results. |
| `assertions` | The operator supplies the task, run ID, ordered acceptance list and exactly one assertion per criterion. Supported checks compare exact UTF-8 bytes, SHA-256 or a JSON path and value. Declared project suites require the receipt or isolated executable verifier. |
| `container` | Supply a pinned OCI image and explicit command, for example `{"mode":"container","runtime":"docker","image":"registry.example.org/team/review@sha256:<64-hex-digest>","command":["/bin/sh","check.sh"],"timeoutMs":30000}`. Substitute an actual preloaded image digest and a check present in the checkout. The verifier runs a temporary copy under a non-root identity with resource limits and network disabled. The image must already contain the dependencies its check needs. A missing runtime, changed input, timeout or failing exit is a failed verification. |

Use `--verifier path/to/spec.json` for a single CLI run. For repeated edits through MCP or a background worker, `forge harness verifier set container.json` binds a reviewed container verifier privately to this worktree. Inspect it with `forge harness verifier show` and remove it with `forge harness verifier clear`. The [verifier tests](../test/harness_verify.test.js) include a real Docker check gated by `HARNESS_REAL_CONTAINER=1` and a preloaded pinned image.

## Gates, approvals and recovery

The default tool registry provides `list_files`, `read_file` and `write_file`. Writes use a matching previous SHA-256, or an explicit expected absence for a new file. The tools enforce scope, protected locations, symlinks, size and schema checks. An extension can add a reviewed read-only reference tool. The package does not expose a general-purpose terminal or deploy action to the model.

The gate evaluates the requested profile, stage (1–7), action risk and configured level. Levels are denied, restricted, approval, allowed and sandbox. An executor requesting the sandbox level must supply the corresponding containment. Trust and stage movement use evidence scoped to the installed route and actor profile. An approval binds the run, action, canonical arguments and policy, and expires. To handle a pending run:

```sh
forge harness approvals list
forge harness approvals get APPROVAL_ID
forge harness approvals grant APPROVAL_ID
forge harness resume RUN_ID
```

Use `deny` in place of `grant` to reject. For an interrupted process, `forge harness recover RUN_ID` inspects the writer and saved checkpoint. A checkpoint between operations can be resumed. A crash with a provider or effectful operation in flight reports an unknown outcome for reconciliation. Replaying the trace performs no tool calls. Use `forge harness stats` for run and project spend summaries and `forge harness prune` to remove eligible aged payloads while retaining audit digests.

## Memory and context

The model receives the task and acceptance criteria, applicable rules, ranked workspace slices and retrieved records inside a bounded context. Compaction pins the task, criteria and last verified result. SQLite stores episodes, semantic claims, procedures, links and an append-only history. The certainty levels L1, L2 and L3 distinguish inference, observation and qualifying proof. Secret-shaped content is refused. A proposed claim cannot become proven merely by citing unrelated passing tests.

```sh
forge harness memory stats
forge harness memory recall "retry policy"
forge harness memory review
forge harness memory history CLAIM_ID
forge harness memory graph CLAIM_ID 2
```

An operator can correct or contradict an item and inspect its history. For explicit sharing use `forge harness memory share CLAIM_ID team --team platform` or `forge harness memory share CLAIM_ID personal --personal`. These are scopes of the local memory database. Team replication, corporate identities and multi-user ACLs need a separate deployment. Existing Jira, Confluence, GitLab and document mirrors have their own identity scopes and refresh behavior. [Source configuration](AGENT-EVIDENCE.md)

## Skills and extensions

For an extension under `extensions/retry/`, place this `plugin.json` beside `references/guide.md`. Its tool reads only the reviewed bytes of that reference.

```json
{
  "name": "retry",
  "version": "1.0.0",
  "source": "Platform team",
  "license": "MIT",
  "description": "Retry contract reference",
  "tools": [{"name":"guide","reference":"references/guide.md","description":"Read the retry contract"}]
}
```

```sh
forge harness extensions inspect extensions/retry
forge harness extensions pin extensions/retry --digest REVIEWED_SHA256
forge harness extensions list
forge harness extensions remove retry
```

Review the digest and inspection report before pinning. Changing any included file changes the digest. A skill uses `skill.json`, `SKILL.md` and a `triggers` list such as `["retry","backoff"]`. Instructions enter context when the task matches. Bundles can declare event subscriptions and bounded hooks such as `{"point":"agent.tool.before","action":"veto_contains","value":"restricted-staging"}`. A critical hook requires `policy.trustedHooks` to list that point under the extension name. The bus times handlers, records errors, removes registrations and quarantines a release on its third handler failure. The inventory reports review and inactivity dates. Human review, a private approval and a project lock pin authorize this release. Existing [integration selection](V2-IMPLEMENTATION.md) handles separate npm, MCP and local-executable integrations. Executable plugin lifecycle code and remote reputation feeds are outside this declarative loader.

## Jobs and multi-agent decisions

One worker dispatches one eligible item via `jobs work`. A system timer or CI scheduler must actually call `jobs tick` and `jobs work` with the correct project, account and model access. Example manual enqueue:

```json
{
  "key":"retry-review-01",
  "priority":"P2",
  "request":{"task":"Inspect retry behavior","profile":"reviewer","acceptance":["Record the passing retry suite"]}
}
```

Save that file as `job.json`, then use `forge harness jobs enqueue job.json`, `forge harness jobs work` and `forge harness jobs list`. For a scheduled review set `jobs.yaml` to `{"jobs":[{"name":"nightly-review","cron":"0 3 * * *","missed_runs":"run_once","task":"Inspect retry behavior","owner":"platform","profile":"reviewer"}],"triggers":[]}`, review and trust it, then schedule the tick and worker commands. Cron is evaluated in UTC. Conditional and signed webhook intake enqueue named work with delivery deduplication. An approval-required background call parks the job. Grant the exact approval, release the job with `forge harness jobs release JOB_ID`, then run the worker. Leases and effect checkpoints bound retries.

Use one agent until a task class warrants more. A worker contract specifies scope, evidence, result format, escalation path and budget. Workers receive an evidence brief, have zero application tools and return their report to the integrator. Shapes include author–reviewer, parallel, map–reduce and council. Council rounds record proposals, challenges, rebuttals and evidence-backed dissent. Weighted synthesis can leave a decision unresolved.

```sh
forge harness council status parallel retry
forge harness council plan workers.json
forge harness council trial parallel frozen.json observed.json retry
forge harness council run workers.json
```

Create the frozen suite and observation worksheet with `forge team evaluate`, as described in the [paired pilot](V2-IMPLEMENTATION.md). Only measured, paired observations can enable a shape for routine use in that class. `trial:true` explicitly allows an experimental run before adoption. See the [council fixtures](../test/harness_council.test.js) for complete worker contracts, trial data and the dissent record. Local fixtures exercise all branches. They do not establish a team’s productivity improvement.

## Coverage of the 38-page plan

| Pages | Executable implementation and scope |
| --- | --- |
| 1–8 | Common run shape, gateway, executor, permission gate, router, verifier, memory, events, audit and queue. CLI and MCP are process entry points. Deployments can connect signed webhook traffic through their own authenticated listener. |
| 9–12 | Model–tool loop, context and compaction, per-step routing and bounded fallback. Missing usage and ambiguous execution are charged conservatively. The router currently accepts Chat Completions-compatible providers. |
| 13–18 | Five permission levels, seven stages, scoped proof, memory layers, ledger history and graph recall. Ranking combines lexical results, graph neighbors and recency with reciprocal ranks, certainty and layer-specific time decay. Deduplication uses normalized content and MinHash. Source deltas compare a revision and update a hash tree. |
| 19–24 | All 13 separately named interception points from the catalogue, bounded event history, private scoped tool execution, declarative skills/plugins, digest review, removal and quarantine. Trust for critical hooks is explicit. |
| 25–28 | Single-agent default, bounded workers, council synthesis, per-shape trial records, leased SQLite job queue, UTC cron, triggers and signed webhook intake. |
| 29–33 | Budget thresholds, checkpoints, repairs, cancellation, receipts, hashed phase trace, recovery and retention. Cost is attributed to runs, with UTC-day and project reservation ceilings. Choice of pricing, cache break-even and rollout thresholds requires workload measurements. |
| 34–37 | The reference pseudocode is implemented in the existing Node CLI with Python/SQLite helpers. Five versioned control files, private trust and a shared generated-host drift check tie the components together. |
| 38 | The acceptance coverage below identifies observed assertions and remaining deployment measurements. |

## Acceptance evidence

Run `node --test --import ./test/_setup.js test/harness*.test.js` from a ForgeKit source checkout. The [portable harness workflow](../.github/workflows/harness-acceptance.yml) runs the suite in CI.

| Acceptance condition | What the fixture actually checks |
| --- | --- |
| Denied means denied | A stage-two profile attempts shell, deploy and an outside path. Calls produce denials and no tool effect. [Loop](../test/harness_loop.test.js) |
| Approval means approval | No response before expiry abandons an exact action. A grant for different arguments or policy cannot authorize it. [Policy](../test/harness_policy.test.js) |
| Budget means stop | Repeated calls and exhausted tokens stop with named reasons. Cumulative spend caps also apply across parallel processes. [Loop](../test/harness_loop.test.js) · [Router](../test/harness_router.test.js) |
| Done means verified | A failing verifier consumes its allowed repair attempts. A stale or foreign signed receipt fails verification. [Loop](../test/harness_loop.test.js) · [Verifier](../test/harness_verify.test.js) |
| Memory means proven | Tests exercise evidence level, secret rejection, recorded contradiction, demotion and scope isolation. [Memory](../test/harness_memory.test.js) |
| Compaction preserves pins | A forced reduction retains exact task text, acceptance criteria and last verified result, or reports that the pins cannot fit. [Memory](../test/harness_memory.test.js) |
| Injection remains data | An embedded instruction appears as tool evidence, with an injection signal in the trace. The gate still checks final tool arguments. Pattern detection does not guarantee recognition of every attack. [Loop](../test/harness_loop.test.js) |
| Plugin can be removed | Load, exercise and unload a real declarative fixture. Existing tool handles become unusable, subscriptions disappear and repeated faults quarantine across runs. [Extensions](../test/harness_extensions.test.js) |
| Schedule uses the same rules | A background job parks on approval and resumes through the ordinary loop. An idempotent replay cannot repeat the action. [Jobs](../test/harness_jobs.test.js) |
| Multi-agent adoption is measured | Observed trial records select keep or revert. A missing trial defaults to one worker and simulated measurements cannot unlock a shape. A live team rollout requires its own observed data. [Council](../test/harness_council.test.js) |
| Audit covers the registry | A smoke run executes each built-in registered tool and matches tool evidence to its trace. The runtime also records denied and failed attempts. [Loop](../test/harness_loop.test.js) |
| Drift is caught | Six selected hosts are generated. Kimi MCP, Codex TOML and Cursor hook tampering are detected. Unrelated user configuration survives the read-only comparison. [Drift](../test/harness_drift.test.js) |
