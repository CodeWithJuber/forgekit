# Implementation review of the two November 2026 plans

The 30-page *Human-Like Coding Agent — Full Plan v2* and the 31-page *Think Before You Code* prompt guide propose a workflow for a developer, an agent and the systems they both use. This review maps every page group to a runnable capability or a remaining measurement. It describes the ForgeKit implementation as of 14 November 2026. The documents’ survey figures, vendor benchmarks and effort estimates are background from the authors. They do not measure this implementation.

## Choose the parts for this project

```sh
forge init --tools kimi,codex
forge hooks on --hosts kimi,codex
forge integrations list
forge integrations select
forge prompts use engineering
forge develop "Investigate duplicate retries and compare existing helpers"
```

In Kimi, run the printed `/plugins install /absolute/path/to/forgekit` command in a trusted workspace, then `/reload`. In local Codex, review the project hook commands in `/hooks`. Restart the host if it was running during setup.

The interactive selector lets a person choose one integration at a time. In CI or a noninteractive terminal, pass the integration ID to `select`. Listing choices performs no download. A selected npm tool goes through package resolution, version compatibility and installation checks. An HTTP selection configures a host connection. Teams using the Quran-framed workflow can run `forge prompts use quran`. Both profiles apply the same verification rules.

| What you want to use | Entry point | Scope or effect |
| --- | --- | --- |
| A reviewed npm MCP tool | `forge integrations select playwright` | Installs and registers the selected compatible release. An explicit `--version` selects an exact release. |
| A public repository reference service | `forge integrations select deepwiki` | Configures the reviewed HTTP endpoint for supported project hosts. |
| A private or self-managed MCP | `forge integrations connect team-git --url https://git.example.org/api/v4/mcp --token-env TEAM_GIT_TOKEN` | The credential name refers to an environment variable. The endpoint binding is local to the developer and working tree. Provide a valid token via the host’s own configuration. |
| A reviewed team npm tool | `forge integrations register descriptor.json`, then `forge integrations select <id>` | Registers package identity, binary, upstream, matching terms, access and cost in the private catalog. Registration and installation are separate operations. |
| Automatic installation when a relevant task arrives | `forge integrations auto on context7 playwright` | Opt-in for named catalog entries. `forge integrations auto off` disables future scheduling. |
| Instructions for a host without suitable lifecycle hooks | `forge prompts show master --profile engineering` | Produces portable plain text. Add it to the host’s instructions. `forge prompts show debugger` produces a narrower brief. |
| A review brief for a host | `forge team "Investigate a GitLab regression and compare SDKs" --handoff kimi` | Returns bounded, source-linked briefs for independent work. Handoff generates no model calls. |
| Actual Kimi or Codex workers | `forge team "Investigate a GitLab regression and compare SDKs" --run kimi --host-billing --max-workers 2 --timeout-seconds 90` | Runs an installed client in temporary workspaces with the supplied excerpts. Use `--run codex` to select Codex. The host account pays for any model calls. |
| A local memory kernel | `forge hikmah on --binary /trusted/bin/hikmah --store /private/ledger.jsonl`, then `forge hikmah recall "retry policy"` | Binds an existing accessible binary and ledger. To disable recall, run `forge hikmah off`. |

A repository owner chooses which hosts receive managed configuration. Individuals choose private bindings, sources and profiles. Set `forge prompts use off` to disable the prompt profile and `forge integrations remove <id>` to remove the managed project integration. The two operations affect different settings. For host-specific trust, reload and authentication details, use the [integration matrix](INTEGRATIONS.md).

## Full Plan v2, pages 1–30

| Pages | Proposed work | Implementation and boundary |
| --- | --- | --- |
| 1–4 | Inventory existing code; address wrong APIs, thin context, duplication and cost | Reuse ForgeKit's atlas, evidence lookup, package vetting, local recall and verifier. Public research returns references and licensed examples where available. Actual improvement over a developer's current workflow needs the paired pilot below. |
| 5–8 | Twelve reasoning rules and a seven-step development cycle | `forge develop` records acceptance criteria, existing symbols, reproduction, reuse choices, security checks, test selection and review. The prompt profile requests a verified session record. An application change is made by the active host. `forge develop "<task>" --verify` runs project verification. |
| 9–10 | Six responsibilities; choose a language, library or framework from evidence | Existing Node code orchestrates research, code navigation, source mirrors, memory and checks. The optional external Hikmah kernel provides recall through its supported CLI. `forge decide compare candidates.json --record` applies evidence-bearing hard gates and a weighted score, and records the decision. Scores and citations come from the comparison author. No language receives an automatic preference. |
| 11–15 | Discover contemporary tools, connect useful ones and avoid duplicate or obsolete components | Built-in choices include Context7 and Playwright packages, plus hosted endpoints for DeepWiki, Exa, GitHub, GitLab and Atlassian. The personal catalog accepts additional reviewed npm packages. The document also proposes Superpowers, Basic Memory, a second graph, Snyk Agent Scan, Semgrep, ccusage and additional document converters. These are external candidates. The optional Docling adapter is described below. Their presence on a list grants no installation or execution authority. |
| 16 | Deliver context when agents skip optional skills or MCP tools | Hook-capable hosts use lifecycle events. Native Claude and Kimi model-request delivery was observed. Cursor and Copilot can defer retrieval to a subsequent suitable tool event. A tool-free turn on those adapters can miss context. Other hosts can use the CLI, MCP or portable instructions. See the client evidence below. |
| 17–18 | Private local snapshots, changed-record synchronization and access reconciliation | A user configures a specific local root, Jira project, Confluence space or GitLab project/resource. Remote sync combines a bounded full import, a timestamp-based update window and a walk of currently visible IDs. Removed or inaccessible items drop out of a completed reconciliation. Failed or partial traversal is surfaced. No company-wide or shared cache is provisioned. |
| 19–20 | Small agent-facing reads, exact aggregation, version-checked mutations and quota handling | `forge sources search`, `get` and `sql` expose scoped evidence. MCP equivalents are `forge_source_search`, `forge_mirror_get` and `forge_mirror_sql`; the wider ForgeKit MCP service also has other tools. SQLite queries allow selected read-only operations on the private `items` and `chunks` tables. The SQL reader caps results at 1,000 rows and 128 KiB. Opt-in Confluence page updates re-read the live version, handle conflicts and refresh the record. Jira transitions and GitLab mutations stay with the selected provider tool and its controls. A tenant's plan limits, authorization, retry policy and scheduling require a deployment check. |
| 21 | Use only the necessary portion of a local document | `get` lists items and their structure, then returns a requested chunk with a locator. Text PDFs use Poppler. Local CSV/TSV, XLS and XLSX use dedicated table readers for exact aggregation. Use `sources aggregate` against the whole selected table for numerical answers. DOCX paragraphs and tables and visible PPTX slides carry locators. Optional offline Docling with prefetched models and Tesseract handles scans or layout extraction. Users can join up to four explicitly selected local tables and use `decimal_sum` for exact grouped sums. OCR and inferred PDF table accuracy on team documents still need validation. |
| 22–23 | Rank context within budget and manage the lifetime of evidence | Task-seeded PageRank ranks code candidates, BM25 retrieves private source excerpts, and a marginal-value-per-token selector discounts similar entries. Required definitions, dependents and tests retain priority. File hashes and source generations avoid repeat conversion. The existing project/team ledger, private source cache and optional Hikmah binding serve different scopes. Cross-repository promotion policy, vector fusion, measured cache-prefix hit rates and precision on the team's own vocabulary remain pilot work. |
| 24–25 | Conditional parallelism with an accountable lead | A simple task stays with one agent. The planner identifies independent read-only specialties for complex tasks, limits fan-out and supplies handoff briefs. Execution and provider billing are explicit. The lead reconciles conflicting results, edits files and verifies the final state. The proposed speed and quality thresholds require paired runs. |
| 26–27 | Measure cost and enforce security during development | The package gate, permission-aware source clients, scan commands, protected paths, syntax checks and signed local verification receipts operate at their respective boundaries. A scoped mirror reduces repeated upstream reads. Claude workers use a budget estimate. Kimi and Codex native runners require explicit host billing and a time limit. Compare actual provider usage, cache behavior and the cost of upgrades in your own environment. |
| 28–30 | Rollout, risks and research sources | Use the held-out tasks described below before recommending a default fleet, a hosted memory service or an additional code graph. Recheck external package releases, provider limits and licenses against the deployment’s versions. Version pins in either PDF are historical inputs to a decision. |

For the ranking constants, comparison worksheet and jscpd setup, see [development gates](DEVELOPMENT-GATES.md). For cloud versus self-hosted service configuration and retrieval limits, see the [source field guide](AGENT-EVIDENCE.md).

## Prompt guide, pages 1–31

| Pages | Requested behavior | Delivered evidence or remaining limit |
| --- | --- | --- |
| 1–6 | Ethical framing, fourteen principles, six faculties and a seven-step workflow | `forge prompts show master --profile quran` associates the source guide's concepts with checkable engineering actions. The plain engineering profile uses the same workflow. Current source files, actual results and reproducible checks establish a technical claim. |
| 7–9 | Master prompt, stop conditions and a completion report | The master prompt covers scope, reuse, reversibility, checking, cost, records and uncertainty. Supported session-start hooks load it after opt-in. The runtime re-reads the selection for ordinary prompt/failure evidence. A host's boot, compaction and tool privileges determine how much guidance it can apply. |
| 10–14 | Fabricated passes, context loss, budget overruns, destructive changes and injection | Five situation cards give concrete checks. `verify` records observed suite outcomes and flags recognizable weakened coverage. A fresh authenticated suspect receipt triggers the existing block-once Stop review. Rehydration, snapshots and budgets depend on the relevant guard, host and action. Universal snapshots, complete compaction survival and a hard cross-provider spend cap remain outside the verified outcomes. |
| 15–18 | Invented dependencies, costly reviews, brownfield impact and credential exposure | Four cards apply existence, impact, review and permission checks. Registry vetting, symbol candidates, package references, ranking, source isolation and redaction support these checks. A source excerpt can identify a lead; the developer checks the actual contract and negative case. Complete operating-system file-access audits require additional instrumentation. |
| 19–22 | Agent evaluation, parallel-worker errors, configuration mismatch and stale evidence | Four cards prompt a baseline comparison, bounded delegation, checked configuration and a clean rerun against the current tree. Verifier events include run identity, state fingerprints and suite results. The Node TAP/spec reporter contributes counts when recognizable. Full effective config attestation with planted violations for every external runner needs per-runner support. |
| 23–25 | Unexplained decisions, convention drift and ungraded learning | Three cards require an owner, provenance, applicable rules and a distinction between raw observations, recurring patterns and proposed guidance. The optional Hikmah path admits selected records with verified provenance, a public privacy label and no outstanding conflict. No feature here authorizes a model to rewrite its own rules from one run. |
| 26–29 | Nine role prompts | Independently printable roles cover planning, research, coding, debugging, review, security, testing, memory and orchestration. Where a specialist is actually dispatched, the matching brief and its expected evidence are included. Printing a role works offline and incurs no model charges. |
| 30–31 | Install across hosts, supply start/finish checks and document limitations | Profiles are private per user and worktree. Hosts with project instructions can use exported plain text. Hooks, MCP registration, model-request delivery and a verified engineering outcome are different measurements. The [prompt guide](DEVELOPMENT-PROMPTS.md) lists all sixteen card IDs with their evidence requirements. |

## Which paths were exercised

| Path | Observation |
| --- | --- |
| Claude Code 2.1.325 | A real client received an ordinary prompt and carried a matching synthetic source excerpt to its first outbound model request. Native failed-tool and malformed-JSON edit events produced follow-up evidence. These runs used a controlled local model endpoint. |
| Kimi Code 2.6.2 | The client loaded the ForgeKit plugin and placed the matching handbook CSV row, path and row locator in its first model request to a local fixture. A separate native Kimi worker received its brief and the model request advertised zero tools. The trusted workspace MCP client also requested the tool list. Asynchronous post-tool events cannot inject context into that same turn. |
| Codex CLI | A local native marketplace install and enablement succeeded. The packaged hook was exercised with its documented event payload. This environment’s sandbox prevented a complete nested model turn. Native prompt delivery and actual worker output on this client await a host-level run. |
| Multiple agents | Claude’s explicit worker runner restricts the worker tools and applies the specified budget estimate. Native Kimi/Codex runners honor supported client flags and review supplied evidence in isolated working directories. `--handoff` emits a brief for the operator's chosen host. Each new client/version needs an acceptance check for actual model delivery, permissions and billing. |
| Hikmah 3.2.0 | The existing CLI read a synthetic verified ledger record and ForgeKit retrieved its marker through the personal per-worktree binding. The local adapter reuses the installed kernel; the upstream repository and kernel implementation are external to this change. A public source label on an eligible record does not grant permission to share the rest of the ledger. |
| Enterprise services and Google/Brave | Authenticated company tenant and search-provider operations were tested using representative fixtures. A real tenant check still requires the team's chosen identity, instance URL and network path. These tests did not access production data. |

For one configured local source, replace `handbook` and the example filenames with your own. The first command lists item IDs. The second shows the chosen item’s locators and chunk numbers. The last query operates on the named complete tables.

```sh
forge sources get handbook
forge sources get handbook policies.pdf
forge sources get handbook policies.pdf --chunk 0
forge sources sql handbook 'SELECT kind, COUNT(*) FROM items GROUP BY kind'
forge sources sql handbook 'SELECT c.name, decimal_sum(s.amount) FROM customers c JOIN sales s ON c.id = s.id GROUP BY c.name' --tables '[{"name":"customers","path":"customers.csv"},{"name":"sales","path":"sales.xlsx","sheet":"Sales"}]'
```

## A measurable pilot

1. Pick two team repositories. Freeze twenty representative tasks, their starting revisions, allowed source snapshots and observable acceptance tests. Include a contract change across repos, a revoked ticket, a repeated bug, an unfamiliar SDK, an Arabic spreadsheet header, a scanned PDF, and one change that weakens a test.
2. Run the same tasks with the current agent configuration, then with private retrieval and the relevant hooks enabled. Keep model version, account permissions, budgets and starting revisions fixed. Measure time to an independently passing result, total cost, cited locations recovered, duplicate functions introduced and any unauthorized source returned. Keep per-task comparisons alongside averages.
3. Validate one self-hosted system and one cloud system with a test identity. Exercise pagination, 429 responses, expired credentials, restricted records, refetch after an access change and a deliberate Confluence version conflict. Compare spreadsheet totals against the owner's calculation. Include a scan and a complex PDF table to decide whether OCR or Docling is worth its operational cost.
4. Enable a second read-only worker, a new graph or an alternative memory integration one at a time against the same frozen tasks. Use the PDF’s proposed bar of 20% faster or ten quality points better as a pilot decision threshold. Record slower or worse outcomes as well. Choose a wider rollout only after checking correctness, permissions and maintenance costs on these tasks.

The local evaluator freezes the task definitions and two configurations under a SHA-256 digest and emits a measurement worksheet. Fill the first file before freezing it, then fill both arms of each row in the worksheet with observed results and distinct log references before comparing.

```sh
forge team evaluate init suite.json
forge team evaluate freeze suite.json frozen.json
forge team evaluate template frozen.json runs.json
forge team evaluate compare frozen.json runs.json
```

Choose `parallel`, `routing` or `context` when defining the suite. The comparison reports time, quality, provider cost, tokens, tool calls, introduced duplicates, wrong packages and lost acceptances. Parallel trials use the speed or quality threshold above. Routing trials require lower cost with quality held. Context trials require fewer tokens with quality held. The evaluator labels simulated results separately and leaves production configuration under team control.
