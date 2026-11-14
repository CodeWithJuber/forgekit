# Research and context for coding agents

**Field guide and implementation plan • 14 November 2026**

A developer investigating a failed retry wants to find the existing retry implementation, the current ticket, the design decision behind it and a test that reproduces the failure. An incident number, client name or stack trace can identify a private system. Start the search locally. Use a public query such as `HTTP Retry-After jitter Node fetch` when upstream behavior is the missing piece.

## Getting the agent to act

MCP makes tools available for the model to select. Registering a tool or adding a skill alone cannot establish that a particular turn invoked it. A supported lifecycle hook runs code when the host delivers an event. Inspect the host's configured hooks, enable project trust where required and start a fresh session after changing configuration. [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) · [ForgeKit host support and verification matrix](INTEGRATIONS.md)

### Set up a workspace

From the repository whose tasks you want to investigate, run the ForgeKit checkout or package build containing the evidence commands.

```sh
forge hooks on
forge hooks status
forge sources init
forge sources status
forge atlas build
```

Open the private config file whose absolute path is printed by the sources commands. The optional atlas build indexes declarations in the current repository. Rerun it after substantive code changes. Add only source roots and projects you want available for this repository. The following example includes a second repository, a document folder, cloud Jira, Data Center Confluence and a self-managed GitLab project. Replace the example paths and tenant names. Supply the referenced environment variables to the process that performs the sync or search.

```json
{
  "sources": [
    {"id":"contracts","provider":"local","root":"/work/contracts"},
    {"id":"manuals","provider":"local","root":"/work/manuals"},
    {"id":"tickets","provider":"jira","deployment":"cloud","baseUrl":"https://example.atlassian.net","project":"ENG","emailEnv":"JIRA_EMAIL","tokenEnv":"JIRA_TOKEN","ttlSeconds":900},
    {"id":"design","provider":"confluence","deployment":"self-hosted","baseUrl":"https://wiki.example.org/confluence","space":"ENG","tokenEnv":"WIKI_PAT"},
    {"id":"reviews","provider":"gitlab","deployment":"self-hosted","baseUrl":"https://git.example.org","project":"platform/contracts","resource":"merge_requests","tokenEnv":"GITLAB_PAT"}
  ]
}
```

```sh
forge sources sync manuals
forge sources sync
forge sources search "retry limit" --source manuals --budget 700
forge sources route tickets read --fresh --mcp
forge sources read tickets ENG-123
forge sources route reviews bulk
forge sources aggregate manuals usage.csv sum --column minutes --group-by team
forge evidence "Investigate retries in our HTTP client" --json
forge evidence "Choose a retry helper" --web "Node.js fetch Retry-After idempotent requests"
```

The relative path in the aggregation example starts at the configured `manuals` root. `forge sources sync` refreshes all configured sources. For a single provider, pass its source ID. `--mcp` tells the route command that your client has a connected server for the source. The command reports the route. For an individual REST read, use `forge sources read <source-id> <record-id>` or the provider-neutral `forge_source_read` MCP tool with that source. Supply a Jira issue key/ID, a numeric Confluence page ID, or the project-local GitLab issue/MR IID. For example, `!42` in a GitLab project corresponds to IID `42`. Longer live bodies support `--offset` and `--limit` in UTF-16 code units. Pass the returned `nextOffset` to request the next page. The default limit is 8,000 and the maximum is 16,000. The optional version-checked Confluence update is described below. Other live mutations use an authenticated provider client.

For a configured HTTP MCP endpoint, add an `mcp` object to the relevant source in the private config. For example, an authenticated Jira Cloud source can use `{"url":"https://mcp.atlassian.com/v2/mcp","tokenEnv":"ATLASSIAN_MCP_ACCESS_TOKEN"}`. Run `forge sources probe tickets` to inspect the tools it actually advertises. Set `mcp.tool` to that endpoint's exact record-read tool name, then run `forge sources route tickets read --fresh --probe`. The probe initializes MCP and lists available tools. The host performs the subsequent provider MCP call. Use an issued access token for the endpoint. OAuth setup/refresh and scoped REST credentials are separate. [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Set `FORGE_WEB_SEARCH_PROVIDER=serper` and `SERPER_API_KEY` for optional Google results through Serper, or `FORGE_WEB_SEARCH_PROVIDER=brave` and `BRAVE_SEARCH_API_KEY` for Brave. Provider quotas or charges may apply. Without configured credentials, GitHub, Stack Overflow and npm provide public discovery. Where available, the code lookup returns a short attributed excerpt, the original license and a pinned GitHub file or accepted-answer link.

The automatic path uses bounded source excerpts and the supported host event. For selected research intents, the public search path uses predefined technical terms and caches successful results for six hours, with a one-minute cache on partial or failed requests. The hook allows up to 1.25 seconds for discovery and, when candidates exist, another 1.1 seconds for a cited example. For longer lookups the explicit CLI gives each stage more time. Explicit `--web` sends the separately supplied string to GitHub's repository search, Stack Overflow via the Stack Exchange API and the npm registry. Supply public terms only. Set `FORGE_EVIDENCE_WEB=0` in the agent process to disable automatic public lookups. When code examples are needed, ForgeKit can fetch GitHub README examples pinned to a commit with license evidence, or attributed Stack Overflow accepted answers with a license. Excerpts are limited to eight lines and 640 characters. Inspect the original and run a version-matched test before adapting a snippet. [GitHub contents API](https://docs.github.com/en/rest/repos/contents) · [Stack Exchange answers API](https://api.stackexchange.com/docs/answers-by-ids)

For a host that can call ForgeKit's MCP server, the available tool names map directly to the operations above.

| MCP tool | Arguments for an example request |
| --- | --- |
| `forge_develop` | `{"task":"Fix duplicate retries in the payment client"}` |
| `forge_team_plan` | `{"task":"Diagnose a payment timeout across repositories and identify regression tests","maxWorkers":2}` |
| `forge_tool_install` | `{"id":"playwright"}` installs a reviewed release. An optional `version` selects an exact release. |
| `forge_tool_find` | `{"task":"Browser regression tests for a web application"}` |
| `forge_evidence` | `{"task":"Investigate retries before changing the HTTP client"}` |
| `forge_source_search` | `{"sourceId":"manuals","query":"retry limit","budget":700}` |
| `forge_source_read` | `{"sourceId":"tickets","recordId":"ENG-123"}` |
| `forge_source_route` | `{"sourceId":"tickets","operation":"read","fresh":true,"mcpAvailable":true}` |
| `forge_table_aggregate` | `{"sourceId":"manuals","path":"usage.csv","operation":"sum","column":"minutes","groupBy":"team"}` |

In a project that opts into supervised mode, the MCP server advertises only `forge_harness_run` and `forge_harness_status`. The run retrieves scoped workspace evidence inside its executor. Source administration and explicit public research remain available through the CLI. [Supervised setup and client evidence](INTEGRATIONS.md#supervise-a-coding-run)

### Troubleshoot a silent plugin

For the native Codex CLI plugin installation from a reviewed checkout, run the following in the client environment, then start a fresh trusted session. The marketplace and plugin names correspond to this repository's manifests.

```sh
codex plugin marketplace add /absolute/path/to/forgekit
codex plugin add forgekit@forge
codex plugin list --marketplace forge --json
```

| What you observe | What it tests | Next check |
| --- | --- | --- |
| ForgeKit appears in the MCP tool list | The transport and tool discovery work. | Run a normal feature/debug prompt without mentioning ForgeKit. Look for an actual hook execution and evidence in that host's hook log or transcript. |
| CLI evidence returns relevant snippets, agent turn has none | Local retrieval works for that user and working directory. | Check hook configuration in that repo and the shell/PATH/environment used by the host. For Codex project hooks, review the project and hooks in `/hooks`. |
| The host offers no context field at prompt submission | The available event controls the earliest delivery. | On Cursor/Copilot, inspect the subsequent supported tool event. A session that ends before that event can miss the packet. Hosts without suitable local hooks can invoke the CLI or MCP tool explicitly. |
| A hosted agent works in its own checkout | The local machine and the hosted environment have different files and credentials. | Run the setup and test in the environment that executes the code. A developer laptop's private mirrors do not travel with the repo. |

**Validation in this change.** In Claude Code 2.1.325, a plain coding prompt caused a synced CSV row and its locator to appear in the first outgoing model request, without the model requesting a tool. This was observed with both project hooks and the plugin installation path, using synthetic data and a loopback Messages endpoint. In a separate run, a failing native Read tool triggered a new evidence excerpt for the subsequent request. The new excerpt was absent from the earlier request.

Codex CLI 0.167.0-alpha.4 completed the local marketplace install and enabled the plugin.
A separate project-hook test ran Codex CLI 0.169.0 in its read-only sandbox on GitHub-hosted
Ubuntu. The first request to a loopback Responses endpoint included the unique CSV value,
filename and row range retrieved from outside the project. See the [native Codex acceptance run](https://github.com/CodeWithJuber/forgekit/actions/runs/43584740300/job/132416709361).

## From a task to a reviewed change

```sh
forge develop "Fix duplicate retries in the payment client" --json
forge develop "Compare streaming parsers" --web "Node.js streaming CSV parse benchmark"
forge develop "Fix duplicate retries in the payment client" --verify --json
```

The plan records an objective, acceptance questions, reuse references, minimal implementation work, security checks derived from the task and changed paths, relevant tests, an independent diff review and a repair loop. For a routine spelling change it reduces to locating the text, editing and checking the result. For a failed payment retry it starts with a reproduction. Money-related paths trigger replay, idempotency and partial-failure checks. Evidence links let the developer reopen the actual source before adapting it. The reviewer should include untracked source files when examining the patch. A successful edit event can also trigger a bounded review for possible credential exposure, merge-conflict markers, JSON syntax and Node syntax on eligible .mjs/.cjs files. It can suggest tests. Test execution is a separate step. In a native Claude fixture, the second model request received an invalid JSON finding after the first edit.

In plan mode every stage is proposed. `--verify` runs the existing repository verifier against the current worktree. Check its reported verdict, executed and skipped suites, and actual failures. A passing targeted check alone does not complete an independent review. The automatic hook uses a compact plan and defers Git diff inspection. In a plan requested directly by CLI, changed files are gathered from staged, unstaged and untracked paths.

## Choosing evidence during a change

| Situation | First action | Evidence to keep |
| --- | --- | --- |
| Mechanical rename or typo | Find its references and run a focused check. | Affected paths, test or diff. |
| Feature or repeated problem | Query the local reuse cache, then inspect relevant symbols, callers, tests and past decisions. | Artifact or file location, proof of the previous result, differences for this task. |
| Unknown SDK behavior | Read the installed version in the lockfile. Match the first-party docs and changelog to that version. | Versioned API signature, link, minimal reproduction. |
| Complex failure | Reproduce the error with synthetic inputs. Compare plausible causes against local logs and tests. Search a generic public error signature when necessary. | Failing case, counterevidence, fix and passing rerun. |
| Build or adopt | Compare the standard library, installed dependencies, maintained external packages and a small custom implementation. | Compatibility, license, release and advisory evidence, dependencies, upgrade work, expected running cost. |
| Community code or skills | Identify upstream owner, revision and license. Inspect code and run a small example before reuse. | Permalink to the example, license and attribution, exact package or commit, local verification. |

An evidence note for a non-trivial change should fit in a few lines. Record the question, winning file or upstream reference, owner or version, one rejected option with its reason, and the command plus result that verified the change. Cite a ticket key, page number, sheet/row or source line so the next engineer can reopen the evidence. A failed lookup is a reason to inspect the remaining unknowns.

Inspect the acceptance test before paying to expand a search. A library can be popular and still fail on the runtime, proxy, payload size or license required by the project. For example, a helper that retries an idempotent GET may duplicate a payment when reused for POST. Compare actual behavior and record the condition under which reuse is safe. Check package identity with `forge vet npm:<name>`, skills with `forge scan`, and the reason for adoption with `forge decide`. [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) · [Open Source Insights API](https://docs.deps.dev/api/v3/) · [OSV](https://osv.dev/)

## When to use multiple agents

The lead can handle a focused task end to end. A task spanning independent questions can benefit from read-only specialists. For example, while investigating a cross-repo retry failure, one specialist can trace the failure path, another can check the ticket's contract, and the lead can compare their evidence before editing. A task suggesting only one useful specialty stays with its lead.

```sh
forge team "Diagnose the Jira payment timeout and identify regression tests" --json
forge team "Diagnose the Jira payment timeout and identify regression tests" --run claude --budget-usd 0.20 --max-workers 2 --json
```

The first command builds a plan locally. Each assignment states its deliverable, candidate references and dependencies. The lead is the sole editor, and depends on the independent reports. The default concurrency ceiling is the existing orchestration pack's two workers. Adjust it using `forge orchestration set parallelCap 3`. `--max-workers` can lower the effective cap. Use the host's read-only role, such as Claude's Explore or Codex's explorer, when the active host exposes it. A generated plan is visible independently of whether that host accepts a delegation. [ForgeKit orchestration](ORCHESTRATION.md) · [Claude subagents](https://code.claude.com/docs/en/sub-agents) · [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

The second command explicitly launches read-only Claude Code processes on PATH for the current worktree and sends each role's task and references to its configured model provider. Use it only with data that provider can process. Each worker uses the provider's Haiku model alias, bare and restricted modes, read-only built-in tools, strict MCP configuration and no session persistence. Bare mode supports the API/provider credentials documented by Claude. The executor verifies required host options before launch, splits the total dollar estimate across workers and reports each outcome separately. Claude's budget check uses a client estimate and can overshoot. The hook and MCP planner do not launch these processes or incur model-worker fees. In a real CLI fixture, both worker processes completed against a loopback Messages endpoint. Only the Read tool was advertised in the two captured model requests. [Claude CLI options](https://code.claude.com/docs/en/cli-reference)

## Jira, Confluence and GitLab

| Source | One live question or action through the host | Repeated search or bulk work |
| --- | --- | --- |
| Jira Cloud | Connected Atlassian MCP with the user's site permissions. | Mirror the configured project via Jira Cloud enhanced JQL search. [Atlassian MCP setup](https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/) · [Jira Cloud REST](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) |
| Jira Data Center | Locally hosted `mcp-atlassian` when compatible with the instance, or the instance REST API. | Search the configured project with Data Center REST v2 and the user's PAT. [Community server](https://github.com/sooperset/mcp-atlassian) · [Jira Data Center REST](https://developer.atlassian.com/server/jira/platform/rest/v10006/api-group-search/) |
| Confluence Cloud | Connected Atlassian MCP for a current page and live updates. | Mirror current page bodies from the configured space with its site REST API. Include the site's Confluence context path, usually `/wiki`. [Confluence Cloud content](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content/) |
| Confluence Data Center | A compatible `mcp-atlassian` or instance REST API. | Configure the actual context path and space. [Confluence Data Center REST](https://developer.atlassian.com/server/confluence/rest/v932/api-group-content-resource/) |
| GitLab.com, Self-Managed or Dedicated | Use the enabled GitLab MCP at `<instance>/api/v4/mcp` for an issue, MR or action its toolset supports. Use live REST or the existing authenticated CLI when MCP is unavailable. | Scope REST v4 to one project and choose issues or merge requests. GitLab's MCP is GA from 19.5. Enablement and available toolsets depend on group/instance settings and licensed features. [GitLab MCP](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) · [Issues](https://docs.gitlab.com/api/issues/) · [Merge requests](https://docs.gitlab.com/api/merge_requests/) |

A local result establishes what was visible at the last successful sync. For questions about current status or permissions, reopen the item's link with the same identity. For a change, read the current object and act on the live provider using its supported tools and authorization. A source-route recommendation is distinct from executing or authenticating that live operation. Keep file mirrors on the developer's machine. Keep vendor credentials in the environment named by the local configuration.

Remote sync credentials depend on the provider. The Cloud Atlassian REST adapter uses a site-compatible API token plus email, its Data Center adapter uses a bearer PAT, and the GitLab adapter sends the configured token as `PRIVATE-TOKEN`. Site-specific OAuth, SSO or scoped-token gateways can use a compatible host MCP client or need an additional REST adapter.

Source configuration and snapshots are scoped to the current workspace and OS user. A changed remote credential, site, provider or project/space selects a different identity or source scope. Source search excludes remote snapshots past their configured `ttlSeconds` (default 900). Refresh after permission changes and for a question about current state. An entry could have changed immediately after it was fetched, even within the TTL. Every completed remote refresh checks which record IDs the identity can currently see and drops missing records from the active generation. While refresh is running, readers temporarily treat that source as unavailable. The most recently started refresh owns publication. An older overlapping refresh cannot restore superseded rows. A failed sync invalidates the affected remote snapshot. Check source status for the failure and retry after credentials, connectivity or rate limits recover. A token rotation requires a fresh sync.

Each workspace supports up to 12 configured sources. A snapshot is capped at 1,200 chunks and the search index at 12 MiB per source. Search processes at most 20 distinct query terms and emits at most 12 hits. The default search budget is 600 estimated tokens, using 3.6 characters per token. Local extraction can return a partial result with warnings for truncated or unsupported files. Check these fields before treating a negative result as exhaustive.

This version covers Jira issue summaries, descriptions and status, Confluence page titles and bodies, and GitLab project issues or MRs. Configure a second GitLab source to mirror both resource types. Attachments, discussions, comments, commit diffs and provider audit logs require their own live tools or future adapters. The first sync or an explicit `--full` fetches the entire scoped collection. Later syncs read changed bodies with a 15-minute overlap on Jira and GitLab. Confluence's server-local CQL date boundary rounds its hour overlap outward to a whole day. A second paginated traversal checks currently visible IDs each time. A newly accessible back-dated item or a conflicting update triggers full backfill. Some GitLab endpoints return complete rows during that traversal. A 429 ends the attempt. The private source records the retry deadline and suppresses repeat calls for that credential scope until it passes.

### Browse and query a private mirror

```sh
forge sources get manuals --limit 10
forge sources get manuals usage.csv
forge sources get manuals usage.csv --chunk 0
forge sources sql reviews 'SELECT status, count(*) FROM items GROUP BY status'
forge sources sync reviews --full
```

`forge_source_search` returns ranked snippets, an item ID and a zero-based chunk number on newly synced snapshots. `forge_mirror_get` returns a paged list of items, then a manifest with locators when given an item ID, then the selected excerpt when given a chunk. Local manifests include byte size and SHA-256, sheet headers and indexed data-row counts or the number of extracted PDF pages when the corresponding reader recorded them. Check the partial flag and per-item completeness before drawing conclusions.

`forge_mirror_sql` runs one read-only SQLite SELECT for the selected source. The `items` table exposes `id, path, title, kind, status, updated_at, fetched_at, source, chunk_count`. The `chunks` table has `item_id, ordinal, locator, text`. The response includes column names, row arrays, the snapshot's observation time and truncation. The query is bounded to 1,000 rows, 128 KiB and a CPU/time budget. It requires Python 3 with sqlite3. Remote queries reuse a private per-generation read-only database. Local queries recheck the working tree and materialize only readable rows in memory. Use `forge sources aggregate` for exact numeric operations over the underlying spreadsheet cells. A 500-record synthetic GitLab fixture yielded 100 closed and 400 open items. The first grouped query took 97 ms including materialization, followed by seven queries at 36–46 ms. Each query reused the local snapshot. [SQLite authorizer](https://www.sqlite.org/c3ref/set_authorizer.html)

For joins across current local files, pass one to four named tables. Each descriptor selects an allow-listed relative CSV, TSV, XLS or XLSX path and an optional visible sheet. ForgeKit parses the complete selected input within configured byte and row limits, omits credential columns, rechecks permission and file identity, and returns each input hash. Files are opened by ForgeKit before running the SQL. SQLite runs in memory with external file access and extensions unavailable. Headers form the column names. Cells retain their string representation for joins such as SKU `001`. Use `decimal_sum` for exact decimal totals and `decimal_avg` for averages rounded to 34 significant digits.

```sh
forge sources sql manuals 'SELECT c.region, decimal_sum(i.amount) FROM invoices i JOIN customers c ON c.id=i.customer_id GROUP BY c.region' --tables '[{"name":"invoices","path":"invoices.xlsx","sheet":"Orders"},{"name":"customers","path":"customers.csv"}]'
```

For an editable Confluence source, set `"allowWrites":true` in the private source config and use a credential with page-edit access. Read the cached page manifest for its version. Prepare the complete desired page body in Confluence storage format. The following example targets one existing page.

```sh
forge sources get design 12345
forge sources update-page design 12345 --version 7 --title "Retry policy" --body-file retry-policy.xhtml
```

ForgeKit re-reads that page in the configured space, compares its version and updated time, and sends the incremented version in the provider's update. A conflicting edit aborts and refreshes the local item. The write path re-reads the current version before reporting success and never automatically resends an uncertain PUT. The result distinguishes a conflict, an unconfirmed request and an applied update awaiting verification. Use the vendor's supported live path for Jira and GitLab mutations. [Confluence Cloud](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/) · [Confluence Data Center](https://developer.atlassian.com/server/confluence/rest/v1001/api-group-content-resource/)

## Local documents and tabular data

Local discovery requires Git on PATH for ignore semantics. Use a narrow root when selecting a large repository. Code and text files contribute snippets with line references. An ignored dependency tree, a symlink or a hidden credentials directory should never be treated as project documentation.

| Input | What to retrieve | How to check the answer |
| --- | --- | --- |
| Text PDF | Page-numbered text from Poppler's `pdftotext`. | Open the cited page. Complex tables may require visual inspection. A scan with no text needs OCR before text search. |
| CSV / TSV | Rows and headers through Python's CSV reader. Quoted delimiters and multiline fields must remain in their records. | Count or aggregate the configured input and cite the file and column. |
| XLSX | Rows by sheet through Python's `openpyxl`. | Select the sheet explicitly when workbook headings repeat. |
| XLS | Rows by sheet through Python's `xlrd`. | Use a binary Excel fixture to test this path. Changing the file extension cannot convert the format. |

In this implementation, `count`, `sum`, `min`, `max` and `avg` scan the bounded local input. Use `--sheet` with a workbook and `--group-by` for grouped results. Only visible sheets are eligible. Ungrouped count without a column counts nonempty data rows. A column count or numeric operation skips blank values in that column. Numeric operations use exact rational arithmetic on supported decimal values and round averages to 34 significant digits. Formula-valued XLSX cells require a sheet of exported numeric values before aggregation. Supply a unique first-row header for each selected column. The table reader caps each input at 8 MiB per source file, 100,000 data rows, 256 columns and 1,000 groups for aggregation. These operations avoid running arbitrary model-generated SQL. OCR and rich layout extraction are extension candidates.

On resync a completed local extraction with the same byte hash and parser version can be reused. CSV/TSV accept UTF-8 or BOM-marked UTF-16.

A matching excerpt answers “where is the retry limit documented?” Summing amounts over matching excerpts gives a potentially incomplete total. Use a full-file numeric operation for “total by region,” with the sheet, grouping field and amount column specified. Preserve leading zeros in identifiers. A scanned page with no text, an unavailable parser and a genuine search miss need distinct handling. DuckDB's Excel extension supports XLSX. Its separate XLS limitation matters for older workbooks. [DuckDB Excel](https://duckdb.org/docs/stable/core_extensions/excel) · [openpyxl](https://openpyxl.readthedocs.io/) · [xlrd](https://xlrd.readthedocs.io/)

## Scope, retrieval and cost

| Decision | Implementation or proposed rule |
| --- | --- |
| Personal memory | ForgeKit's personal recall uses its user state directory. Store a preference or an evidence pointer here. A project mirror can include confidential facts and stays outside the shared ledger. |
| Repo and team memory | The repository ledger content-addresses claims and deduplicates evidence. Separate clones merge claims, evidence and tombstones by set union. `forge ledger blame <id>` exposes provenance and `forge ledger verify` checks the ledger. Team sharing follows repository access. |
| Cross-repo retrieval | Explicitly include the repositories or approved document roots for the task. A dependency consumer's ticket can explain an API contract in a producer repo. Label the originating repo and revision so a stale consumer cannot silently override the current producer. Automatic organization-wide scope inference and promotion are research items. |
| Trust in long-lived claims | The current ledger computes a smoothed confidence `(1 + weighted confirmations) / (2 + weighted observations)`. Each unique evidence event decays by age and oracle strength. Unresolved evidence has reduced weight and a confidence cap. Repeated retrieval cannot promote a claim. |
| Code graph and token budget | ForgeKit's `rank` computes weighted PageRank over code dependencies. Its context assembler selects required definitions, dependents, tests and applicable lessons, then allocates estimated tokens to optional candidates by marginal value per token. Read full definitions when graph resolution fails. Its character-based estimate is approximate. |
| Reuse of existing code | Alongside the team reuse cache, the local evidence pass checks names from the existing code atlas. It splits camelCase, snake_case and acronym names, ranks lexical overlap, and favors a task's exact identifier. It returns up to three file/line pointers after checking the current file hash and indexed line. Oversized or missing indexes require a manual source search. This test measures names, so semantically identical implementations with different vocabulary can escape detection. |
| Source search | The local mirror ranks bounded chunks using BM25 (k₁ = 1.2 and b = 0.75) across identifiers, paths/titles and content. Exact ticket keys and error codes are strong search terms. Inspect the cited chunk, source and timestamp. A paraphrase with no overlapping terms may miss. |
| Combining retrieval methods | For a future lexical plus semantic retriever, fuse ranked lists with `RRF(d) = Σᵢ 1/(k + rankᵢ(d))`, counting only lists containing the item. Tune on held-out tasks with exact identifiers and paraphrases. Fuse only after filtering eligible sources. [Original RRF paper](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf) |
| Freshness | As an optional later estimator, if changes arrive at rate λ and cached age is t, a Poisson model estimates `P(changed) = 1 − exp(−λt)`. Compare with observed changes and a fixed TTL baseline. Permission revocation and actions needing current status require live checks. |
| Prompt caching | For eligible stable prefix tokens, let w and r be write/read cost multiples relative to ordinary input. With hit probability p, expected relative cost is `(1−p)w + pr`. Caching pays when `p > (w−1)/(w−r)` for w > r. Use the provider's observed billing, TTL and cache eligibility. This estimate excludes output tokens, tool runs and retrieval latency. [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |

Use the repo's Node 20+ CLI and hook emitters for distribution. Use existing parsing libraries and system tools for file conversion. A native Rust index is a candidate if profiling shows repeated parse or search time dominates on the team's corpus. A Go binary or maintained SDK is a candidate if it already handles the provider protocol and fits deployment constraints. Before adding a runtime, record the speedup on representative data, packaging cost on supported platforms, security update owner and rollback path.

For a concrete stack choice, first discard candidates that fail the project's supported runtime, license requirements, data boundary or acceptance test. For the remaining candidates let each measured criterion be normalized to [0,1] in the favorable direction. Rank using `S = Σⱼ wⱼ xⱼ`, with weights summing to one and agreed before comparing candidates. One illustrative split is 0.40 compatibility and correctness, 0.25 maintenance, 0.20 total cost and 0.15 integration effort. Record missing evidence and rerun the comparison with alternative weights. An unknown license or unresolved compatibility requirement cannot be offset by popularity. This worksheet helps the team compare costs and fit. For package identity and risk, use `forge vet`.

### Extensions to benchmark separately

* **Cross-repo graph.** Add an edge only for a resolved dependency, schema or API contract, recording producer, consumer and revision. For a task seed distribution v, test personalized PageRank `r = (1−d)v + dMr` against lexical retrieval and the current graph. Route dangling mass back to v. Rank only authorized repos and keep the evidence path for every cross-repo hit.
* **Duplicate implementations.** Normalize AST token shingles and generate approximate candidates with MinHash and locality-sensitive hashing. For b bands of r hashes, a pair with Jaccard similarity s has candidate probability `1−(1−sʳ)ᵇ` under independent hashing. Verify candidates by actual structure, public contract and tests. Distinct functions with similar boilerplate should remain easy to dismiss.
* **Context budget.** Compare current value-density assembly with greedy marginal selection `[relevance(i) − μ·max similarity(i, selected)] / estimatedTokens(i)`. Reserve space for required definitions and verification evidence. Deduplicate citations before applying the budget. Evaluate code and Arabic/English documents separately because character-to-token ratios differ.
* **Sharing and promotion.** A proposed cross-project claim names scope, version, source, evidence and expiry. Two independent successful reuse events suggest a candidate for review. An owner selects the intended audience and checks the proposed claim's contents. Share the minimal verified lesson through the team's authorized repository. Evaluate the outcome of consuming it on a new repo against memory disabled.
* **Scale and maintenance.** Track delta and ID-reconciliation request sizes on the actual tenant, including 429s and newly granted access. The observation watermark publishes with its successful generation. Compare per-file content hashes with a directory hash tree on real corpora. Introduce a search DB, sidecar or hosted service only if it delivers an observed gain for the team.

## Existing community options

| Missing capability | Candidate and constraints |
| --- | --- |
| Versioned package documentation | Context7 can retrieve context for a named library. Resolve the library and installed version, then check the cited first-party page. [Context7](https://github.com/upstash/context7) |
| Real usage in public code | Search examples by language and file path with Vercel's Grep MCP. DeepWiki answers questions about particular public repositories. Inspect the original line and license before copying. [Grep MCP](https://vercel.com/blog/grep-a-million-github-repositories-via-mcp) · [DeepWiki MCP](https://docs.devin.ai/work-with-devin/deepwiki-mcp) |
| Semantic symbol lookup or a debugger workflow | Evaluate Serena for supported language servers and Superpowers for systematic debugging or test-driven development. Avoid enabling duplicate workflows already covered by ForgeKit. [Serena](https://github.com/oraios/serena) · [Superpowers](https://github.com/obra/superpowers) |
| Large or complex document collections | Evaluate SQLite FTS5 for indexed BM25, Docling for layout-aware extraction or OCR, and MarkItDown for additional formats. Compare them against local fixtures, including Arabic text, scans and merged spreadsheet cells. [SQLite FTS5](https://www.sqlite.org/fts5.html) · [Docling](https://github.com/docling-project/docling) · [MarkItDown](https://github.com/microsoft/markitdown) |

### Installing a reviewed integration

```sh
forge integrations list
forge integrations find "browser testing with Playwright"
forge integrations install playwright
forge integrations auto on context7 playwright
forge integrations auto status
forge integrations auto off
```

`find` looks for compatible candidates in the reviewed catalog. `install` resolves a catalog ID and records a pinned version. `forge integrations install <id> --version <x.y.z>` selects an exact stable version when the latest release needs a newer runtime. The evidence hook resolves matching catalog entries using package names, with a bounded lookup. An explicit `auto on` enables background installation of only the named entries in that workspace's private allowlist. A matching future prompt can queue eligible entries. `auto status` reports the policy and job state. `auto off` turns off future scheduling. A worker that already started can finish. The automatic installer receives a catalog ID and checks the selected upstream package. General discovery links and code excerpts do not authorize installation of arbitrary packages.

The wider community entries above are candidates to evaluate or connect separately. `forge integrations list` lists the integration presets shipped by the installed ForgeKit version. Pin candidate packages or images to reviewed revisions and record what data leaves the machine.

### Verified examples on 14 November 2026

An isolated installation fetched `@playwright/mcp@0.0.85`, pinned the release, started it through the generated tool configuration and received 25 tools from its real MCP server. No browser session was required for tool discovery. The Context7 registry returned `@upstash/context7-mcp@4.7.0` with a Node.js requirement of at least 20.18.1. A machine on Node 20.17.0 needs an independently verified compatible version or a supported runtime before installing this release. Check the registry again when choosing a tool. [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [Context7](https://github.com/upstash/context7)

## Evaluation and next work

In the 2026 Stack Overflow survey, 69.3% of 13,648 respondents to the question on costly AI mistakes selected plausible but incorrect code, 49.3% selected missing context and 38.7% selected stale or incorrect internal knowledge. In VibeMemBench, 11 of 12 tested memory-system/solver pairs failed to outperform their corresponding memory-off baseline. These observations support testing whether a particular retrieval change improves executable results. [Stack Overflow 2026](https://survey.stackoverflow.co/2026/technology/data) · [VibeMemBench](https://arxiv.org/abs/2609.23570)

Start with 20 representative tasks across at least two repos. Include a mechanical change, dependency upgrade, unfamiliar SDK, stale ticket, revoked access, cross-repo contract, ambiguous term, malicious instruction in a source, PDF page lookup and a full-sheet aggregation. Freeze snapshots, gold references and executable acceptance tests before tuning. Compare the same tasks with hooks off, local evidence on and, for public questions, external research on. Keep the model, tool permissions, token limit and host version fixed. Inspect paired wins and losses along with sample size and spread.

| Measure | How to score it | Decision |
| --- | --- | --- |
| Activation | Count eligible prompt events, hook executions, delivered evidence and observed downstream tool calls separately on each target host. | A plugin registration or synthetic adapter test establishes only that stage. Reproduce on the target client before claiming end-to-end activation. |
| Correctness and reuse | Run target tests, verify cited files/pages and inspect new functions for overlap with existing code. Score citation precision and top-k retrieval recall against annotated relevant items. | Reject a change that discloses another identity's cache or changes a verified numeric answer. Review every new failure against baseline. |
| Cost and maintenance | Track paid model input, cached input, output, upstream calls, tokens per resolved task, p50/p95 latency and local storage. Report cold and warm runs. | Keep a more expensive path only if it improves a specified outcome enough to justify the cost. |
| Mirror correctness | Replay pagination, retries, token changes, deleted/restricted items, clock boundaries and expired credentials. Validate cached and live labels offline. | Failed traversal must not publish a partial success. Reconciliation must remove items missing from a complete source view. |
| Candidate extensions | Test an AST clone detector (for example jscpd), reference-linked cross-repo memory promotion, local embeddings with RRF, and OCR on their own fixture slices. | Ship each candidate only when paired tests show benefit after CPU time, maintenance, false positives and source isolation are counted. [jscpd](https://github.com/kucherenko/jscpd) |

For a larger study, compare registry-first package checks with the existing installation guard, local lexical search with hybrid retrieval and bounded snippets with full-document context. Context length alone is a weak success measure. In controlled long-context experiments, retrieval accuracy varied with where the relevant information appeared. [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/)

### Connect an external or locally installed MCP

Run `forge integrations list` to view project choices. For a known endpoint use
`forge integrations select deepwiki`. The `github` preset selects the remote
repositories toolset in read-only mode. To use a different service, pass its
Streamable HTTP URL. A local loopback address may use HTTP. A remote address
requires HTTPS.

```sh
forge integrations connect team-git --url https://git.example.org/api/v4/mcp
forge integrations connect internal-docs --url https://docs.example.org/mcp --token-env DOCS_MCP_TOKEN --probe
forge integrations local codebase-memory-mcp --binary /opt/tools/codebase-memory-mcp
forge integrations local docs-worker --binary /opt/mcp/bin/python --arg /opt/mcp/docs_worker.py --pass-env DOCS_API_KEY
forge integrations remove internal-docs
```

Connect uses the current repository's selected hosts. With `--probe`, ForgeKit
negotiates MCP and lists tools before writing the config. A host that supports
OAuth can start its own login flow on first use. CLI probes for authenticated
servers need a compatible bearer access token. `--token-env` writes a reference
for Claude, Codex, Cursor, Gemini, VS Code and Kimi. Zed, Roo and Continue accept
the unauthenticated configuration or can use their own authentication where
supported. ForgeKit reports skipped host and authentication combinations.

A local integration takes an installed executable plus repeatable `--arg` and
`--pass-env` options. For a Python or Node interpreter the first argument must
be the absolute installed entry-point script. ForgeKit checks the program and
absolute argument files by SHA-256 before each launch. After an upgrade, remove
and rebind the reviewed executable. Project files contain a launcher and binding
reference. Each developer binds their own installation. The server receives its
working directory and basic runtime environment. Pass other required environment
variables explicitly by name. An approved executable runs as the current user.
The code-graph integration is a local pilot with a user-supplied installation.
[GitHub remote toolsets](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
· [Codebase Memory manual MCP configuration](https://github.com/DeusData/codebase-memory-mcp#manual-mcp-configuration)

### Search Word, PowerPoint and scanned PDFs

Local `.docx` and `.pptx` ingestion uses Python's standard library. Word text
carries body paragraph or table-row locations. PowerPoint text carries the
displayed slide number, preserves presentation order and skips hidden slides.
The reader ignores notes, external relationships and unsupported embedded content.

An optional source-level `docling` setting enables a local PDF pipeline.

```json
{"id":"manuals","provider":"local","root":"/work/manuals","docling":{"mode":"scans","artifactsPath":"/opt/docling-models","languages":["eng","ara"]}}
```

`scans` tries Poppler first and falls back when extraction fails or a page has
no text. `layout` requests Docling for every PDF in that source. Install Docling,
Tesseract and the requested OCR languages separately and prefetch the Docling
models. In scans mode, omit `artifactsPath` to use local Poppler and Tesseract
for up to 40 pages, with no Docling installation. It returns cited text, with table accuracy
marked unverified. Linux requires libseccomp. macOS requires sandbox-exec. The worker
denies network access to its process and children. Windows reports the optional
offline pipeline as unavailable. Check inferred tables against the originals
before relying on their values. Format support and network isolation have
fixtures. A benchmark of OCR accuracy on company documents requires that corpus.
[Docling local model setup](https://docling-project.github.io/docling/usage/advanced_options/)
