# ForgeKit full documentation

This guide combines five reviews of v1.19.2 at `c12b63ef`, runtime verification, and dated market studies from 23 and 25 November 2026. The version number identifies the reviewed baseline. The implementation record below distinguishes changes in the working tree from historical measurements and validation that still requires native clients, real tasks or accounts.

## Working implementation, 25 November 2026

The following commands target the unreleased working tree derived from v1.19.2. Install a tarball built from this tree or run `node src/cli.js` in the checkout. The published v1.19.2 package predates these changes.

| Work package | Working behavior | Boundary to verify in your environment |
|---|---|---|
| R1. Verification | Versioned receipts bind the checkout and the observed suite results. Consumers reject historical receipts without execution counts. Failing assertions, unexplained success, empty discovery and entirely skipped runs produce distinct outcomes. A custom isolated check supplies a counted test summary or a versioned JSON result. | A trusted producer and an independent acceptance criterion remain essential. A passing command authenticates what it ran. |
| R2. Hook enforcement | The normalized adapter checks every affected path or reports that it cannot safely evaluate the action. Unsupported input, guard timeouts and malformed protected actions reach a deny-capable host. Replay binds the decision to the normalized action. Supported output edits are returned to the client. Named pre-edit checks bind a reviewed operation to the checkout. Explicit setup for a host without a blocking callback selects strict local Git verification. | A host without an output-replacement facility may already expose its original output. Check the generated capability reference and observed native execution. |
| R3. Memory | Ordinary MCP writes private candidates. The operator approves, rejects and resolves conflicts explicitly. Shared projections respect retractions, including after peer sync. Prompt capture requires opt-in. A user-scoped, bounded candidate index supports prompt-time search. | An authorized ordinary CLI can still publish project memory. Old commits containing prompts require separate historical remediation. A bounded search may omit a relevant item. |
| R4. Settings and dispatch | Concurrent config updates serialize read, merge and replace. Partial budget updates preserve hard mode and warning levels. An exact profile/endpoint/model binding is retained through request construction. The harness accounts separately for deferred eligibility and attempted execution. | A crashed settings writer can leave a lock with its PID. Inspect the owner before removing it. Ambiguous provider work requires reconciliation. |
| R5. Models | The CLI, ordinary MCP and local dashboard expose account-scoped inventories, status, freshness and workload ratings. Provider metadata can be refreshed independently. The supervised harness supports content-bound route pins. | Each account may have different catalog, billing and execution permissions. A cold model stays unrated. Claude Code advisor pairings come from a dated host compatibility table. Unlisted versions have no assigned rank. Native hosts control their own model unless their adapter establishes otherwise. |
| R6. Components | Agents, skills and hooks can be listed, inspected and used individually. Portable handoffs work without an inference service. Bound skills accept typed inputs. Client-specific installation preserves user changes. Script candidates use content digests, frozen fixtures and an isolated runtime. | A host installation requires the client's own trust and activation. A live recipe replay needs its digest-pinned container image on the machine. |
| R7. Analysis and continuity | TypeScript compiler symbols resolve local calls, types and re-exports. Context budgets use exact UTF-8 bytes or an explicitly selected tokenizer. Test selection follows the reverse closure of checkout-bound, producer-declared dependencies. | Missing dependency coverage selects the full suite. Each compiler and coverage producer has a limited language and runtime scope. |
| R8. Advice and learning | Callers can identify continuations, acknowledgements and questions explicitly. An unclassified prompt alone triggers no missing-information warning. Public lookups require a personal choice. Automatic advice uses an abbreviated public reference with its source details. Generic projects and monorepos receive instructions conditioned on the detected stack. | Repeated verified tasks can reuse an operator-provided label. Intervention rates across real languages and teams still need measurement. |
| R9. Delivery | External Actions use immutable revisions. The release gate installs the packed CLI in a fresh consumer. The source installer preserves the checked-in launcher mode. The remote session-start hook uses the lockfile. The strictly typed subset runs alongside the legacy typecheck. | This change was exercised locally on Linux. Hosted CI, remote archive retention, repository settings and clean Windows/macOS consumers need their own run receipts. |
| R10. Documentation and interoperability | CLI usage, generated component/model/host references and deployed documentation share versioned registries. A packaged developer template shows supported CLI, MCP and HTTP contracts. Repeated docs generation is checkable in CI. | Inspect the requested protocol and actual native client version. The stdio and HTTP transports support different revisions. |
| R11. Evaluation | The 20-task rollout machinery and the 100-pair cost pilot can freeze a workload, record both arms, report missing billing and evaluate quality and cost. Promotion uses measured evidence and can retain the baseline. | No consented real-user pilot was supplied. Savings, adoption and general productivity gains remain unmeasured. |

### First session

```sh
forge agents list --json
forge agents run planner --task "Plan a two-week trial and define success"
forge skills show forge-impact --json
forge hooks show protect-paths --json
forge integrations template --json
forge models --refresh --schema 2 --json
forge models --offline --profile openai --workload repair --json
forge models --offline --availability recently-callable --max-age 2h --json
forge atlas build --ast --json
forge context "Review src/ledger.js" --budget 1200 --packet --json
forge test-select --changed src/ledger.js --json
forge vet --lockfile --json
forge handoff "Reviewed the order schema" --next "Verify the import" --evidence README.md
forge handoff --resume --json
forge brain proposals
forge verify --json
forge demo workshop
```

Use an existing tracked file with `--evidence`. Local packages and available credentials affect the inventory. `forge models --json` shows the cross-profile inventory. Select `--schema 1` for the historical compatibility response. Each new standalone component can produce a handoff or invoke its documented binding. A user must choose an execution backend for an inference call.

### Use the supplied Quran profile for a review

Run `forge prompts show master --profile quran` to read the author's fourteen principles and seven-step workflow. Run `forge prompts show reviewer --profile quran` for the reviewer brief. These commands apply the profile to the requested brief. A permanent workspace preference is optional.

In this review, *Tabayyun* (49:6) meant checking the verdict when one runner reported passes and another reported zero tests. *Tadabbur* (4:82) meant reconciling that result with the promise that every required suite supplies evidence. *Amana* (33:72) meant tracing which workspace data was eligible for upload, including an application's SQLite database stored under a custom extension. For each decision, record the code path, the checks that changed the verdict, and what still requires a real deployment. These are the source guide's engineering applications. [Development prompts](DEVELOPMENT-PROMPTS.md)

### Evidence, constraints and tradeoffs

A client requesting context packets can import `applyContextPacket` from `@codewithjuber/forgekit/context-packet`. Keep the returned snapshot and acknowledge its revision on the next request, for example with `forge context "Review src/ledger.js" --budget 1200 --packet --ack "$revision" --json`. Apply the response to the retained snapshot before giving the reconstructed text to a model. A lost client snapshot requires a fresh full packet. ForgeKit stores manifest hashes outside the checkout. The packet exposes missing, partial and withheld inputs. A smaller transfer can still produce the same model input and bill.

For impacted testing, let $G=(V,E)$ contain static dependency edges from consumers to producers. Starting from changed nodes $C$, the reverse transitive closure identifies candidate consumers. Collapse cycles before scheduling. The selector uses the exact reverse closure from a dependency observation bound to the checkout and test environment. Incomplete evidence keeps the full suite. A missing edge means a test can still be missed. Independently run the full suite on the same checkout to measure that miss rate before allowing a selected run to replace a required gate.

For model comparison, intersect the sets of frozen tasks evaluated by candidate routes, retain the first attributed attempt per task and join the verified outcomes. Compare model quality within that shared workload. A missing price, unproven capability or wide uncertainty has a distinct representation. At the deployment boundary, a safe route also needs a current permission binding and spend ceiling. Treating a tier name as a callable model ID loses those guarantees.

For context, retain the required source spans first, then use the remaining budget for optional evidence. Each optional item competes on its incremental source coverage per token. A missing required span travels with the result. Recheck source hashes before using a packet in a later turn. For memory, a new observation can nominate a correction. An explicit authority decision changes the shared fact. In the current implementation a cross-host handoff carries a revision and content digests for its evidence.

For a paired budget study, divide the actual billed spend of *all* attempts by independently verified completions in each arm. Report abandonment, missing bills, provider retries, latency, human review and quality along with this ratio. Split cold, repeat-heavy and mixed tasks. Predeclare noninferiority margins before observing outcomes. A lower input-token count alone cannot establish lower spend.

### Which decisions use data

| Decision | Inputs and algorithm | When inputs are missing |
|---|---|---|
| Should Forge ask about missing information? | The caller declares required files. Coverage is the number present divided by the number required. A mentioned identifier can also be resolved against the graph. | No declared prerequisites gives unknown coverage. Prompt length and English adjectives carry no score. |
| Which model can do this task? | Join the provider inventory to attributable outcomes on shared workloads. Compare verified success and cost over comparable attempts. | The deployment stays unrated. List it for inspection or select it explicitly. |
| Which tests should run? | Traverse reverse dependency edges from every changed input. Bind the observation to the source bytes, revision, runner and declared environment. | Run the full suite. A filename or a neighboring test does not establish coverage. |
| Which memory and context should travel? | Rank candidate records by observed evidence. Retain required source material first, then use marginal nonredundant value per counting unit. Report truncated definitions and missing references. | Return the available evidence and identify what could not fit. |
| Which worker starts next? | Respect the dependency graph and concurrency limit. Completed prerequisite evidence releases each dependent. Observed durations inform critical-path priority. | Independent tasks retain deterministic ordering. A single undecomposed task goes to the lead. |

Permissions, tenant grants, spend limits, schema versions and cryptographic parameters are explicit contracts. The Quran review profile asks the lead to substantiate a claim, obtain an independent check and state what remains unknown. For a team study, freeze the improvement targets before collecting results. `forge team evaluate compare` reports individual wins, losses and ties and the one-sided paired sign-test probability. Interpretation assumes independent, exchangeable pairs under the null.

Some numerical assumptions are still visible in the source. The PCM ledger has versioned oracle reliability and time-decay assumptions. Its empirical search ranks measured observations, but claim validity still depends on that confidence model. Atlas uses fixed edge weights for its advisory impact estimates and PageRank. Those estimates also depend on which files and relationships its parser found. The research-only merge-impact matrices and the historical Python router keep their original profiles so past experiments can be reproduced. None of those experiments establishes model quality or authorizes running fewer tests. [Ledger implementation](../src/ledger.js) · [Merge-impact study](MERGE_IMPACT.md)

### Priorities after local acceptance

1. Exercise current versions of each advertised native client, then record observed registration, callback, denial, redaction or immutable-output behavior and model delivery independently.
2. Enroll a willing test team in a self-hosted dashboard. Verify tenant configuration, TLS termination, storage and backup retention, deletion propagation and endpoint capacity using that team's operating limits.
3. Collect blinded paired outcomes and provider bills on the frozen 20- and 100-task protocols. Compare against the team's ordinary workflow and an equivalent fixed-model baseline. Keep negative and inconclusive results.
4. Expand semantic coverage to compiler-resolved calls, runtime dependencies, generated sources and cross-language links with a labeled corpus. Evaluate eligibility to reduce required test scope separately for each ecosystem. Measure misses in each ecosystem on independent full runs. Evaluate tokenizer support and scheduling quality on the deployments the team uses.

### What happened to the earlier roadmap

| Earlier proposal or concern | Current disposition |
|---|---|
| P4 context assembly and P5 graph enforcement | Counted context packets identify missing spans. The TypeScript compiler adds resolved local relationships. After explicit enrollment, supported pre-edit events bind each named edit to its impact review. Explicit setup for a host without a blocking callback, for example `forge init --tools aider`, installs a checkout-local verified-index hook unless advisory mode is selected. A user-owned hook or an external Git hook directory requires the documented manual or CI integration. Universal semantic sufficiency and support in every client remain unmeasured. |
| P8 cost evaluation and model drift | The paired evaluation worksheet and a calibrated, fixed-horizon regression monitor run locally. A real cohort, dated provider bills and independent acceptance results are still needed. |
| Memory corrections, collisions and legacy files | The ledger serves live reads and writes. Migrate a legacy store with a hashed recovery snapshot. Workspace-specific device grants control organization recall and publication. Contradictions and retractions remain explicit. |
| Self-hosted cloud and the earlier relay idea | The private dashboard can inspect a full enrolled workspace. The encrypted relay lets a separate authorized client verify and decrypt workspace data. The server can observe sizes, timing and changed object IDs. A deployment owner still controls keys, TLS, retention and backups. |
| Reusable adapters and release stability | The packaged template exercises CLI, MCP and HTTP. The stable automation contracts specify CLI envelopes, context packet reconstruction and authenticated run-history triage. See the operating manuals below. |

The original reviews also identified strengths worth preserving. The claim register records refuted claims, host evidence distinguishes declared support from observed behavior, and the ledger binds records to their content. The packaged CLI still has zero production npm dependencies. Optional workers use Python and SQLite. [Claim register](status/README.md) · [Host evidence](INTEGRATIONS.md) · [Original substrate phases](plans/substrate-v2/00-overview.md)

## What to use

Start with the goal, an acceptance condition and the smallest reversible prototype. Research a decision when new evidence could change it. Read the project's code, decisions and locked versions first. Search upstream releases, documentation and community experience for missing information. Save the source revision and date, the rejected alternatives, who made the decision, and the next observable check. A planner can use a brief, a CSV and a source comparison. A developer can use the same workflow with a diff, test run and browser interaction.

| Situation | Entry point | Evidence to retain |
|---|---|---|
| Choose an approach or hand off research | `forge prompts list`, `forge prompts show researcher`, `forge develop`, `forge team` | Requirements, sources, decision owner, unresolved reads |
| Learn an unfamiliar project | `forge atlas build`, `forge impact`, `forge context` | Changed symbols, source locations, missing coverage and token budget |
| Decide what to reuse | `forge discover`, `forge reuse`, `forge vet` | Exact upstream revision, license, version compatibility, fixture result and maintenance cost |
| Compare model choices | `forge models`, `forge route models`, `forge route universal` | Profile, capability, dated pricing, measured outcomes and uncertainty |
| Verify a change | `forge verify --json` and the required CI suite | Revision and checkout state, runner exit, executed assertions, skips and verdict |
| Inspect frontend work | Browser interaction checks and visual snapshots | Viewport, fixture, focus order, accessibility observations, before/after and task completion |
| Install hooks | `forge hooks status --json`, then `forge hooks on --hosts <host>` | Owned files, activation, effects supported by the real client |
| Check installation | `forge doctor`, `forge harness drift --hosts <host>` | Launcher resolution and actual host evidence in addition to generated configuration |

Choose a single agent for sequential work. Parallelize independent research or verification only when a lead can specify separate deliverables, integrate them and account for cost. The same proposed change can have different costs on a cached model, an uncached model and a local deployment. Retain all three routes as distinct observations.

## All host and execution combinations

Combine the host row with the installation, memory, provider and component tables. Evidence that a client read instructions, that an adapter returned a verdict, that a real client blocked an action, and that a task passed verification are separate observations. A capability in two independent tables only establishes eligibility. A native run must identify the actual combination it exercised.

| Host | Instructions / MCP | Hook behavior or fallback on the reviewed version |
|---|---|---|
| Claude Code | Shared instructions via CLAUDE.md, project or packaged MCP | Native 2.1.325 exercised project and packaged routes. Inspect the launcher and per-user vs project ownership. |
| Codex CLI | AGENTS.md and project or plugin MCP | Trusted local hooks can deny. Native 0.169.0 delivered evidence in the first request. Review effective size caps and every target in an edit. |
| Codex Cloud | Shared instructions and repository CI | Local trusted hook commands do not run. Use required CI at merge. |
| Cursor | AGENTS.md and project MCP | Shell events can ask or deny. A tool-free turn can miss deferred evidence. Cloud omits session start. |
| Gemini CLI | Context file list and project MCP | Adapter can deny. Preserve the existing GEMINI.md and check the actual client. |
| GitHub Copilot | Shared instructions and VS Code MCP file | Cloud reads default-branch hooks. Check PowerShell and POSIX separately. Ask may become deny. |
| Kimi | Root instructions, trusted workspace MCP, per-user plugin | Native 2.6.2 exercised a verified task. Post-tool callbacks are asynchronous. |
| OpenCode | Shared instructions, project MCP and JS plugin | Native 1.18.31 invoked a hook without delivering its added text to the model. Durable instructions use AGENTS.md. |
| Windsurf / Devin | Shared instructions, global/manual MCP | Uses Claude-format settings. The standalone installation needs its own coverage. |
| Aider | Managed read setting for AGENTS.md | Use CLI and CI. No Forge project MCP or blocking lifecycle adapter. |
| Zed | Shared instructions and project MCP | Check shadowing by higher-precedence instruction files and use explicit verification. |
| Continue | Native rules file and project MCP | Explicit MCP operations and CI. |
| OpenClaw | Execution-folder instructions and manual MCP registration | Verify registration in the intended user profile. |
| Roo Code / VS Code | Per-client MCP configuration | MCP-only. Copilot lifecycle evidence is specific to Copilot. |
| Generic stdio, plain CLI | Manually register the server, or invoke the CLI | Authorize individual tools. Explicit evidence retrieval works without an editor. |

Ordinary MCP exposed 36 tools on the reviewed revision. A trusted supervised checkout exposes only harness run and status. The replacement of human-ratified shared memory was demonstrated on ordinary MCP. The harness pair has a different authority boundary. A local receipt authenticates the producing installation and tested checkout within its trust model. An isolated worktree alone supplies no hostile-code containment guarantee. [Host contracts](INTEGRATIONS.md) · [Harness](HARNESS.md)

## Runtime results and findings

### Acceptance of evidence-based defaults

On Linux with Node 24, the repository suite passed 2,411 of 2,419 tests, with eight skips and zero failures. The browser and container checks below ran separately with their optional runtimes enabled.
- GitHub’s macOS and Windows runs identified checkout path aliases, Git text conversion and Windows npm startup as portability gaps. In a local checkout with an aliased temporary directory and Git line-ending conversion enabled, all 59 hook and guard checks passed. The Windows verifier launches npm through Node. [Initial platform results](https://github.com/CodeWithJuber/forgekit/actions/runs/45565288418)
- Native loopback sessions exercised a complete edit cycle. Claude Code 2.1.325 (project settings and plugin), Codex CLI 0.169.0 and 0.172.0-alpha.2, and Kimi Code 2.6.2 each denied the first edit, accepted a review bound to that operation and then allowed the identical edit. Eight emitted hook dialects passed adapter tests. Other clients still need a native run for this behavior.
- On a local two-tenant service, the encrypted relay round-tripped content, authenticated retries, rejected a stale writer after deletion, and supported an authorized read from a restored SQLite backup. Fifteen Chromium checks and nine digest-pinned container checks passed in separate runs. Production enrollment, key custody and retention require evidence from the operator.
- A real `js-tiktoken` 1.0.21 installation counted a rendered Unicode source excerpt with `cl100k_base` at 19 ordinary-text tokens. The same block occupied 72 UTF-8 bytes. The verification history test signed a genuine passing and failing suite on the same checkout and recovered both run IDs through the CLI.
- Two independent fits reproduced all 162 committed values in the historical routing benchmark. On 350 held-out tasks, the measured router solved 80.0% at an estimated $0.128 per task. A fixed cascade solved 80.6% at $0.136. This replay does not establish current provider prices or a quality advantage. [Reproduction and split](../bench/universal-router/README.md)

### Changes after the runtime reviews

Linux on Node 24 ran 2,433 tests, with 2,424 passes, nine optional skips and zero failures. Chromium passed all 16 browser checks, including the CRLF dashboard. A real two-package pnpm workspace produced two counted passes, and the strict Git hook rejected the same workspace after one test failed. An explicitly throttled loopback cloud push acknowledged its artifact after 56.9 seconds.

Plain init can detect a host without installing commit verification. Explicit selection installs the fallback for clients without edit callbacks. `forge init --review-edits` separately enables impact review. It uses the installed Node launcher and a fresh saved index of code imports and calls. An unavailable index leaves the full suite required.

Verification reads terminal runner reports, groups concurrent pnpm output by package, and separates a successful process with uncounted checks from a signed passing suite. Native Go can provide per-test JSON events. Gradle can provide fresh JUnit XML. MCP preflight names unchecked references and missing index coverage. Recent model calls remain visible across catalog refreshes, and the measured router compares exact decimal totals against the operator’s budget. Optional LLM review records the reason for abstaining when its model needs configuration.

### Acceptance during pull request review

The review added a regression for cache separation between provider accounts and installations. At commit `56748b2`, the Linux Node 24 suite ran 2,450 cases, passed 2,442, skipped eight and recorded zero failures. GitHub's Linux Node 20 and 22 jobs each passed 2,438 of the same 2,450 cases, skipped twelve and recorded zero failures. Chromium passed all 15 browser cases in a separate run with its optional runtime enabled. The packed CLI checks passed on Linux, macOS and Windows, and CodeQL passed. GitHub's dependency review initially returned HTTP 403. Its second attempt at commit `06413d5` passed. [Dependency review retry](https://github.com/CodeWithJuber/forgekit/actions/runs/45554430001/job/139012194218). The separate npm audit reported zero known vulnerabilities in the installed dependency tree. [Review and checks](https://github.com/CodeWithJuber/forgekit/pull/253) · [Hosted Node 20 and 22 results](https://github.com/CodeWithJuber/forgekit/actions/runs/45553942271)

The follow-up review tightened four boundaries. Repeated model lookups in one process reuse the account key for the same installation and credential. The relay authenticates the saved request bytes and still reads earlier queues. The receiver isolates each workspace’s active writer and bounds concurrent reads. Required edit reviews deny requests without a stable session ID. An untracked ForgeKit configuration or helper prevents verification from issuing a staged receipt, including when the repository ignores `.forge/`.

Production key management, calibration of Atlas edge weights and validation of ledger decay each have a tracked evaluation. [Relay key management](https://github.com/CodeWithJuber/forgekit/issues/261) · [Atlas weights](https://github.com/CodeWithJuber/forgekit/issues/262) · [Ledger decay](https://github.com/CodeWithJuber/forgekit/issues/263)

### Local acceptance of the implementation

This table records the earlier implementation run before the pull request review.

| Check performed on 25 November 2026 | Observed result |
|---|---|
| Full JavaScript suite on Linux | Node 20.20.2, 22.23.5 and 24.22.3 each ran 2,449 cases. Each passed 2,441, skipped eight and failed zero. |
| Native client sessions with local model fixtures | Codex CLI 0.169.0 delivered the source row and locator in its first request and enforced the supervised write guard. Claude Code 2.1.325 exercised both its project and packaged-plugin paths. Kimi Code 2.6.2 invoked the supervised runner. Claude and Kimi obtained signed suite evidence and blocked direct native writes. These runs used disposable projects and loopback endpoints. |
| Browser and isolation checks | Chromium passed all 15 visual, keyboard and hosted-dashboard cases. A separate desktop and mobile walkthrough checked model filters and rendered the exported report from its bytes with the network disabled. This machine's managed browser blocks direct file URLs. All nine isolated verification and saved-script cases passed with digest-pinned Docker images. |
| Delivery checks | The npm archive installed and ran in a clean Linux consumer. The source installer passed 16 assertions. Both typecheck configurations, Biome's error gate, generated documentation, 49 claim records and 15 diagram receipts passed. All 55 external Action references in the 20 parsed workflow files use full commit hashes. |
| Algorithm fixtures | The two Python research suites passed 49 and 23 tests. Across nine local runs per synthetic claim count, the median complete prompt hook took 216.2 ms at 5,000 claims and 214.9 ms at 20,000. Median lookup took 6.5 ms and 4.8 ms respectively. Each lookup examined 64 candidates. This reports latency on one machine. Retrieval recall and production savings require separate measurements. |
| Data and operating systems | Production cloud enrollment, paid inference, client versions beyond the named native sessions, and hosted macOS and Windows jobs require separate acceptance evidence. The local implementation has no release tag. |

### Results on the original v1.19.2 baseline

| Baseline verification | Result and scope |
|---|---|
| Official Linux Node 20 and 22 | Each ran 2,364 tests with 2,359 passes, zero failures and five skips. The earlier Linux Node 24 run had the same counts. Another review recorded 2,357 passes and seven skips. |
| Split npm install | Six tool-adoption cases failed where npm was outside Node's installation layout. The official Node distribution passed, which identifies a portability problem. |
| Quality | Clean coverage reported 94.67% lines, 86.35% branches and 95.72% functions for the full command. Typechecking passed. Biome emitted 10 warnings and 32 informational diagnostics. |
| Python, package and optional integrations | Both Python research suites passed (49 + 23). The packed launcher worked and 16 installation assertions passed. Focused Ruff, live Pages and browser tests passed 9/9, 13/13 and 11/11 respectively in the supplied Linux report. |
| Limits | Fresh native AI clients, production tenant entitlements, Docker/OCI, Windows-native hook semantics and current branch protection were outside that runtime run. Earlier CI supplies separate Windows Git Bash and macOS installer evidence. |

The full suite and focused cases answer different questions. Verification signed positive results for empty or skipped suites. A field reviewer observed a positive receipt despite parsed failure counts. Budget patches could remove hard enforcement and concurrent settings updates could lose fields. Ordinary MCP could replace a human-ratified fact and project the replacement to shared instructions. Ledger-only recall and generated views disagreed. The selector treated executable landing code as cosmetic and could reduce mechanically required checks after model refinement. An optional external helper needed argument-safe dispatch.

Mocked outbound bodies showed OpenAI/Gemini model requests changing to defaults and a vendor override affecting another provider. A missing launcher, host event differences and incomplete guard coverage could make generated configuration look healthier than the corresponding integration. Large individual source lines, high claim counts, external lookups during hooks, short acknowledgements and oversized file reads exposed additional reliability gaps. Benchmarks could write environment-specific numbers over the tracked report while the landing page retained an older value. Protocol parse errors, environment scrubbing of the optional visual test and stale documentation were also confirmed.

## Research and product decisions

Public GitHub star history was checked for six projects. The first three intervals use 365, 30 and seven completed days ending 22 November 2026. The final bucket was partial on 23 November. These counts express attention in a selected cohort.

| Project | Last year | 30 days | 7 days | Partial day |
|---|---:|---:|---:|---:|
| obra/superpowers | 317310 | 21309 | 6543 | 392 |
| anthropics/skills | 181679 | 16335 | 3768 | 200 |
| thedotmack/claude-mem | 118720 | 17065 | 1843 | 120 |
| github/spec-kit | 102732 | 8902 | 1192 | 69 |
| ChromeDevTools/chrome-devtools-mcp | 44254 | 5021 | 1705 | 82 |
| backnotprop/plannotator | 14523 | 4980 | 2467 | 98 |

On 23 November superpowers ranked second daily, plannotator first weekly and anthropics/skills and claude-mem fifth and sixth monthly on GitHub Trending. These are separate ranking windows from the API table above. [Star history](https://docs.github.com/en/rest/activity/starring#get-repository-star-history) · [Dated snapshot](https://ageshio.dev/archive/2026-11-23/)

In the 2026 Stack Overflow survey, 63.2% of 12,374 respondents reported incomplete context, 60.9% knowledge held in people's heads, 56.5% outdated information and 53.4% fragmentation across tools. Of 12,678 answering another question, 85.2% wanted project goals, 73.3% code/docs and 44% decision rationale. A November Reddit team described increased review time alongside staffing and process changes. Close issues around compaction and connector discovery support specific regression fixtures. Self-selection and confounders limit prevalence and causal claims. [Survey](https://survey.stackoverflow.co/2026/knowledge/data) · [Team report](https://www.reddit.com/r/TechLeader/comments/1xqzgcs/we_compared_1400_of_our_prs_from_before_and_after/) · [Compaction report](https://github.com/anthropics/claude-code/issues/46457) · [Discovery report](https://github.com/openai/codex/issues/43642)

Compare each capability with established alternatives. Aider offers token-budgeted repository maps, Serena semantic navigation, Context7 versioned documentation, LangGraph checkpoints, GitHub Spec Kit planning and Dify visual workflows. Compare individual advantages on the same tasks. The product hypothesis is reduced time to resume verified work across hosts. [Aider](https://aider.chat/docs/repomap.html) · [Serena](https://github.com/oraios/serena) · [Context7](https://context7.com/docs/overview) · [LangGraph](https://docs.langchain.com/oss/python/langgraph/persistence) · [Spec Kit](https://github.github.com/spec-kit/) · [Dify](https://github.com/langgenius/dify)

## Market refresh on 25 November 2026

### Current public measurements

The first numeric column is the lifetime star total returned by GitHub’s repository API on 25 November. The next four count public `WatchEvent` rows visible in ClickHouse’s `github_events` dataset. The 365-, 30- and 7-day windows all end at 00:00 UTC on 25 November, excluding that instant. The final column spans 00:00 to 03:00 UTC on 25 November, also excluding the endpoint. The dataset’s latest event was at 02:59:59 UTC when queried. Each complete window overlaps the longer windows. [Repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository) · [GitHub event definition](https://docs.github.com/en/rest/using-the-rest-api/github-event-types#watchevent) · [Queryable dataset](https://play.clickhouse.com/play?user=play) · [GH Archive](https://www.gharchive.org/)

| Repository | Lifetime GitHub stars | Observed 365 days | Observed 30 days | Observed 7 days | Observed today to 03:00 UTC |
|---|---:|---:|---:|---:|---:|
| [obra/superpowers](https://github.com/obra/superpowers) | 325,916 | 44,329 | 260 | 80 | 1 |
| [anthropics/skills](https://github.com/anthropics/skills) | 200,049 | 33,678 | 235 | 46 | 1 |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 119,591 | 18,984 | 258 | 22 | 0 |
| [github/spec-kit](https://github.com/github/spec-kit) | 151,296 | 14,189 | 105 | 13 | 0 |
| [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 59,237 | 7,137 | 75 | 15 | 0 |
| [backnotprop/plannotator](https://github.com/backnotprop/plannotator) | 14,921 | 1,601 | 82 | 31 | 0 |

GitHub’s stargazer-history endpoint returned HTTP 403 for the integration used for this refresh. The public event archive offers a different measure and materially undercounts recent activity relative to GitHub’s displayed figures. For example, it yielded 31 events for Plannotator over the complete week while GitHub’s weekly Trending card displayed 1,956 stars. The two windows also have different boundaries. A zero in the partial-day column means the query returned zero rows. These event counts cannot extend the 23 November stargazer series or support year-over-year growth estimates. [Stargazer-history API](https://docs.github.com/en/rest/activity/starring#list-stargazers) · [Weekly Trending results](https://github.com/trending?since=weekly)

### GitHub Trending as displayed at retrieval

| GitHub window | Observed cohort ranks and stars displayed on GitHub |
|---|---|
| [Daily](https://github.com/trending?since=daily) | #2 obra/superpowers, 1,003 stars today |
| [Weekly](https://github.com/trending?since=weekly) | #1 backnotprop/plannotator, 1,956 stars this week. #6 ChromeDevTools/chrome-devtools-mcp, 1,258 |
| [Monthly](https://github.com/trending?since=monthly) | #5 anthropics/skills, 16,946 stars this month. #6 thedotmack/claude-mem, 17,462. #8 backnotprop/plannotator, 5,292 |

The pages change over time. GitHub defines its own ranking and window boundaries. One project can rank above another with a larger displayed gain. Additional entries on those pages included cursor/plugins at #5 daily, modern-web-guidance-src at #3 weekly, security-audit-skill at #2 monthly and agent-browser at #19 monthly. These projects provide comparison points for plugin packaging, freshness, supply-chain review and browser acceptance. [Cursor Plugins](https://github.com/cursor/plugins) · [Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance-src) · [Cloudflare Security Audit Skill](https://github.com/cloudflare/security-audit-skill) · [Agent Browser](https://github.com/vercel-labs/agent-browser)

The downloadable research note includes the reproducible query and suggested comparisons. [Market snapshot](market-snapshot.md)

## Algorithms and validation contract

| Area | Design | Acceptance measurement |
|---|---|---|
| Context | Recompute versioned facts on demand. Reserve mandatory sources first. Choose optional spans maximizing weighted evidence coverage under the available model-token budget. Keep source anchors, revision, incomplete items and freshness on each packet. Send a delta only with a matching prior packet acknowledgement. | Compare with local search and repository maps. Measure tokens, actual billed cost, time to resume and missing evidence on held-out tasks. |
| Memory | Scope by person, workspace and organization. Keep immutable event IDs, causal parents, sources and authority. A competing observation creates a candidate. Approved corrections and tombstones must converge after an offline merge. | Switching agents recovers the approved goal. Revoking a fact removes it from authorized live projections and leaves a visible audit record. |
| Code graph | Combine incremental syntax parsing with type/compiler or SCIP references, reverse dependency edges, strongly connected components and runtime/test dependencies. Treat uncovered features explicitly. | Check renames, types, migrations, generated code and cross-language consumers on unseen repos. Score each edge class. |
| Test selection | Start from changed symbols/resources and their transitive consumers. Include mechanically required suites. Rank optional tests by incremental expected failure coverage per second. Audit against independent full runs. | Count known-failing changes missed as well as individual tests missed. Zero misses in 299 independent known-failing changes gives an approximate 1% upper one-sided 95% miss bound. Use grouped evaluation for correlated changes. |
| Model and team routing | Estimate verified success by model and workload with an item-response model, then minimize expected cost under quality, latency, permission and hard-spend constraints. Preserve the exact profile and provider model ID from recommendation to transport. Separate unrated models from measured high/medium/low bands. Schedule parallel tasks by dependencies and measured coordination cost. | Compare with fixed-model and single-agent runs. Record returned ID if available, retries, cached/uncached tokens, human review and actual spend per verified completion. |
| Script reuse | Capture a private candidate, typed inputs and outputs, runtime, dependency lock, scope, license and expected result. Replay in a clean sandbox. Hash inputs and dependencies for caching. Mutable network, time or external state requires revalidation. | Promote only after skill-on/skill-off held-out runs. Remove or downgrade procedures that drift. |
| Vision and UX | Combine screenshot changes, accessibility trees and browser interactions at pinned viewports with stable fixtures. Review keyboard focus, zoom and actual task completion. | A keyboard-inaccessible submit action fails even when pixels look correct. Include nontechnical participants. |
| Defense | Resolve versions and commits from actual lockfiles, join advisories, assess applicability and prioritize by exposure and confirmed evidence. Permissions, licensing, tenant ACLs and budgets are explicit contracts. | Show affected version, source, owner, fix and verification date. An unavailable advisory service produces unknown status. |

A recent context study found reductions in input size could increase total cost under discounted prefix caching. A curated skills benchmark measured a 16.6 percentage-point gain while another study found no statistically significant effect for 92 of 98 public SWE skills. The six-case ForgeKit JS impact benchmark measured precision 0.16, recall 1.00 and F1 0.27. The older Python router study measured 20.21% higher raw spend across 64 costed comparisons. None of these substitutes for a paired ForgeKit evaluation. [Context costs](https://arxiv.org/abs/2611.22238) · [SkillsBench](https://arxiv.org/abs/2602.12670v4) · [SWE-Skills-Bench](https://arxiv.org/abs/2603.15401v2) · [Impact selection](https://2019.icse-conferences.org/details/icse-2019-Software-Engineering-in-Practice/22/Predictive-Test-Selection)

## Cloud selection and interoperability

The selected product default is full data for a workspace explicitly enrolled in sync. Its eligible artifacts include code changes, decisions, memory, prompts, tool results, screenshots, scripts, verification receipts, model usage and spending. Only artifacts actually available to ForgeKit can be synchronized. Enrollment must show destination and scope. Full-workspace enrollment makes this workspace's previously private captured prompts and proposals available to its authorized dashboard readers. Other workspaces and machine-wide personal data retain their own scope. Connector credentials and unrelated machine data are outside the export contract. Preserve a durable local outbox, deduplicate deliveries, acknowledge after storage and propagate revocations. A relay or dashboard may show stale data while offline. Full artifact sync can incur storage, network and retention costs.

Use a CLI with versioned JSON for ordinary automation, stdio MCP for capable clients, and an authenticated HTTP adapter for enrolled dashboards. Distinguish a portable skill brief from a runnable backend. Capability discovery never grants extra permissions. Older MCP clients initialize sessions. The 2026-07-28 protocol has a stateless core and changed discovery semantics. A successful legacy handshake provides evidence for that revision only. [MCP release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) · [Agent Skills](https://agentskills.io/specification) · [Sensitive telemetry](https://opentelemetry.io/docs/security/handling-sensitive-data/)

## Evaluation and rollout

1. Establish trustworthy receipts, private memory proposals, verified route dispatch and atomic configuration updates. Run packed-install regressions and preserve the authoritative full-suite CI gate.
2. Compare portable continuity on the existing 20-task frozen pilot. Include a planner, a researcher and a developer. Retain accepted outputs and reasons for rejected candidates.
3. Compare selective checks, script reuse and independent browser observations with full verification on the same checkout. Include missing-data, unavailable-provider, malformed-input and offline cases.
4. Run at least 100 paired real tasks before publishing end-to-end productivity or savings figures. Predeclare success, noninferiority margin, review costs, confidence intervals and workload mix. Include all failed tasks and attempts in spend accounting. Until those runs exist, these gains are research targets.

P4 semantic context sufficiency and P8 paired cost evaluation remain partial on the baseline. Split P5's shipped feedback mechanisms from compiler-level graph and mandatory enforcement claims. Maintain separate statistics for named hosts, selectable keys, emitter modules, native runs and deployable routes. Generate docs from source manifests. A changed client, parser, provider or claim dependency invalidates the appropriate evidence. Keep failed evaluations and historical claims visible. [Evaluation protocol](../reports/cost-eval.md) · [Native and integration evidence](INTEGRATIONS.md)

## Operating manuals

[Model, component and host reference](MODELS-AND-COMPONENTS.md) · [Standalone agents and skills](DEVELOPMENT-PROMPTS.md) · [Supervised runs and saved scripts](HARNESS.md) · [Cloud service configuration, limits and deletion](CLOUD.md) · [Keyboard journeys and visual receipts](UI-JOURNEYS.md) · [Integration template and host evidence](INTEGRATIONS.md) · [Paired evaluation worksheets](../reports/cost-eval.md)

<!-- forge:render:consolidated-manuals:begin (generated by `forge docs render` — do not edit) -->
### Use one agent, skill or hook

Use the catalog in the installed package to find an ID. Each entry includes its source. A hook lists the normalized event and tool or session matchers it accepts. A bound skill includes its JSON input schema. A brief can be read by a nontechnical planner or handed to any agent that accepts text.

```sh
forge agents list
forge agents run planner --task "Plan a two-week trial and name a measurable success condition"
forge skills list
forge skills show forge-impact --json
forge skills run forge-impact --input target.json --json
forge skills run forge-ledger --json
forge hooks show protect-paths --json
forge hooks invoke protect-paths --input event.json --json
```

For the impact command, put `{"target":"src/ledger.js"}` in `target.json`. The ledger binding reads stats and the verify binding runs project verification. Other playbooks produce their instructions as a handoff. Select an execution route explicitly when you want a worker.

```sh
forge agents run reviewer --task "Check the evidence for this change" --runner forge
forge agents run reviewer --task "Inspect affected APIs" --host codex --host-billing
forge agents install independent-reviewer --host claude
forge agents uninstall independent-reviewer --host claude
forge skills install forge-ledger --host codex
forge skills uninstall forge-ledger --host codex
forge hooks enable protect-paths --host claude
forge hooks disable protect-paths --host claude
```

The Forge runner uses the project's supervised reviewer profile. Select a configured route with `--route <id>`. The `codex` and `kimi` native runners receive the brief in a temporary directory and charge the selected host account. Include review evidence in the task text. Use the Forge runner when a reviewer needs the project read tools. Configuration and authentication are required to execute with that host. Installing a skill copies its bundled references and scripts. Choose `claude`, `codex`, `copilot`, `cursor`, `gemini`, `opencode` or `portable` for a project directory. Installation and removal check the recorded tree digest so edits and user-owned directories survive. Client-side discovery depends on the host version. The portable directory is `.agents/skills`.

A standalone hook receives a normalized envelope. For example, use `{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"README.md"}}` as `event.json`. Add `--input -` to read JSON from stdin. Invoking a named hook runs just that component. Use `forge hooks run <host> <event>` for the installed host's full guard chain.

In Claude Code, a packaged crew agent installs in the project's `.claude/agents/` directory. Portable roles such as `planner` produce a brief on demand. Enabling one hook registers it in `.claude/settings.local.json` on this machine. Removal checks ownership before editing the registration.

### Plan and research without an AI account

Run `forge demo workshop` from any directory. Add `--json` for the full machine-readable receipt. It requires Node.js, Git and Python 3. The example uses anonymous synthetic RSVP and capacity tables. A researcher counts demand, a planner checks available seats, and one coordinator owns the acceptance decision. Two scoped handoffs are prepared. The result is computed by local CLI commands without starting model workers.

For your own planning brief, give `forge team "<question>" --brief streams.json --handoff generic --json` each stream's concrete paths, acceptance check and optional prerequisite IDs. Name one owner to merge the findings. The `planner` and `researcher` roles work for non-code materials. A scoped worker receives its assigned references and bounded file excerpts. The lead can relay additional citations. Adding `--review` to a team command selects a single independent reviewer. [Worker breakdown and scheduling](DEVELOPMENT-GATES.md#decide-when-to-split-a-task)

In the example, morning has 12 RSVPs for 14 seats. Afternoon exceeds capacity by one. The printed result includes both alternatives, the acceptance condition, original row ranges, the Git revision and the reusable claim ID. Reuse only after confirming the source hashes still match. The example tests a changed source and an edited report as well as the successful reuse case. This fixture demonstrates the workflow. To measure outcomes on real participants and work, follow the consented 100-pair pilot. [Workshop walkthrough](../examples/workshop-planner/README.md) · [Paired pilot](../reports/cost-eval.md#run-the-paired-pilot-locally)

### Find models for your account and workload

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

### Monitor a frozen model for regressions

Run `forge route monitor observations.json --json` on an exported set of anchor results. The command reads a local JSON file of up to 16 MiB and prints `cold-start`, `normal` or `review`. Every valid outcome is advisory and exits successfully. Invalid evidence exits with an error. Review the underlying test results before changing a model’s band. The command makes zero model requests and writes no routing or model configuration.

Freeze the provider, exact model ID, immutable deployment revision and evaluation protocol before collection. The protocol digest should cover the anchor definitions, grader, sampling settings, retry policy, tools and execution environment. If a provider supplies only a mutable alias and no deployment identifier, the model revision cannot be established for this comparison. A run is a fresh independent repetition of **every** anchor. Fix the evaluation horizon in runs, the smallest meaningful absolute decrease in pass rate, and the per-window false-alarm budget before inspecting outcomes.

This empty, synthetic specification returns `cold-start`. Replace its identifiers and example digest with recorded provenance before evaluating a model.

```json
{
  "schemaVersion": 1,
  "subject": {
    "provider": "example", "model": "model-A", "revision": "release-001",
    "protocolSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "anchors": ["rename", "review"],
  "alpha": 0.05, "meaningfulDrop": 0.10, "horizon": 8,
  "independentRuns": true, "stableHistory": true,
  "fit": [], "calibration": [], "evaluation": []
}
```

Place baseline runs in `fit`. Put separate stable windows inside `calibration`, each containing exactly `horizon` runs. Put the subsequent window of runs directly in `evaluation`. Each run has a unique `id`, a UTC ISO `at` timestamp (seconds or milliseconds), a copy of the four `subject` fields and an `outcomes` object such as `{"rename":true,"review":false}`. All three splits use the identical anchor IDs. Run timestamps increase strictly across the entire file. Exclude infrastructure outages from collection only under a predeclared missing-data policy. Record such exclusions in the study log to avoid selectively dropping failures.

For each run, compute its fraction of failed anchors `f`. Let `b` be the mean failure fraction across the fit runs and `d` the predeclared meaningful drop. Reset the one-sided CUSUM at the start of each window and update `C = max(0, C + f − b − d/2)`. Each stable calibration window supplies its maximum `C`. With `n` stable windows, the boundary is the `ceil((n+1)(1−alpha))`-th smallest calibration maximum. If the required rank exceeds `n`, the result is `cold-start`. At `alpha=0.05`, at least 19 complete calibration windows are needed. A missing fit or unfinished evaluation also returns `cold-start`.

An evaluation maximum strictly above the boundary returns `review`, including the first crossing run ID. A tie returns `normal`. The empirical p-value is `(1 + number of calibration maxima ≥ evaluation maximum)/(n+1)`. Under exchangeable stable calibration and evaluation windows conditional on the separate fit data, this limits the marginal false-review probability for one fixed horizon. The input declarations describe the data collector’s assumptions. Duplicate IDs and mixed protocols can be detected from the file. Honest independence, version immutability and environmental stability require collection receipts. Repeated monitors, overlapping windows, post-hoc parameter choices and pooled model comparisons need their own error-budget design. A normal window can still miss a small degradation. [Page’s CUSUM procedure](https://doi.org/10.1093/biomet/41.1-2.100) · [Introduction to conformal prediction](https://arxiv.org/abs/2107.07511)

### Keep a temporary script for reuse

Capture a local helper that another agent can replay against structured data. A script receives the input JSON filename as its first script argument. It prints one JSON object to stdout. Standalone JavaScript (`.mjs` or `.cjs`) and Python (`.py`) are supported when the selected image provides the interpreter and POSIX shell utilities. Include any runtime dependencies in the image.

For example, save the following as `square.mjs` in your worktree.

```js
import { readFileSync } from "node:fs";
const { n } = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify({ n: n * n }));
```

Save the specification as `recipe.json`. Replace `<digest>` with the 64 hexadecimal digits of a locally available, operator-reviewed image digest.

```json
{
  "path": "square.mjs",
  "runtime": "docker",
  "image": "node@sha256:<digest>",
  "inputSchema": {"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]},
  "outputSchema": {"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]},
  "fixtures": [
    {"input":{"n":2},"expected":{"n":4}},
    {"input":{"n":-3},"expected":{"n":9}}
  ]
}
```

```sh
forge skills capture-script square --input recipe.json --json
forge skills scripts --json
forge skills verify-script square --digest <capture-digest> --json
forge skills pin-script square --digest <capture-digest> --json
forge skills replay-script square --input request.json --json
```

Put `{"n":5}` in `request.json` for a replay yielding `{"n":25}`. Capture saves the script bytes, schemas, runtime, image and fixtures under a local SHA-256 digest in private per-worktree ForgeKit state. Verification runs each input in a fresh Docker or Podman container and compares the parsed output with the expected object outside the container. Replay requires a pinned digest with a passing verification receipt. A failing verification invalidates that receipt. Changing the original script leaves existing pins reproducible. Capture the new version, verify and pin its new digest to adopt it.

Containers run without network, repository files or host credentials. They receive the captured script and its current input on a read-only mount and discard temporary writes. The runtime requires a locally available digest-pinned image, resource limits and a nonroot user. Unavailable isolation leaves a candidate unverified. Capture accepts one to 32 object fixtures, limits the bundle to 256 KiB and limits each JSON input and output to 64 KiB. The harness schema validator checks declared properties and rejects unknown keys. Fixture coverage determines what a passing comparison establishes. Inputs and fixtures should contain synthetic or shareable data.

### Develop a plugin or adapter

`forge integrations template --json` returns a versioned catalog with permission descriptions, exact CLI argument arrays, and supported MCP revisions. `forge integrations template --out plugins` creates the starter in a new project directory. It includes a working read-only reference plugin and its editable source. Review it with `forge harness extensions inspect plugins/team-guide`. Pin its digest only after reviewing the actual content. The copied README covers upgrades and removal. [Starter files](../templates/integration-developer/README.md)

| Task | Entry point | Access and lifecycle |
| --- | --- | --- |
| Add a reviewed reference to the supervised harness | Inspect and pin `plugins/team-guide` | A local approval and a project lock pin the package bytes. Changes require a new review. |
| Call from a non-MCP planner or script | `forge skills show forge-ledger --json`, then `forge skills run forge-ledger --json` | The caller invokes a named CLI operation with typed input. The ledger example reads stats. |
| Use a stdio MCP client | Launch the installed ForgeKit executable with the `cortex-mcp` argument | The server offers protocol revision 2024-11-05. If a client requests a different dated revision, it receives the supported alternative and can disconnect. Client permissions govern tool use. |
| Bind an installed stdio server | `forge integrations local team-tools --binary /opt/team/bin/team-mcp` | ForgeKit pins executable bytes and explicitly selected arguments and environment names for the worktree. Review and rebind a changed executable. |
| Use a hosted service | `forge integrations connect team-docs --url https://docs.example.org/mcp --token-env TEAM_DOCS_READ_TOKEN` | Replace the example hostname and issue the narrowest read token at the service. The optional discovery probe accepts 2025-11-25, 2025-06-18 or 2025-03-26 Streamable HTTP revisions and verifies the returned revision. |

For managed host configurations, review conflicts before using `--adopt`. Removal acts on owned entries and preserves other servers. Service credentials and ACLs enforce HTTP scopes. The inspection report and template declare the intended permissions. [MCP lifecycle and version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

### Verify a keyboard workflow in a browser

Use a journey for a user action with an observable outcome, alongside the existing visual-style and general interaction checks. Describe the accessible role and exact name expected after each keyboard action.

```json
{
  "viewport": {"width": 390, "height": 844},
  "steps": [
    {"key":"Tab","role":"button","name":"Show order","expect":"focused"},
    {"key":"Enter","role":"heading","name":"Order ready","expect":"visible"}
  ]
}
```

Run `forge uicheck journey http://localhost:3000/orders --spec journey.json --json`. Point `FORGE_PLAYWRIGHT` at an installed Playwright module if your runtime is outside the package. Specify a trusted absolute system Chromium executable through `CHROME_BIN` when the Playwright-managed browser is unavailable. Desktop journeys default to 1280 × 800. Supply your supported mobile dimensions to verify that layout.

Each successful step records the expected role/name, the key, a target screenshot and its SHA-256 digest under `.forge/ui/journeys/`. The receipt also includes the observed accessibility subtree where the browser supports it. A missing expected control or wrong focused element fails the journey. An unavailable browser, failed navigation or missing screenshot produces an incomplete result. Both outcomes return a nonzero CLI status. Re-read a saved screenshot alongside its receipt when a UI review needs visual confirmation.

The browser uses an isolated context, reduced motion and same-origin requests. Use `--remote` to authorize a remote start URL. Choose a disposable test account and fixture for interactions that submit forms. Re-run with a changed expected role or name as a negative control. The journey verifies this workflow, viewport and browser. Include screen-reader users and other assistive technologies when evaluating accessibility across a product.

Run `npm run test:visual` with the optional runtime configured to exercise the live browser gate and keyboard journey tests.

For the developer dashboard, run `node scripts/dashboard-preview.mjs --check` from a checkout. This checks desktop and mobile views, the provider model filters, verified runs and an exported offline report. Managed browsers that block file URLs can use `--check --report-from-memory`. That mode loads the exported HTML bytes into a blank document with network access disabled.

### Self-hosted ForgeKit workspace sync

Use cloud sync when a team wants the contents and history of an explicitly enrolled project on its own server. The service needs Node 20+ and an installed Python 3 with SQLite. Provision the following configuration on the server outside any enrolled directory. Replace the data directory with an absolute, owner-only directory and provision distinct, unpredictable bearer secrets of at least 32 characters in the named environment variables. The example variable names contain no credentials.

```json
{
  "port": 4243,
  "dataDir": "/var/lib/forgekit/workspaces",
  "principals": [
    {"tenant":"team","workspace":"demo","role":"writer","tokenEnv":"WORKSPACE_UPLOAD"},
    {"tenant":"team","workspace":"demo","role":"reader","tokenEnv":"WORKSPACE_READ"},
    {"tenant":"team","workspace":"demo","role":"admin","tokenEnv":"WORKSPACE_ADMIN"}
  ]
}
```

Start the receiver with `forge cloud serve --config /path/to/server.json`. It listens on loopback. Use a TLS reverse proxy for remote users with request size and timeout limits appropriate to your deployment. Open the service root in a browser and enter the workspace ID and reader token. The page shows the current revision, files, sizes, redaction status and recent syncs. Filter files by path, inspect a sync for its changed paths, or select a file to verify its SHA-256 digest and download it. Preview text up to 256 KiB and PNG screenshots in the browser. The page keeps credentials in tab memory. Use **Clear session** when finished. Protect the database volume and its backups using your server's encryption and retention policy.

#### Enroll a workspace

Choose a project directory separate from ForgeKit's private user state. The enrollment and snapshot checks cover both directions of nesting. To share workspace-scoped memory, enroll the project that owns it.

Run these commands inside the chosen project. `preview` reads the workspace locally and lists metadata and omission counts. After configuring the credential, preview again to include the exact active credential in the redaction check. Enrollment alone does not transmit the workspace.

```sh
forge cloud preview --json
forge cloud configure --full-workspace --url https://forge.example.org --workspace demo --token-env WORKSPACE_UPLOAD
forge cloud push
forge cloud status --remote
forge cloud watch --interval 30
```

The first push publishes the enrolled workspace. Later pushes transfer changed artifacts and deletions. Watch retries pending changes and uses bounded backoff on transient failures. Each batch carries its parent revision and a stable ID. A disconnected machine retains pending bytes in private user state. Retried requests are idempotent and stale writes receive HTTP 409. Inspect the remote manifest before deliberately replacing its baseline with local contents using `forge cloud push --replace-remote --confirm`. The local and remote views can diverge after an offline run. A successful push of pending bytes acknowledges that exact batch. Push again to send subsequent changes.

#### What is included

Git determines which regular files the workspace shares. Tracked and untracked source, screenshots and scripts are eligible. Git ignore rules apply by default, including nested rules and exceptions. Use `forge cloud preview --include-ignored` to see the additional paths. Enroll with `configure --full-workspace --include-ignored` to include them in pushes and watches. Relay uses the same selection. Credential, database and link exclusions apply in both modes. ForgeKit also exports this workspace's own private prompt/proposal directory, captured reusable skill recipes, harness run records and logically scoped memory, job, audit and spending records when available. These appear under the virtual `.forge-cloud-export/` prefix. A real file or directory at that prefix prevents upload to avoid collision. A model or host that never emitted a prompt, action, result or usage receipt leaves no such artifact to synchronize.

Credentials named by the enrolled token variable are removed from text before upload. Other text passes through ForgeKit's secret redactor. Selected credential paths, VCS internals, dependency caches, symlinks, hard links and special files are excluded. Generic opaque SQLite databases and journals are excluded. Known ForgeKit stores use scoped logical export instead. Binary media is eligible, and binary files that match known credential patterns are omitted. Images, documents and newly generated arbitrary files can contain confidential content invisible to a text redactor. Review the eligible paths before enrollment. Redaction and the exclusions below make this a selective project mirror. Global home directories, personal/team memory belonging to other scopes, executable trust bindings, local runtime grants and unrelated workspaces are outside the capture.

One sync supports up to 20,000 eligible files, 24 MiB per artifact and 128 MiB total payload bytes. Exceeding a limit fails the snapshot explicitly. File stability is checked per read. Stop rapidly changing writers for a reproducible snapshot. Only the latest content is retained. The service stores the latest bytes and an ordered history of sync receipts and changed-path manifests. An unchanged file incurs no second upload.

Snapshot inspection recognizes SQLite database and journal headers as well as common database extensions. When an application uses a custom filename, its recognized database and associated sidecars stay outside the file mirror. The workspace-specific logical exports listed above still apply. [SQLite file format](https://sqlite.org/fileformat.html)

Uploads allow 45 seconds for setup plus the encoded request size divided by the minimum transfer rate. The default rate is 65,536 bytes per second. Set `FORGE_CLOUD_MIN_BYTES_PER_SECOND` on each endpoint to accommodate a slower connection. The server also closes idle connections.

#### Permissions, logout and deletion

Reader credentials can list the workspace and retrieve eligible artifacts, including workspace-scoped prompt records and proposals that were private before full-workspace enrollment. Grant reader access accordingly. Writers can read metadata and upload. Administrators can perform these operations and delete remote contents. Credentials are constrained to one tenant and workspace on the service. Rotate or revoke a key in server configuration and restart the receiver. The client stores its endpoint, credential variable name, cursor and queue outside the enrolled repo.

- `forge cloud logout` clears local enrollment, pending bytes and the acknowledged cursor. The hosted data remains available to other authorized users.
- `forge cloud delete --confirm` sends an authenticated deletion request, then clears local enrollment after acknowledgement. Supply the configured workspace's admin token through its credential environment variable. The server deletes stored contents and receipts, and advances a deletion generation to reject stale uploads. SQLite retains one row in `heads` containing the tenant/workspace scope and a new tombstone UUID. It uses that generation to reject uploads created before deletion. Server backup retention is an operator responsibility.
- Reusing a deleted workspace ID requires deliberate baseline replacement on the newly enrolled client. A new workspace ID starts empty.

The API exposes `GET /v1/workspaces/{id}` for the manifest and latest 100 receipts, `GET /v1/workspaces/{id}/events?after=<revision>` for paginated incremental receipts, `GET /v1/workspaces/{id}/events?id=<revision>` for changed paths and content hashes, `GET /v1/workspaces/{id}/artifact?path=…` for a base64-encoded artifact and hash, `POST /v1/workspaces/{id}/sync` for a versioned change batch and `DELETE /v1/workspaces/{id}` for deletion. The receiver enforces per-workspace write admission and separate limits for concurrent readers and writers. Local `forge dash` remains independent of the web service.

#### End-to-end encrypted relay

Choose `forge relay` when the receiver should store encrypted content. The same Node and SQLite service can run in relay mode on a separate port with a separate private data directory. Use the scoped principal configuration above. A workspace can have independent dashboard and relay enrollments. Each has its own credentials, queue, revision and logout.

Generate one random 32-byte workspace encryption key using a secret manager, with standard base64 encoding. For example, `openssl rand -base64 32` produces that format. Keep the key on the authorized clients and deliver it to collaborators through an independent trusted channel. Use a different bearer credential for each reader, writer and administrator. Keep the encryption key out of the server configuration, shell logs and project files. Losing every copy of the key makes the encrypted workspace unreadable.

Start the receiver with `forge relay serve --config /private/relay.json`. It binds to loopback, accepts the scoped relay API and serves a text landing page. Use an HTTPS reverse proxy for remote access. The operator controls bearer credentials, the tenant and workspace IDs, storage, deletion and backups. Read decrypted files with an independently installed client.

The service exposes status, sync, events, artifact retrieval and administrator deletion under `/v1/relay/{tenant}/{workspace}`. Artifact retrieval takes an opaque object identifier and the expected current revision. An operator with the scoped administrator credential can delete the active data through the API if all clients lose their encryption keys.

The following commands assume the client has the workspace key in `WORKSPACE_RELAY_KEY` and the appropriate scoped bearer credential in `WORKSPACE_ACCESS`.

```sh
forge relay configure --full-workspace --url https://relay.example.org --tenant team --workspace demo --token-env WORKSPACE_ACCESS --key-env WORKSPACE_RELAY_KEY
forge relay preview
forge relay push
forge relay status --remote
forge relay list
forge relay read README.md --revision "$EXPECTED_REVISION" --json
```

A push returns its revision. Send that revision over an independent channel when a second device needs to verify an exact snapshot. Set `EXPECTED_REVISION` on the reader to that value. On the reader, configure the same endpoint, tenant and workspace with its own bearer credential and the shared encryption key. `list` decrypts names and metadata locally. `read` writes the verified bytes to stdout. Use `--path=--help` for a file named `--help`. The JSON form returns base64 bytes, verified SHA-256 and the revision. The reader chooses the destination. Provision a reader or administrator token for file contents. A writer with the workspace key can verify the encrypted manifest for replacement. `watch`, `logout` and administrator `delete --confirm` follow the cloud operations above in the relay's separate storage namespace.

##### What the relay can observe

The client encrypts the manifest and changed artifacts after local redaction. Protocol version 1 derives separate keys with HKDF-SHA-256 for each tenant and workspace. A path becomes an HMAC-SHA-256 identifier. Each record uses an independently derived revision-and-object key, a random 96-bit nonce and AES-256-GCM with a 128-bit tag. Authenticated data includes the protocol, tenant, workspace, object identifier and revision. The encrypted manifest binds the path, content digest, media type, redaction status, ciphertext digest and originating revision of every file. The client verifies the complete manifest and the selected file before returning its bytes. Retrying a pending push reuses the exact sealed batch. An unchanged artifact retains its identifier and ciphertext.

The receiver sees tenant and workspace IDs, credentials presented to it, timestamps, revision links, counts, ciphertext lengths and repeated opaque file identifiers. It can infer which encrypted objects changed and can withhold or serve older data. A revision received through an independent channel detects a rollback. A first-time reader without such a revision establishes only that the snapshot was written by someone holding the shared key. `status --remote` verifies the manifest locally and reports its revision, authentication status and file count. An empty or deleted workspace with no encrypted manifest reports `authenticated: false`. A key holder can create a valid manifest. Client compromise, access-pattern privacy and individual author signatures are outside this protocol. [HKDF](https://www.rfc-editor.org/rfc/rfc5869) · [GCM](https://csrc.nist.gov/pubs/sp/800/38/d/final)

The 128 MiB snapshot limit includes the sealed manifest and encryption overhead. Up to 20,000 artifacts are supported, with one additional manifest. The existing 24 MiB file limit applies to plaintext artifacts and to the encoded manifest before encryption. Exceeding any bound fails the push. The client records the credential variable names and a key binding in enrollment state. Pending artifact bytes and the cursor manifest are encrypted on disk. A client-only authentication tag covers the exact saved request bytes. The client can also retry queues created with the earlier format. If local queue bytes change, the client rejects the retry before contacting the receiver.

Changing either scope or key requires a new enrollment. To rotate after a device loses access, provision a new workspace ID, encryption key and scoped bearer credentials, publish a fresh snapshot, revoke the old credentials and apply your retention policy to the old workspace. A holder of a previous key may retain already decrypted files and decrypt copies of ciphertext they retained. Remote deletion clears active contents and receipts. Operators separately expire old database copies, WAL archives, volume snapshots and replicas according to policy.

##### Verify a deployment

Use disposable tenants and synthetic files. Publish a known text fixture and binary artifact, transfer the resulting revision to a separate reader, and verify the local content digests. Confirm a credential scoped to another tenant cannot read this workspace even when both tenants use the same workspace ID. Disconnect a writer after the server stores a revision, then retry the push and check it reports the same revision. Delete the sandbox as an administrator and verify the old writer's queued parent revision is rejected.

For backup acceptance, use SQLite's online backup API or the SQLite shell's `.backup` command to a new owner-only file on the operator's private volume. Restore it into a fresh private data directory on a separate loopback instance. Verify a known saved revision and file digest with the trusted client. The repository's `test/cloud_relay.test.js` runs this drill with synthetic keys and checks that a later receipt detects a stale restore. Record the production TLS configuration, recovery time, effective access policy and backup expiry for the deployment where they were observed.

The receiver allows one active upload or deletion per tenant/workspace. Other scopes can write concurrently while capacity is available. Receiver configuration accepts positive integer `maxConcurrentWrites` and `maxConcurrentReads` limits. The defaults are two writers and four read workers across all scopes. A saturated limit returns HTTP 429 and releases its slot when the operation finishes or fails.

### Memory storage and recovery

#### Learning from corrections

A captured recovery starts with a command’s nonzero exit code. A later success of the identical command completes it. Cortex records the intervening target files. A file that received multiple edits supplies a second observable source. Commands whose text needed secret redaction are ineligible. A different successful command, wording in a prompt, or edits alone cannot establish a correction. The result reports the distinct signals and their sources. An explicitly recorded human correction can also propose a lesson.

The first supported episode produces a private proposal. Session captures and pending lessons are isolated by checkout under `cortex-session-events-v2` and `cortex-corrections-v2` in the operating system user’s ForgeKit state directory. Neither is included in cloud workspace exports, shared memory, generated host instructions or MCP lookup. The handoff command can still carry recorded assumption markers. Historical checkout session logs remain readable for assumptions and cannot establish new corrections.

Inspect the proposed wording, locations and episode count, then confirm the lesson you want to share.

```sh
forge cortex review --json
forge cortex confirm LESSON_ID
forge cortex why path/to/file
```

An independent second recovery on the same file and command can publish the original observation. The operator can publish sooner by confirming the proposal. If an opt-in distiller changes its meaning, the revised wording stays private until operator confirmation. This also applies if the original observation was published while the distiller ran. A reviewed replacement retains the prior claim as its parent and starts with its own approval receipt. ForgeKit reports the episode and independent confirmations separately. Showing a lesson to an agent adds no confirmation.

A recovery receipt binds the target file to the host’s failed and successful tool action IDs. If either ID is unavailable, one session can support at most one recovery for that file and command. Replaying a receipt on a different day adds no evidence. When a host supplies neither action IDs nor session identity, repeating the anonymous trace has the same limitation. A session’s temporary private event log is cleared at Stop. Stale captures follow the existing session pruning window.

For newly published lessons, the number of distinct confirming receipts must exceed opposing receipts for the lesson to be active. A tie with at least one contradiction places it in quarantine. A successful Git revert counts against a lesson only when the reported Git commit reverses the matching file blobs and the checkout observed the reverted version in a correction episode. Cortex resolves OS aliases for the checkout and rejects linked targets inside it. It compares exact file bytes and can also match an LF Git blob to a CRLF worktree when Git identifies the file as text and its built-in conversion applies. Custom filters, identifier expansion and working-tree encodings receive only the raw byte comparison. Files larger than 1 MiB and unobserved versions have no automatic reversal attribution. A retracted lesson stays retired. Historical lesson claims retain their version’s original scoring and lifecycle.

#### Organization access on one installation

ForgeKit stores the harness memory database under the operating system user's private state directory. The checkout’s canonical path identifies its repository scope. An operator can authorize individual checkouts to read or publish to a named organization on the same installation. Organization names are case-insensitive.

In the checkout that owns a verified claim, run the following commands.

```sh
forge harness memory org-grant platform write
forge harness memory org-grants
forge harness memory share CLAIM_ID organization --organization platform
```

In a second checkout, grant read access and select the organization for the query.

```sh
forge harness memory org-grant platform read
forge harness memory recall "deployment window" --organization platform
forge harness memory history SHARED_ITEM_ID --organization platform
forge harness memory org-revoke platform
```

A write grant includes read access. Changing a grant to `read` immediately removes permission to publish. Revocation takes effect on the next database transaction, including for callers with an existing store handle. Read permission requires both a current grant and an explicitly selected organization. Recall first searches the checkout's eligible facts. When these have no matches, it searches the selected shared scopes.

The publisher chooses each active L3 item to share. Publication copies the verified assertion and its evidence reference. The source checkout retains the underlying receipt. If the source evidence is contradicted, previously shared copies are flagged for review. Personal and team memory have separate namespaces. The MCP tool registry exposes no organization grant or share operation. Cloud workspace exports contain that workspace's records and exclude organization grants and shared copies. A user with full shell access to private state already controls the local account. These grants implement local checkout sharing. Cross-device identity and directory federation require a separate authority.

#### Upgrading older lessons and recall files

Portable repository facts and Cortex lessons use the content-addressed ledger at `.forge/ledger`. Personal recall uses the ledger inside the user's private recall directory. `MEMORY.md` and `AGENTS.brain.md` are derived indexes. Source files from early versions may still contain lessons or facts missing from the ledger.

```sh
forge ledger migrate --json
forge ledger migrate --personal --json
```

The first command captures `.forge/lessons/*.md` and `.forge/brain/facts/*.md`. The second captures `facts/*.md` in the private recall store. Historical `episodes.jsonl` files remain available for inspection. New Cortex captures and provisional observations live in private checkout-scoped user state. `forge ledger import` invokes the same migration. The former `FORGE_LEDGER_ONLY` setting has no effect on live reads or writes.

Each result includes the snapshot ID, source file count, imported lesson, fact and outcome counts, number of previously tracked entries retained, and verification result. A SHA-256 digest covers the paths and exact source bytes, including line endings. Backups and migration receipts reside outside the checkout under `ledger-migrations-v1` in private user state. Treat this directory as part of a device backup.

An existing ledger fact or lesson with the same logical name takes precedence. Archived and retracted claims retain their disposition. For a new historical lesson the importer carries its episode references, expands confirmation counts at the last confirmation day and contradiction counts at the creation day, and records a historical retirement. Earlier file formats retained aggregate counts instead of per-event dates. Repeating a completed migration adds no evidence. An interrupted import can fill in missing records from its original bytes. Concurrent migration commands serialize on the selected scope. If an interrupted process leaves a lock, the command reports its path. Check that the recorded process has exited before removing that specific lock.

The importer rejects malformed lessons, credential-shaped content, linked source files, oversize records and unsafe paths. Its input limits are 1 MiB per file, 32 MiB of source bytes per snapshot, 10,000 files and 10,000 historical outcomes. Correct the reported source and retry. Changing eligible source bytes produces a new snapshot ID. The original files remain available for inspection.

#### Restoring original files

Run from the checkout that made the backup. Personal backups are accessible across checkouts under the same private installation.

```sh
forge ledger restore-legacy ../restored-forgekit
forge ledger restore-legacy ../earlier-copy --snapshot SNAPSHOT_ID
forge ledger restore-legacy ../restored-recall --personal
```

Choose a new destination directory under an existing parent. Restore verifies the manifest before writing, then checks each output digest against the saved source. The restored tree preserves the original paths and bytes. It contains historical files as of the selected migration. Recent ledger-only activity is available through the ledger's export and synchronization commands.

#### Ranking ledger queries

The CLI, MCP, dashboard search and similar-task lookup rank live claims with `empirical-midranks-v2`. `forge ledger query "payments" --json` reports the ranking version and similarity backend. Inputs are query similarity, overlap with recorded scope names, recency of a confirmation or mint, and the ledger's evidence-based validity. ForgeKit uses one similarity backend per query.

For each input that varies across the candidates, its percentile equals the number of lower values plus half the number of equal values, divided by the candidate count. ForgeKit averages these percentiles and multiplies by the larger of text similarity and scope overlap. When all inputs tie, the measured match alone sets the score. Exact ties use the content address. Four sorts cost O(n log n) after measuring the candidates. The score is specific to the query's candidate set. `retrieve` accepts `ranking: "eq3-v1"` for reproducing older numerical results.

Harness recall ranks its local FTS5 and evidence graph candidates separately. It averages tie-aware percentiles for BM25 relevance, the number of connected lexical matches, recorded verification level, timestamp, and the posterior success rate of completed uses. For `p` passed checks in `n` completed uses, the estimated rate is `(p+1)/(n+2)`, the posterior mean under a uniform beta prior. `observedOutcomes` reports the actual passed and failed counts. Earlier SQLite files can reconstruct these counts from the same recorded use edges and receipts.

### Stable automation contracts

Automation can depend on the v1 CLI envelopes and the v1 context packet consumer. An incompatible change to one of these formats requires a new version selector. Consumers should ignore unfamiliar fields. Individual command payloads retain their own schemas. A provider's catalog, a measured quality band and the text that a human sees can change with the evidence.

#### Read one command result

```sh
forge --output=json-v1 verify --json
forge --output=json-v1 models --json
forge --output=json-v1 verify triage --json
```

The global option goes before the command. The command receives its normal arguments, working directory, environment and standard input. Its exit status reaches the caller. Each envelope contains `schemaVersion`, `command`, `exitCode`, `signal`, `complete`, `stdout` and `stderr`. Each stream reports its byte length and truncation flag. A stream with a complete JSON value uses `kind=json` and a parsed `value`. Other UTF-8 output uses `kind=text` and a string. Binary output uses `kind=binary` and `base64`. Each stream keeps its first 8 MiB in this mode. A truncated response sets `complete=false`. Check the exit code, completeness and the command's own verdict before acting on a verification result.

For larger outputs or a running process, use `forge --output=jsonl-v1 <command>`. Each line identifies the schema version and command. The first event is `started`. Intermediate `stdout` and `stderr` events carry base64 bytes in stream order. Decode and join chunks separately for each stream. The final `exit` reports `exitCode` and `signal`. When a host expects MCP stdio or hook JSON, invoke its native command with the transport specified by that host.

#### Count and reconstruct context

```sh
forge context "Review the invoice parser" --budget 1200 --packet --json
forge context "Review the invoice parser" --budget 1200 --encoding cl100k_base --packet --json
```

The default counts the exact UTF-8 bytes of the assembled block. This is an upper bound for byte-level tokenizers. For an exact supported encoding, install `js-tiktoken` in a trusted location outside the target checkout on ForgeKit's Node module search path. Select the encoding used by your deployment. The renderer counts the joined block including separators, Unicode and ordinary text that resembles special tokens. The budget excludes host instructions, tools, chat wrappers and other provider-added input.

Import `contextCounter` and `applyContextPacket` from `@codewithjuber/forgekit/context-packet`. When a packet names an encoding, obtain the same encoder with `contextCounter(name, workspacePath)` and pass it as the third argument to `applyContextPacket(packet, priorSnapshot, counter)`. A digest binds the encoder identity, package version, chunk order and context manifest. Retain the validated snapshot before acknowledging it. A missing base requires a full packet. Old v1 manifests keep their original counting convention for reconstruction.

#### Inspect verification history

`forge verify triage --json` reports repeated counted suite outcomes from locally authenticated events for this checkout. Runs match on the verifier version, head, measured working-tree bytes, recorded environment, suite command, directory and coverage. A pass and failure in one group produce `inconsistent` and both run IDs. One run produces `one-observation`. Identifying the root cause still requires reading the failures. The latest verification verdict and commit decision continue to use the actual run result. An environment digest covers the recorded attributes of the verifier. Clocks, external services and ignored dependencies can still vary.

The contract tests exercise the normal CLI, earlier packet formats, wrong encoders, missing bases, tampered content, distinct working trees and mixed suite outcomes. The experimental host adapters and hosted deployment settings have separate acceptance records. [Host evidence](INTEGRATIONS.md)

Staged verification inspects untracked files under `.forge/` even when Git ignores that directory. A local configuration or helper outside the index prevents a staged receipt. Ordinary worktree receipts include these inputs in their fingerprint. ForgeKit excludes its generated Atlas files, ledger state cache, verification journal, provenance, UI receipt and per-session end-to-end evidence trails. Dependencies and the commands supplied by the project still belong to the local test environment. Use a clean development worktree to verify staged changes when private local files must stay outside Git.

### When to use multiple agents

The lead owns edits and verifies the combined result. Select `--review` for one independent reviewer or use a JSON brief to name each read-only assignment, its file scope, acceptance criterion and dependencies. Without a selection the plan keeps the work with the lead. Prompt wording cannot authorize additional workers.

```sh
forge team "Review the retry change" --review --handoff generic --json
forge team "Trace the retry change" --brief streams.json --json
forge team "Trace the retry change" --brief streams.json --run claude --budget-usd 0.20 --max-workers 2 --json
```

The first two commands generate local handoffs or plans. The scheduler releases ready work up to the configured concurrency ceiling. It uses previous durations or explicit estimates to prioritize the longest dependency chain. If durations are incomplete, the longest chain of remaining tasks gets priority. A failure blocks dependent work and leaves independent findings available. Scoped briefs include the selected paths and bounded, redacted source excerpts from ordinary workspace files. A directory scope can supply indexed symbol locations within that directory. [Breakdown example and scheduling details](DEVELOPMENT-GATES.md#decide-when-to-split-a-task) · [ForgeKit orchestration](ORCHESTRATION.md)

The third command sends the scoped briefs to the configured provider using Claude Code. The executor checks host capabilities before launching. Scoped workers run in temporary directories with built-in tools disabled. The explicitly selected project-wide `--review` role runs in the worktree with Read, Grep and Glob. The host runs in bare, restricted mode with strict MCP configuration and session persistence disabled. Choose `--model MODEL_ID` for an explicit native model or let the selected provider or CLI supply its default. Each receipt distinguishes the requested model and the model IDs the provider reported. To preview timing for a particular route, pass `--handoff claude --model MODEL_ID` or supply `host` and `model` to the MCP planner. A host-neutral plan uses operator estimates when it lacks host-specific observations. The executor divides the total dollar cap across all assignments in whole cents. The host enforces its own estimate and its actual charge can exceed it. A missing cost stays unknown. Kimi and Codex launches require `--host-billing` and support a time limit. [Claude CLI options](https://code.claude.com/docs/en/cli-reference)

#### Select tests from measured dependencies

`forge test-select --json` keeps the ordinary full suite when a change has no complete,
current dependency observation. It can select a smaller set even for a schema, template or
file consumed across language boundaries. From every changed path, it walks dependency
edges backwards to all discovered test files. A visited set handles cycles in time
proportional to the nodes and edges. A path which reaches no test, one unresolved input,
or a change to the checkout or runner environment invalidates the reduction.

A trusted test or build pipeline supplies the full test inventory, input graph and identity
of its execution environment. For runtime traces, include all inputs that can alter test
discovery or execution, including configs, test fixtures, conditional loads and child
processes. A passing sample or aggregate line-coverage report alone cannot establish that.
Record unresolved inputs in the observation whenever the producer cannot close the graph.

1. On the checkout where tests will run, set `FORGE_TEST_ENVIRONMENT` to the protected
   pipeline's environment identity. For example, use the immutable image digest plus a
   digest of the relevant run configuration. Ensure it changes when tools, installed
   dependencies, services or inputs outside Git change. Run
   `forge test-select --state --json` before and after collecting dependencies. Publish the
   `checkout` object only when both observations match.
2. Save the producer's JSON outside the repository. The example below shows the field
   names. Replace the empty `checkout` with the state from step 1 and supply the runner's
   actual discovered tests and dependencies.

```json
{
  "schemaVersion": 1,
  "producer": "CI test-discovery and dependency collector",
  "runner": "node:test",
  "checkout": {},
  "complete": true,
  "unresolved": [],
  "tests": ["test/invoice.mjs", "test/search.mjs"],
  "dependencies": [
    ["test/invoice.mjs", "workers/price.py"],
    ["workers/price.py", "schemas/rate.json"],
    ["test/search.mjs", "src/search.ts"]
  ]
}
```

Each pair is a consumer followed by its dependency. The optional `lcov` string accepts
per-test LCOV records with a discovered repository-relative test path in `TN`, a
repository-relative source path in `SF`, `DA` line-hit counts and `end_of_record`.
Positive hits add edges to the producer's graph. Inputs and test entry points must be
tracked, regular files. ForgeKit binds the receipt to Git HEAD, index records, working file
bytes, non-ignored untracked input, OS, architecture, Node version and the declared
environment identity. Merge conflicts, submodules and oversized snapshots use full verification.
The producer is responsible for its test-discovery and completeness claims.

```sh
forge test-select --evidence /protected/test-dependencies.json --changed schemas/rate.json --json
forge test-select --register /protected/test-dependencies.json
forge test-select --base origin/main --head HEAD --json
```

The first command would select `test/invoice.mjs` for the complete example graph. The
second stores the observation privately for the checkout. A ref range includes pending
worktree changes because the runner will see those bytes. Each Linux CI matrix member
rechecks the evidence under its own Node version. With no enrolled observation, CI runs
the full suite. The Windows job runs the full suite.

`forge develop --mode focused|repair|standard` selects the planning workflow. A focused
plan still uses the same verification scope. A recorded failing verification can select the
repair workflow. Task wording alone supplies no evidence about test coverage.

### Run the paired pilot locally

The CLI accepts a frozen task list and two independently measured outcomes per task. It reads local files and writes new worksheets with owner-only permissions. Paid task execution, participant consent and independent verification happen in the operator's environment. The committed tests use synthetic observations. A production measurement still requires consented task records and actual bills.

```sh
forge cost pilot init suite.json
# Fill the task definitions, controls, consent reference and margins before freezing.
forge cost pilot freeze suite.json frozen.json
forge cost pilot template frozen.json runs.json
# Run both configurations against each frozen starting revision and fill both arms.
forge cost pilot compare frozen.json runs.json --json
```

1. **Freeze the design.** Record the ForgeKit revision, selection method, consent reference, held-out status, billing scope and the controls common to both arms. Use 100 or more distinct tasks for an eligibility decision. Each task needs a repository, full commit, task text, observable rubric and one workload stratum (`repeat-heavy`, `mixed` or `cold`). Select allowed quality and completion regressions before running the trial. The template suggests five points on the 0–100 quality scale and five percentage points of completion rate. Its consent fields start empty.
2. **Record every outcome.** Keep the generated arm configuration, starting revision and task/rubric fingerprint. For each arm record `status` (`verified`, `failed`, `abandoned`), the independent rubric's quality score, a distinct evidence locator and `actualUsd`. Include retries, escalations and failed attempts. Document any exclusions for verifier, tooling and cached usage in the frozen billing scope. Supply a billing reference for every observed charge, including a zero charge. Use JSON `null` for missing bills. Set the run ID, ISO billing date and both execution/verification attestations. Choose `source: "simulation"` for a dry run. Evidence locators and consent are operator attestations, suitable for subsequent review.
3. **Read the comparison.** Total spend divided by independently verified completions includes spend on failed and abandoned tasks. The report shows the known subtotal, missing bill count, completion rate and abandonment rate for each arm. Missing bills or a zero verified denominator leave the affected ratio unknown. The 95% cost interval resamples matched task pairs inside each frozen workload stratum, with 2,000 draws seeded from the suite hash. It estimates each arm’s USD per verified task and the paired candidate-minus-baseline difference. A bootstrap draw with a zero denominator leaves the cost interval unavailable.
4. **Interpret eligibility.** Each paired completion or quality difference is decomposed into a bounded gain and a bounded loss. Inverting the Bernoulli KL-Chernoff tail bound on their means and combining four tails yields a conservative 95% interval per endpoint, including when all observed differences are zero. The lower endpoints must clear the frozen noninferiority margins. Eligibility also requires an observed source, complete bills, all three strata, at least 100 tasks and a cost interval entirely below zero. Simulations always receive `simulation-only`. The decision applies to the frozen workload mix and assumes independent task pairs. Teams with related tasks from the same repository or time period should re-evaluate uncertainty at the repository or time-block level before generalizing. The comparator changes no runtime configuration.
<!-- forge:render:consolidated-manuals:end -->
