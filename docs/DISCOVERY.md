# Live discovery and Jev decisions

Forge recommends skills, plugins, tools and hooks for the task at hand. Suggestions
include why a candidate fits, its source URL, lookup time, available license/update
metadata and setup guidance. "Best observed fit" refers to the candidates returned
by this lookup, not every tool on the internet.

## Setup across repositories

```sh
forge discover setup --global --decisions on --recommendations on --search serper
forge discover status
```

Set `TYPESAFE_API_KEY` in your shell or agent host's secret environment. Google
search through Serper also needs `SERPER_API_KEY`. For Brave, choose `--search brave`
and set `BRAVE_SEARCH_API_KEY`. Select `--search off` to use GitHub, npm and
Stack Overflow without a search-provider key.

Forge saves preferences outside the checkout, under its private user-state
directory. It never stores keys in preferences or prints them in status output.
Restart an agent host after changing its environment so hooks inherit the keys.

Without `--global`, setup applies to the current workspace, including commands
started in its subdirectories:

```sh
forge discover setup --decisions off --recommendations off
forge discover reset
forge discover reset --global
```

Precedence is explicit call options, environment, workspace preferences, global
preferences, defaults. `FORGE_LLM=0` disables Jev; `FORGE_LLM=1` enables the existing
model proposer layer. A saved `--decisions on` enables Jev alone. Defaults are
automatic recommendations off, model decisions off and optional web search off.
`FORGE_EVIDENCE_WEB=1` enables automatic public research/recommendations for this process.
`FORGE_NO_CATALOG_FETCH=1` disables public fetching even for an explicit lookup.
These public-search switches do not disable separately opted-in model decisions.

The default TypeSafe model is `jev-latest`. Use `--model <jev-model-id>` to pin
another model offered by TypeSafe. The existing `TYPESAFE_BASE_URL` endpoint
override continues to work. API contract: <https://docs.typesafe.ai/api.md>.

## Find a task fit

```sh
forge discover find "React browser testing skills plugins tools and hooks"
forge discover find "Compare a PDF parser" --web "Python PDF extraction tools" --json
forge evidence "Implement accessible React forms"
forge develop "Debug PostgreSQL deadlocks" --json
```

`discover find` searches afresh. Evidence and prompt/failure hooks use a shared
six-hour cache with a one-minute failure backoff. An explicit `--web` query always
fetches afresh. Hooks query at most two artifact kinds, show the top result within
the existing evidence budget, and use shorter network/model timeouts.

Automatic queries contain only known technology/problem labels. Stack detection
can supply those labels when the task omits its framework. Repository names,
private dependency names, source snippets, file paths and raw failure messages
are not sent to search providers. `--web` is a separately authored public query.
Retrieved descriptions are untrusted source data.

Ranking uses topical overlap, observed maintenance/license metadata and reviewed
catalog availability. Popularity alone cannot win. Missing metadata stays unknown.
A high-confidence Jev choice can select an eligible candidate or abstain; invalid,
low-confidence or unavailable answers retain the deterministic ordering.

Discovery never installs a result. A reviewed catalog entry with resolved version
metadata may offer `forge integrations install <id> --version <version>`. Other
results link to their upstream setup instructions and report compatibility as
unverified. Review the supported host, runtime, permissions and license there.

## Shared typed advice

The same TypeSafe client now supports:

- Routing complexity and preflight completeness, with their existing deterministic
  reconciliation and safety floors.
- Planning focus in `forge develop`, `forge evidence` and hook context.
- Debugging next steps in `forge diagnose`.
- Selection among relevant discovery candidates.

New planning/debugging requests send bounded categories, counts and booleans.
Candidate ranking sends public terms and bounded public candidate metadata.
Existing routing/preflight calls still send the supplied task when opted in.
No model choice marks a check passed, authorizes an install or cancels repeated-
failure escalation. Keys missing, timeouts and malformed responses fall back to
deterministic advice.
