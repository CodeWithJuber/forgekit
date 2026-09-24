# forgekit — architecture

> **One brain for every AI coding agent.** A large language model is stateless: one
> context window, wiped every call. It has no memory of what your team learned, no
> foresight about what an edit will break, and no enforced guardrails. forgekit is the
> **cognitive substrate** — the layer that runs _before_ the model edits code, supplying
> proof-carrying memory, impact foresight, and enforced guardrails — and a **cross-tool
> config compiler** that delivers that brain as native config into every tool at once.

This document is the architecture reference. It is organized around four diagrams:

1. the four-layer config compiler (one source → native configs),
2. the pre-action gate pipeline (`forge substrate`),
3. the proof-carrying-memory ledger and team merge,
4. the reuse / context loop.

The runtime is **zero-dependency Node**. The code graph is `.forge/atlas.json` — plain
JSON, not a database. The ledger is a directory of content-addressed claims under
`.forge/ledger/`, committable to git. Optional tiers (`FORGE_EMBED` embeddings,
Playwright for `uicheck visual`) are opt-in and add no required dependencies.

Every command referenced below is real and wired in `src/cli.js`. Run `forge --help`
for the full list.

## Locked decisions

- **Brand = `Forge`** — CLI `forge`; layer names: skills→**tools**, agents→**crew**,
  hooks→**guards**, code-graph→**atlas**, minimalism→**lean**, memory→**recall**.
  Brand stored as **one token** (the `brand` key in `brand.json`); rebrand = 1 edit.
- **Distributable id = `forgekit`** (npm package + marketplace id) — fixed even if
  the brand token changes, so a rename never breaks install.
- **Scope = full multi-tool day 1** — ten tools plus MCP, from one canonical source.
- **Install = all three channels** (plugin + hardened installer + npm CLI), all
  three pointing at the _same_ tree ("one tree, three front doors").
- **Own `lean` + `atlas`** — as _thin layers over proven primitives_, not
  from-scratch reimplementations (reuse-first).

## 1. A four-layer config compiler with ONE source

You author the substrate once. `forge sync` compiles that source into each tool's
native config. The four layers are how the brain is expressed; the compiler is how it
is delivered.

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#201a15','primaryTextColor':'#f2ede7','primaryBorderColor':'#372c22','lineColor':'#f26430','secondaryColor':'#272019','tertiaryColor':'#171310','edgeLabelBackground':'#201a15','clusterBkg':'#171310','clusterBorder':'#4a3b2e','fontFamily':'ui-sans-serif, system-ui, sans-serif','fontSize':'14px'},'flowchart':{'curve':'basis','padding':10,'nodeSpacing':36,'rankSpacing':44}}}%%
flowchart TD
    S["source/<br/>rules.json · substrate.json · mcp.json"] -->|"forge sync<br/>content-hash + DO-NOT-EDIT headers"| N["native configs<br/>CLAUDE.md · AGENTS.md · .cursor · .gemini · .aider · …"]
    S -. configures .-> L
    subgraph L["the four layers"]
        direction LR
        T["tools<br/>model-invoked skills"]
        C["crew<br/>isolated sub-agents"]
        G["guards (enforced)<br/>deterministic hooks"]
        M["mcp<br/>atlas + substrate server"]
    end
    K["local events<br/>cortex · recall · reuse · diagnose"] --> LG[("PCM ledger<br/>.forge/ledger/")]
    O["independent oracles<br/>tests · CI · human accept/revert"] -->|"move confidence"| LG
    LG <-->|"git union-merge, conflict-free"| TM["teammate ledgers"]
    classDef accent fill:#f26430,stroke:#f26430,color:#171310;
    class G accent;
```

The four layers, brand-named and emitted cross-tool:

- **tools** (`~/.forge/tools/` → `~/.claude/skills/`) — model-invoked capabilities.
- **crew** (`~/.forge/crew/` → `~/.claude/agents/`) — isolated sub-agents
  (scout / verifier / frontend-verifier).
- **guards** (`~/.forge/guards/` → `settings.json` hooks) — **the only layer that
  _enforces_ rather than suggests.** A guard is a deterministic hook the model cannot
  drift from. Prose rules in CLAUDE.md get acknowledged and then forgotten after
  compaction; a guard does not. Every enforceable invariant belongs here.
- **mcp** — the protocol layer. Forge ships one stdio server (`src/cortex_mcp.js`)
  exposing 21 MCP tools: the substrate checks (`substrate_check` / `predict_impact` /
  `assumption_gate` / `rank_code` / …), memory reads AND writes (`forge_remember`,
  ledger ratify/retract), and ops/health — the full table is in docs/GUIDE.md.

Cross-cutting concerns thread through all four: **atlas** (the code graph), **lean**
(minimalism — shipped as _both_ a tool and a Stop-guard, so it applies whether or not
the model invokes it), and **recall** (memory).

## 2. The pre-action gate — `forge substrate`

**cognitive substrate** — the layer that runs _before_ the model edits code. `forge
substrate "<task>"` (and the MCP tool `substrate_check`) runs one ordered pass of
checks and returns a single verdict. It composes the individually-callable stages
(`preflight`, `route`, `atlas`, `impact`, `reuse`, `context`, `scope`, `lean`,
`anchor`, `verify`) into one pre-action contract.

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#201a15','primaryTextColor':'#f2ede7','primaryBorderColor':'#372c22','lineColor':'#f26430','secondaryColor':'#272019','tertiaryColor':'#171310','edgeLabelBackground':'#201a15','clusterBkg':'#171310','clusterBorder':'#4a3b2e','fontFamily':'ui-sans-serif, system-ui, sans-serif','fontSize':'14px'},'flowchart':{'curve':'basis','padding':10,'nodeSpacing':36,'rankSpacing':44}}}%%
flowchart TD
    RE["referenced entities"] --> INTAKE
    subgraph INTAKE["intake"]
        direction LR
        PF["preflight<br/>assumption gap"] --> RT["route<br/>cheapest tier"]
    end
    INTAKE --> ANALYSIS
    subgraph ANALYSIS["analysis"]
        direction LR
        AT["atlas<br/>code graph"] --> IM["impact<br/>blast radius"] --> PT["predict<br/>failing tests"] --> RU["reuse<br/>cache hit?"]
    end
    ANALYSIS --> SAFETY
    subgraph SAFETY["safety + fit"]
        direction LR
        CX["context<br/>completeness gate"] --> SC["scope<br/>coupled files"] --> ME["memory<br/>recall + lessons"] --> MN["minimality<br/>lean footprint"] --> GA["goal-anchor<br/>drift check"]
    end
    SAFETY --> VD["verdict"]
    classDef accent fill:#f26430,stroke:#f26430,color:#171310;
    class VD accent;
```

**blast radius** — the set of files an edit is predicted to impact, read from the code
graph. `forge impact` computes it; the pipeline surfaces it before the model touches
anything. The analysis is **hazard-aware**: SCC-aware propagation (a change to any file
in a circular-dependency cluster impacts all co-members, via Tarjan from `forge rank`)
and a data-driven threshold derived from PageRank centrality and ledger incident history
(`effectiveThreshold = base / (1 + hazard)`). `--basic` reverts to the fixed-threshold
mode. `forge impact` walks reverse dependents; the pre-action check, the ambient prompt hook
and the Stop gate's repair checklist also walk the empirical refutation's repaired sibling
and forward relations (frozen parameters, `SIBLING`/`FORWARD` in `src/atlas.js`) and tag
every file `reverse`, `sibling` or `forward`, because the reverse-only walk missed the
sibling files that were 94.7% of the refutation's misses.

The verdict is **advisory by default** — it reports, it does not block. Set
`FORGE_ENFORCE=1` to turn the strongest signals into a hard block:

- a **vacuous or underspecified** prompt (preflight finds no actionable intent),
- **un-assemblable required context** (the completeness gate cannot cover the edit set),
- a **blast radius over threshold** (default ~25 dependent files; sibling/forward
  co-change candidates are named in the reason but not counted).

Everything else stays a warning the human can override.

## 3. Proof-carrying memory — the ledger + team merge

**proof-carrying memory (PCM)** — every stored fact, lesson, or reuse artifact is a
_claim_ that carries its own evidence. It is trusted only once independent oracles
(tests, CI, a human accept/revert) raise its confidence above a floor. A wrong lesson
decays out instead of ossifying.

All memory subsystems converge on one store. `recall`, `remember`/`brain`, `cortex`
lessons, `reuse` artifacts, and doom-loop `diagnose` results all write content-addressed
claims into `.forge/ledger/`. Because a claim's bytes are a pure function of
`(kind, body, scope)`, every replica computes the same identity — so teammate ledgers
fold together over plain git with no conflicts.

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#201a15','primaryTextColor':'#f2ede7','primaryBorderColor':'#372c22','lineColor':'#f26430','secondaryColor':'#272019','tertiaryColor':'#171310','edgeLabelBackground':'#201a15','clusterBkg':'#171310','clusterBorder':'#4a3b2e','fontFamily':'ui-sans-serif, system-ui, sans-serif','fontSize':'14px'},'flowchart':{'curve':'basis','padding':10,'nodeSpacing':36,'rankSpacing':44}}}%%
flowchart LR
    subgraph EV["local events"]
        direction TB
        E1["recall / remember"]
        E2["cortex lesson"]
        E3["reuse mint"]
        E4["diagnose"]
    end
    EV -->|"content-addressed claims"| LG[(".forge/ledger")]
    O["independent oracles<br/>tests · CI · human accept/revert"] -->|"append evidence<br/>move confidence"| LG
    TM["teammate ledgers"] <-->|"git union-merge<br/>conflict-free"| LG
    LG --> RV["merged read view<br/>recall list · lesson inject · brain index"]
    classDef accent fill:#f26430,stroke:#f26430,color:#171310;
    class LG accent;
```

Mechanically: evidence and tombstones are append-only, hash-deduped logs; confidence
(`val`) is a decayed Beta posterior moved only by oracles; merge is a join-semilattice
(property-tested: commutative, associative, idempotent), so ledgers converge in any
order. `forge init` emits the union-merge `.gitattributes` rule; `forge ledger merge`
folds in any other ledger tree. The ledger is now the default and only store — legacy
files are no longer written or read (`FORGE_LEDGER_ONLY=0` is the one-release escape
hatch back to them). Surface: `forge ledger stats | verify | show | blame |
query | ratify | retract | merge | import` (`--personal` for the per-user ledger).
Decision recorded in
[`docs/adr/0006-proof-carrying-memory.md`](docs/adr/0006-proof-carrying-memory.md).

## 4. The reuse / context loop

`forge reuse` is a proof-carrying code cache. A generated artifact is only served again
when its evidence still holds — the confidence is above the floor _and_ its atlas
dependencies still resolve. Otherwise it falls through to generation and mints a fresh
claim on the way back.

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#201a15','primaryTextColor':'#f2ede7','primaryBorderColor':'#372c22','lineColor':'#f26430','secondaryColor':'#272019','tertiaryColor':'#171310','edgeLabelBackground':'#201a15','clusterBkg':'#171310','clusterBorder':'#4a3b2e','fontFamily':'ui-sans-serif, system-ui, sans-serif','fontSize':'14px'},'flowchart':{'curve':'basis','padding':10,'nodeSpacing':36,'rankSpacing':44}}}%%
flowchart LR
    SP["spec"] --> FP["fingerprint<br/>MinHash + LSH"]
    FP --> LD["match ladder<br/>exact → near → adapt → miss"]
    LD --> GT{"confidence ≥ floor<br/>AND deps resolve?"}
    GT -->|"yes"| SV["serve (proof holds)"]
    GT -->|"miss"| GN["generate"]
    GN -->|"mint claim"| MT[(".forge/ledger")]
    MT -.->|"available next time"| FP
    classDef accent fill:#f26430,stroke:#f26430,color:#171310;
    class SV accent;
```

The completeness gate on the retrieval side is `forge context "<task>"`: it assembles a
budgeted context via set-cover over the predicted edit set (`R(edit)`), applies a
compression ladder, and reports the _computed missing set_ — the inputs it could not
assemble. That missing set is exactly what the substrate pipeline's context stage reads
to decide whether an edit is safe to start. Surface: `forge reuse query | mint | stats`.

## 5. The end-to-end reliability layer

Two failure modes this layer exists to kill: **partial work** (code changes without the
artifacts that depend on it) and **session amnesia** (the next session re-assumes what
this one knew). Instructions raise the _probability_ of correct behavior; deterministic
hooks guarantee a _floor_ — with per-task miss rate `1−p`, silent misses fall to
`(1−p)·P(no check fires | miss)`: `(1−p)(1−c)` for one check with catch rate `c`. A second
check lowers that only where it catches what the first cannot; the product `∏(1−cⱼ)` holds
only if the checks fire independently. The same check repeated at another point (Stop,
pre-commit, CI on the same diff) is nested, so the residual is `(1−p)(1−c_max)` (formal
synthesis §5.3, corrected 2026-09-21).

**The completion gate (Stop, `src/gate.js`).** The only Stop-path guard that may answer:
`completion-gate.sh` runs synchronously (the lesson-mining `cortex.sh stop` stays
detached and can never block). The changed set is **session-scoped**: files from commits
whose committer time is ≥ session start, plus working-tree changes minus the dirt
snapshotted at SessionStart — so pre-existing edits, branch switches, and `git pull`s
are never pinned on the agent (adversarial review demonstrated all three false-block
classes). Paths are classified by ONE total function derived from the atlas registries
(`CODE_EXTS`/`DOC_EXTS`/config rules) plus the shared test-file predicate, parsed from
`-z` NUL-separated git output (C-quoted unicode paths classify correctly). Each
session keeps a trail (`.forge/sessions/<sid>.trail`, appended by the PostToolUse capture:
edit targets and the paths its Bash commands name). A changed file is set aside as a
concurrent agent's only on positive evidence (another live session's authoritative trail
names it and this session's does not); every write no trail saw stays with the stopping
session, so attribution fails toward blame, and without an authoritative trail the set is
the tree-wide one. A stylesheet, or a JS/TS file whose diff only touches
`className`/`class`/`style` JSX attribute values, variant strings or JSX text
(`src/uidiff.js`), is a UI-only change: it owes a doc/state artifact OR a fresh `forge uicheck design|visual`
PASS OR test evidence (a verify PASS, a substantive test, or a passing e2e run, each bound
to the current code state), never a unit test by itself. Code moved without test
evidence or a doc/state artifact → block once with the repair checklist as the reason; every
other row allows, every internal error allows (fail-open), the once-per-session marker
is written BEFORE the block (unwritable marker → stand down rather than nag every turn),
a missing `session_id` disables gating (no shared-state leaks between sessions), and
`FORGE_STOPGATE=0` kills it. `.forge/state.md` is gitignored, so its signal is
mtime-vs-baseline (the baseline file's mtime _is_ session start).

**Session anchoring (SessionStart, `src/session.js`).** Records `HEAD` once per session
(`.forge/sessions/<sid>.base`; resume keeps it), prunes week-old session artifacts, and
injects: learned lessons, the anchored goal, the handoff snapshot, recent commits, and
uncommitted changes — a fresh session orients on evidence, not priors.

**The state/decision stores (`src/handoff.js`, `src/decide.js`).** `state.md` is a
bounded REWRITE (snapshot semantics — loader cost stays O(bound) forever). Writer and
loader share ONE budget in one unit (`STATE_BUDGET_BYTES`, 8 KB): the writer keeps rows in
priority order (goal, next, decisions, gotchas, in-progress, done) until the body fits, so
the SessionStart loader never cuts what the handoff wrote;
`decisions.md` is append-only ADR-lite with a machine-readable `decision` ledger twin
(log semantics — supersede, never edit). Both refuse secrets at write.

**The diff-driven docs sweep (`src/docs_sync.js`).** `docs check` reconciles registries;
`docs sync` answers the diff-shaped question: changed identifiers (paths + definitions +
called symbols, from added AND removed lines, via the same `RULES` grammars the atlas
parses) swept against every doc artifact → UPDATED / STALE (file:line hits) /
VERIFIED-UNAFFECTED with the reason recorded. Pure reporter; the gate provides the teeth.

**Docs-check now guards more than names (`src/docs_check.js`).** Beyond
commands/env/MCP-tools/CHANGELOG, six reconcilers close the blind spots behind recurring
"docs rot" complaints: `checkDiagrams` scans every `mermaid` block across all Markdown for
the branded `%%{init` theme and literal-`\n` node breaks; `checkModelTiers` reconciles doc
prose prices against `src/model_tiers.json`; `checkBenchmarks` reconciles bolded `N ms`
README claims against the measured table in `reports/benchmarks.md`; `checkLinks` resolves
every intra-repo Markdown anchor (`#x` and `path.md#x`) against the target's real headings
(GitHub-exact slugs — em-dashes yield `--`, never collapsed), killing the dead-anchor class;
`checkRoadmap` fails when the ROADMAP's "Now" marker trails the shipped `package.json`
version; and `checkCrosswalk` resolves every `.js`/`.sh` binding the research paper's
crosswalk (`research/formal-synthesis/crosswalk.json`) claims for this repo against the
files that actually exist in `src/`, `global/guards/`, and `hooks/` (kit-only names opt
out with a `kit:` prefix), so the paper's stated bindings can no longer trail the code; and
`checkMintlify` extends the reconcile to the hand-maintained Mintlify site (`mintlify/`,
previously unchecked and prone to drift) — every command must be documented on the English
site as `forge <name>`, and any env var the site names must be one the code reads (no
phantom vars). The two public pages
(`landing/index.html` + the `build-pages.mjs` status page) derive from ONE color source —
`brand.json.colors` (full dark + light palettes), emitted as CSS by `src/brand.js`
(`rootTokensCss()`). `test/pages.test.js` enforces full-palette parity: every hex in
`brand.json` must appear on both surfaces, so the palette can't fork into "two palettes
claiming to be one" again (plus non-empty changes list, no phantom webfont, present
social/favicon metadata). `checkDiagrams` extends the same single-source rule to Mermaid —
every `%%{init` theme must carry the brand's ember + warm-black hexes — so neither the docs'
numbers nor the site's look can silently drift.

**Auto-release (`.github/workflows/bump.yml` + `scripts/bump.mjs`).** A push to `master`
runs `bump.mjs auto`: it releases only when a `feat`/`fix`/`perf`/breaking commit landed
(or `[Unreleased]` was hand-written), synthesizing changelog notes from commit subjects
when none exist, and exits `3` (a clean skip, not a failure) otherwise — so releases cut
themselves without a chore/docs merge spamming the registry.

**Runtime model resolution (`src/model_catalog.js`, `src/http_cache.js`).** A tier names a
model _family_; `model_tiers.json` keeps a snapshot of ids and prices only as data of last
resort (its `pricingVerified` date still drives `forge doctor`'s staleness warning). The concrete
id is resolved where one is needed — `buildRunner` (adjudicate, on the runner's first call, so
building a runner stays free on the hook path), `emitGatewayConfig`, `estimateSpendFromLogs`,
`forge route`, `forge models` — by `resolveTierModel`: the newest model of the family in the
active provider's live catalog (the Anthropic Models API with `ANTHROPIC_API_KEY`, following
`has_more`/`last_id` → `after_id`; a custom gateway's `/v1/models`; OpenRouter's list), where
"of the family" is a whole-token match of the family word on id or display name and "newest"
is the catalog's `created_at` (then the parsed version, the `YYYYMMDD` stamp, the plainest id).
`resolveTierPrice` / `resolveModelPrice` price an id from OpenRouter's public catalog
(per-token strings → per million, ids matched by canonical token set), then the snapshot row,
the router registry, and the family's tier — an id nothing prices is reported, never billed at a
guessed rate. Each step runs only when the previous is unavailable; an explicit
`.forge/providers.json` id or `ANTHROPIC_MODEL` override is never replaced. Fetches go through a
small private HTTP cache under `.forge/cache/` (self-gitignored, and listed in
`.forge/.gitignore`): freshness comes only from the response (`Cache-Control: max-age`,
`Expires`, `Age`, `Date`), everything else is revalidated with `If-None-Match` /
`If-Modified-Since`, and a failed request serves the stored copy as stale — the snapshot is older
still. The transport is a spawned-node child (the `llm.js` pattern: synchronous, headers on
stdin, never argv), 3 s timeout, never throws; `FORGE_NO_CATALOG_FETCH=1` turns it off.

**Custom-gateway model remap (`src/gateway_model_map.js`).** A self-hosted LiteLLM/proxy gateway
serves its own model names, so a snapshot ID sent verbatim 404s. When a non-default gateway base
URL is configured, the module reads its `GET /v1/models` through the same catalog fetcher (once
per process) and maps each tier onto the newest advertised model of its family — the same
`newestInFamily` rule; the `setOverlap` score against the tier's name tokens is still reported
with each pick. It fails safe to the snapshot ID on an unreachable `/v1/models` / no family
match. `forge doctor`'s **gateway models** row prints the resolved `tier→model` mapping for
verification. The `MODELS` export shape is unchanged: resolution is a layer over the table, not
an edit of it.

**Typed proposers via TypeSafe System One (`src/jev.js`).** Two of the substrate's proposer
judgments are not text-generation tasks at all: `route`'s complexity band is a classification
(cheap/mid/premium), and preflight's assumption gate is four independent yes/no readings (one
per rubric dimension). When `TYPESAFE_API_KEY` is set (same `FORGE_LLM=1` opt-in), those two
faculties ask Jev instead of a text model — one batched `POST /v1/systemone` returning typed
`choice`/`noul` answers with probability distributions and confidence in ~150ms, versus seconds
of text plus JSON parsing. The module reuses the adjudicate contract verbatim: opt-in, fail-safe
(null → text-LLM fallback → deterministic rubric; a null never moves a verdict), zero-dependency
(the `llm.js` spawned-child pattern, key in child env as `_FORGE_JEV_KEY`), and secret-refusing
on the outgoing state. Jev answers are validated against the questions asked — a choice naming
an option we never offered is garble and fails safe. The reconciles judge Jev like any proposer:
`reconcileRoute` compares its band with the deterministic score's band and gates on p(band);
`reconcileAssumption` compares Jev's ask/proceed verdict (mean noul vs 0.5) with the rubric's
and lets it flip the gate only at p ≥ `minConfidence` — the two completeness scales are never
blended; and clarifying free-text questions stay with the deterministic rubric, because a
System One model judges but does not author prose.
Provenance records which proposer answered
(`llm.provider: "jev"` in `forge route --json`, `assumption.provenance.provider` in preflight).

**Intent cards (`src/intent.js`).** Prompt → intent by the same exemplar k-NN math as
model routing — a labeled bank (English + Hinglish rows) under overlap similarity with a
confidence gate, NOT a keyword DFA. Note `intentGrams` ≠ `contentGrams`: route.js stops
generic task verbs (`fix`/`add`/`build`) as complexity noise, but they are exactly the
intent signal — same math, different stop-set data.

**Graded goal-drift & completeness (`src/anchor.js`, `src/preflight.js`).** Two decisions that
were the last hand-static holdouts are now formulas. Goal-drift no longer classifies a changed
file by a binary path-substring match; `onGoalScore` is a **noisy-OR** (`1 − (1 − p)^hits`, the
same estimator `lessons.js` uses) over how many distinct goal concepts the file exhibits in its
path **and** its atlas-defined identifiers, thresholded at the single-hit floor — so a file that
implements the goal without naming it in its path is still classed on-goal. `driftScore` stays the
off-goal fraction (the `cusum` operating point is unchanged; an on-goal checkpoint scores 0 and
drains the chart); the grading sharpens _which_ files count as drift, not the detector's tuning. The M2
completeness score `s(x)` is a **logistic** over its features (concreteness, named specifics,
vagueness, a smooth `tanh` length term) instead of an additive rubric with magic coefficients and
discontinuous word-count steps — the `sigmoid` bounds it to (0,1) with no clamp, every feature's
pull stays attributable, and a labeled bank could refine the weights via `predictor.js`'s
`trainLogistic`. The hand-set prior (not fit to data) puts the paper's own examples on the
right side of the 0.6 threshold: a bare "make the auth better" ≈ 0.23 → ask; the concrete
verifyToken edit ≈ 0.88 → proceed. That edit scored ≈ 0.63 when the weights were set, with one
concrete anchor (the filename); since a named code identifier became a second anchor it scores
≈ 0.88, and the weights were not re-fit.

**The evidence trail (preflight).** Once a goal is anchored, every prompt appends its
graded `driftScore` to the session log; `cusum` (until now test-only math) accumulates
the series and a sustained alarm rides the gate's block reason. Proceeding under
assumptions appends a record the advisory names and the next handoff surfaces — a guess
can never silently become a fact.

**Commit-boundary gate (`src/commit_gate.js`, `forge precommit`).** The commit rung of
the gate lattice (turn ⊂ commit ⊂ PR): the Stop hook gates the turn and CI's `docs check`
gates the PR, so this runs the SAME registry-derived completeness classifier
(`classifyPath` from `gate.js`) plus `hasSecret` over staged added lines at the commit
boundary — code staged without its doc/state artifact, or a staged secret, is caught
while the fix is still one `git add` away. The rungs are **not** independent catch
layers: on the same diff the copies fire together, so they do not multiply the catch rate
and the residual stays `(1−p)(1−c_max)`. This rung adds catches only where it sees what the
Stop hook could not — edits made after the turn ended, a host or session where the Stop
hook never ran, or a session whose one Stop block was already spent.

**Deep verification (`src/consensus.js`, `forge verify --deep`).** Where plain `verify`
asks one oracle (the tests) plus one heuristic, this runs a table of independent lenses
and aggregates them with the same noisy-OR risk score `lessons.js` uses, behind a
cross-family gate so correlated structural signals can't block alone. Deep `ok` is a
conjunction: the core verifier must PASS **and** the lens consensus must not block; an
unconfigured core can never yield `ok:true`. The score is a calibrated heuristic, not a
proof.

**Knowledge routing (`src/knowledge_router.js`).** The third routing leg beside `route.js`
(model tiers) and `intent.js` (intent classes), using the same exemplar k-NN math: a fact
is routed to its storage home (decisions vs. the ledger vs. …) tuned by adding example
rows, never regexes. It is TOTAL by construction — a fact resembling nothing falls back to
the ledger (whose decay semantics make an unsure placement safe), never "nowhere".

**Anti-repetition memory (`src/deja.js`).** Closes the "why do I keep re-solving solved
tasks" gap: a clean first-try success used to leave no durable trace (cortex only mints on
correction). At Stop it mints one `summary` claim (a deterministic, secret-redacted gist),
attaching a `test.run` confirm when the session's tests passed; `dejaLookup` then ranks
prior summary/lesson/diagnosis claims for a new task with the same `retrieve()` (rel × rec
× val) the ledger query uses. No new protocol — it reuses the shipped PCM machinery.

**The documentation-impact graph (`src/docs_impact.js`, `forge docs impact`).** Where
`docs check` reconciles fixed registries and `docs sync` scans a diff for identifiers,
this answers "I changed X — which documented surfaces mention X and are now potentially
stale?" via a data-driven `EXTRACTORS` registry (commands, flags, env vars, MCP tools,
exported symbols, brand tokens, version, package.json fields) reused from `docs_check.js`,
an inverted entity → `file:line` index over every doc surface, and a diff-scoped impact
query ranked by confidence. Advisory by default; `--strict` exits non-zero for CI.

**Load-bearing code detector (`src/rank.js`, `forge rank`).** Fuses three classical graph
readings of the atlas — weighted PageRank centrality (deterministic power iteration over
sorted node ids), iterative Tarjan SCC (circular-dependency clusters), iterative
Hopcroft–Tarjan articulation points (chokepoint files) — with the team's own incident
history from the evidence ledger (`val()`-weighted lesson and session-summary claims that
name each file). The join `hazard = centralityNorm × (1 + history)` means structurally
central code that has hurt before outranks equally central code that hasn't. Exposed as the
`rank_code` MCP tool and the `forge rank` CLI command.

**Parallel-session conflict radar (`src/collide.js`, `forge collide`).** Reads recent
foreign-session summaries from the team-merged ledger and computes per-file collision risk
via the same noisy-OR model lessons use: `risk = 1 − ∏(1 − recᵢ × strengthᵢ)` over
sessions that touched overlapping files or their 1-hop import neighbors. No server, no
presence protocol — teammate summaries arrive via `forge ledger sync` / `git pull`. Exposed
as the `collide_check` MCP tool.

**Machine-owned doc surfaces (`src/docs_render.js`, `forge docs render`).** The
auto-maintenance layer that keeps tables and diagrams in sync with the code registries.
Four marker-managed blocks (commands table in README, groups and MCP-tools tables in GUIDE,
repo-map diagram in ARCHITECTURE) are regenerated from `COMMANDS`/`GROUPS`/`TOOLS`; six
"N MCP tools" count phrases are auto-corrected; and every mermaid block across all `.md`
and `.mdx` files receives the branded `%%{init` theme. Registry-derived blocks are CI-gated
errors when stale; tree-derived output is advisory.

**Deliberately not wired:** `checkpointCadence` (optimal-stopping check spacing) still
has no runtime step-loop to consume it — wiring it would mean inventing one. It stays
library math with tests until a real consumer exists.

## Component map — the reuse ledger (30 components)

**Reuse (rename + swap brand token, logic unchanged):**
`tech-selector · reuse-first · dev-radar · code-modernization · explore-plan-code ·
cost-guard · ui-workflow · design-md · self-improve` (tools) · `scout · verifier ·
frontend-verifier` (crew) · `protect-paths · format-on-edit · recall-load ·
session-learner` (guards) · `statusline` · `tech-currency · stack-notes ·
self-correction` (rules) · project-layer template.

**Own-branded replacements (thin layer over proven primitive):**

- **`lean`** — a model-invoked **tool** (YAGNI ladder, reuse-before-build,
  shortest-diff) **+** a deterministic **`lean-guard`** Stop-hook that nudges on
  oversized diffs. No plugin, no engine.
- **`atlas`** — a plain-JSON code graph built and read by Forge itself. No external
  graph engine, no language server, no database.

**Net-new (justified by a pain):**

- **`forge sync`** (the cross-tool emitter) · **`forge doctor`** (health check) ·
  **`forge init`** (one-command bootstrap) · **`cost-budget` guard** ·
  **Start-Here catalog** · **`recall`** unified memory subsystem.

**Bundled skills (model-invoked, shipped in `global/tools/`):** beyond the reuse skills
above, `problem-solver` (a framework-driven Clarify → Classify → Diagnose → Generate →
Decide → Act cycle) and `catchup` (session re-orientation, pairs with `forge decide`) ship
as native skills through the plugin's `skills` directory.

## `atlas` — the code graph

`forge atlas build [path]` walks the tree and writes a **portable JSON artifact**,
`.forge/atlas.json`. It is plain JSON on purpose: any tool can read it.

- `forge atlas query "what calls Z"` reads the artifact directly — a few hundred tokens
  instead of reading five files.
- `forge atlas has <symbol>` is the hallucinated-symbol check: if the model calls a
  symbol that is not in the graph, the gate flags it.
- **Cross-tool by design:** Codex / Cursor / Gemini / Aider read `.forge/atlas.json`
  via the CLI or plain `jq` — **no MCP dependency to consume.** The MCP server is
  optional, lazy-started, for Claude convenience only.

`atlas.json` is the single source the impact, reuse-revalidation, and hallucination-flag
stages all read. There is no SQLite database and no `.forge/atlas.db`.

Import specifiers resolve through **one** resolver, `src/scope.js` (`resolveSpec`), which
the file graph (`scope`, `rank`, `collide`) and the symbol graph (`atlas`, `impact`) both
call, so they never disagree about what a specifier points at. It follows relative paths
and the repo-root tsconfig/jsconfig path aliases (`loadPathAliases`: `paths`, `baseUrl`,
relative `extends`, JSONC). A spec under a local alias that misses is counted
`unresolved`, not `external`.

The `RULES` table (`src/atlas.js`) is the ONE language registry — JS/TS, Python, Go,
Rust, Java, Ruby, C#, PHP, Kotlin, Swift, C/C++ as regex grammars (zero-dep; a real
parser would need tree-sitter, which the no-runtime-deps rule forbids). `CODE_EXTS =
new Set(Object.keys(RULES))` means adding a language auto-extends the walk, the
completion gate's code-class, and the docs sweep — no other file changes.

**`forge stack` (`src/stack.js`)** answers the complementary question the parser can't:
_what is this repo actually built with?_ It reads the dependency manifests
(package.json, pyproject.toml, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml/
build.gradle, *.csproj) and reports languages + frameworks + package managers + real
test commands. Detection is data (`SIGNATURES`-style tables), every reader is fail-safe,
and the detected test commands feed `substrate`'s verification checklist — so "run the
tests" means the repo's *actual\* runner, not an assumed `npm test`.

**`forge update` (`src/update.js`)** is the self-update path across all three install
modes. It detects a git checkout vs an npm/copy install, does a cached (hourly) best-
effort `git fetch`, and reports commits-behind-upstream; `doctor` surfaces that as a
non-nagging notice (`FORGE_NO_UPDATE_CHECK=1` to silence). Every path is fail-open —
offline, no upstream, or detached HEAD returns "unknown", never an error.

CLI output is **quiet by default**: the per-command `Forge <cmd> — …` title is branding
chrome behind `--verbose`/`FORGE_VERBOSE`, so a command emits its result first. The repo
also dogfoods its own plugin via a committed `.claude/settings.json` that wires the
guards through `${CLAUDE_PROJECT_DIR}`.

## Verified cross-tool emit matrix

_(All rows confirmed against vendor docs.)_ Forge emits config for **ten tools**, plus
an **MCP server** for Roo Code and VS Code.

| Tool               | Native target                                                            | How Forge emits                                                                                        |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Claude Code**    | `CLAUDE.md` (+ `.claude/rules/*.md`, `settings.json`); **no** AGENTS.md  | Thin `CLAUDE.md` whose first line is `@AGENTS.md`; guards+permissions → `settings.json`                |
| **Codex**          | `AGENTS.md` native (32 KiB cap)                                          | Canonical `AGENTS.md` at root **is** the source; keep < 32 KiB or it silently truncates                |
| **Cursor**         | `AGENTS.md` + `.cursor/rules/*.mdc` (`.cursorrules` deprecated)          | `AGENTS.md` for flat rules; `.mdc` when scoping/precedence needed; never leave a legacy `.cursorrules` |
| **Gemini**         | `GEMINI.md` by default; **AGENTS.md only via `context.fileName` opt-in** | Write `.gemini/settings.json` `context.fileName:["AGENTS.md",…]` (avoids a 2nd copy)                   |
| **Aider**          | `CONVENTIONS.md` via `read:` in `.aider.conf.yml`                        | Emit `.aider.conf.yml` with `read: AGENTS.md`                                                          |
| **Copilot**        | root `AGENTS.md` + `.github/copilot-instructions.md`                     | Rely on root `AGENTS.md`; optional generated `.github` pointer                                         |
| **Windsurf/Devin** | `AGENTS.md` auto-discovered; caps 6k/12k chars                           | Root `AGENTS.md` under caps; detect `.windsurf` vs `.devin` at init                                    |
| **Zed**            | first match of a precedence list incl. `AGENTS.md`                       | Emit `AGENTS.md` + doctor flags any earlier-precedence legacy file shadowing it                        |
| **Continue**       | `.continue/rules/*.md` + `.continue/mcpServers/*.yaml`                   | Emit a rules file plus the Forge MCP server config                                                     |
| **OpenClaw**       | execution-folder `AGENTS.md` as project context; MCP registry is global | Rely on root `AGENTS.md`; write an OpenClaw-shaped `.openclaw/mcp.json` the operator applies with one `openclaw mcp add` |

Roo Code and VS Code receive the Forge MCP server via `forge init`
(`.roo/mcp.json`, `.vscode/mcp.json`) rather than a rules file — like every per-tool file,
only for tools the repo uses (detected, or `forge init --tools`); the set is recorded in
`.forge/forge.config.json` so `forge sync` emits the same targets.

`AGENTS.md` is shared with people, so forge owns only a marked block in it
(`<!-- forge:begin -->` … `<!-- forge:end -->`). Sync appends that block to a hand-written
file and afterwards compares and rewrites only the block; the Stop-hook auto-sync does the
same and never adopts a file without one. A pre-block, fully generated `AGENTS.md` is
recognised by the hash in its header and converted to a block keeping any text a person
added around it; only one edited inside its generated text needs a full rewrite, which
`forge sync` does after saving a timestamped `AGENTS.md.forge-bak-<time>`. A body line that
reads exactly like a marker (a multi-line rule, fact or lesson) is indented one space so it
cannot end the block early. The Codex/Windsurf size checks measure the whole file, the
person's text included. Sync and doctor warn while an `AGENTS.md.forge-bak` from an older
forge still holds text AGENTS.md lacks, since no agent reads it.

### OpenClaw: what is automatic and what is not

OpenClaw appends the execution folder's `AGENTS.md` after its configured agent-workspace
files as project context, so the canonical rules reach it with **no** extra instruction
file — the same deal as Codex, Cursor and Copilot. Only `AGENTS.md` travels this way:
OpenClaw deliberately does not load `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` or
`BOOTSTRAP.md` from the execution folder, so anything Forge wants OpenClaw to read has to
be inside the canonical body.

For the **config compiler path**, MCP is deliberately not automatic. OpenClaw's server
registry is `mcp.servers` in the user's global `~/.openclaw/openclaw.json`; Forge never
writes to another tool's global config. Instead `forge sync` emits a repo-local,
OpenClaw-shaped fragment at `.openclaw/mcp.json` and reports the exact command that
registers it:

```bash
openclaw mcp add forge-cortex --command forge --arg cortex-mcp
openclaw mcp doctor forge-cortex --probe   # prove it starts and lists tools
```

There is also a separate **bundle installation path**. The published package already ships
`.codex-plugin/plugin.json`, `global/tools`, and `.mcp.json`; OpenClaw auto-detects that
layout as a Codex bundle. Installing a trusted local directory or packed archive through
`openclaw plugins install` loads Forge's skills and bundle-scoped `forge-cortex` MCP server,
so the manual global registration above is unnecessary for that installation. This does not
turn Forge's Claude `hooks/hooks.json` automation into OpenClaw guards: only OpenClaw-style
hook packs execute. Forge therefore provides no ambient pre-action guard on OpenClaw.

## Repo layout — one tree, three front doors

```
forgekit/
  package.json            # npm CLI: bin `forge` → src/cli.js
  brand.json              # single brand token + layer-name map
  README.md               # Start-Here index + one bootstrap command
  src/
    cli.js                # init | sync | doctor | substrate | ledger | reuse | … (`forge --help` for all)
    sync.js               # emitter (source → per-tool targets); hash + DO-NOT-EDIT
    doctor.js             # health checks
    emit/                 # one module per tool (claude, codex, cursor, gemini, aider, copilot, windsurf, zed, continue) + mcp
    ledger.js             # PCM core: content-addressed claims, oracle taxonomy, decayed Beta val, Eq. 3 retrieval, semilattice merge (ADR-0006)
    ledger_store.js       # git-native on-disk ledger (.forge/ledger/): sharded claims, append-only evidence/tombstone logs, normal-form verify, local usage log
    ledger_retention.js   # retention learned from the ledger's own history: archive never-served claims, idle ones past the longest observed comeback, and BIC-detected near-duplicates (`ledger compact`)
    ledger_bridge.js      # legacy-store bridge, dormant by default (ledger-only); `FORGE_LEDGER_ONLY=0` re-enables cortex/recall/brain shadow-writes + idempotent `ledger import`
    ledger_read.js        # ledger-only read path by default (`FORGE_LEDGER_ONLY=0` merges legacy∪ledger instead): cortex lesson/fact injection, `recall list`, brain's AGENTS.md index all see teammate knowledge from `ledger merge`
    learn_consolidate.js  # bin/learn-consolidate.sh: deterministic consolidation of ~/.claude/skills/learned — merge duplicates, drop only ledger-refuted (dormant/retracted/attic) lessons; no model call
    reuse.js              # proof-carrying artifact cache: fingerprint (MinHash+LSH), exact→near→adapt→miss ladder, atlas revalidation
    embed.js              # optional embeddings tier (ADR-0005): FORGE_EMBED=cmd:<cmd>|http:<url>, swaps MinHash/Jaccard for cosine in `reuse query`/`ledger query`, disk-cached at .forge/embed-cache.jsonl, silent fallback to MinHash
    context.js            # budgeted context assembly + completeness gate: R(edit) set cover, compression ladder, computed missing-set
    diagnose.js           # doom-loop diagnosis: normalized failure signatures; 3× = diagnosis claim + one-tier escalation
    imagine.js            # consequence simulation (Eq. 4): predicted breaks + minimal dry-run suite via greedy set cover
    uifingerprint.js      # deterministic design fingerprint + slop-distance / conformance gate (no LLM, no screenshots)
    taste.js              # taste-profile system: applies design-taste profiles (brutalist, corporate, editorial, minimalist, playful; JSON in global/taste/) to parameterize `uicheck design` gate thresholds via --taste
    dash.js               # localhost-only read-only dashboard over the ledger, metrics, and blast radius (node:http, one HTML page)
    metrics.js            # stage-tagged .forge/metrics.jsonl — the measured events every cost figure is computed from
    cost_report.js        # per-stage cost factors as pure arithmetic over metrics.jsonl; composes ONLY measured stages
    rank.js               # load-bearing code: weighted PageRank centrality × ledger incident history, Tarjan SCC (circular deps), Hopcroft–Tarjan articulation points (chokepoints)
    collide.js            # parallel-session conflict radar: noisy-OR risk over recent foreign sessions that touched overlapping files or their import neighbors
    docs_render.js        # machine-owned doc surfaces: registry-derived tables (commands, groups, MCP tools) + tree-derived repo map, auto-normalized mermaid themes
  source/
    rules.json            # THE canonical rules source (git · testing · security · style)
    substrate.json        # cognitive-substrate defaults (thresholds, routing, llm knobs)
    mcp.json              # MCP server definitions emitted into each tool
  global/                 # installs into ~/.forge, symlinked into ~/.claude
    tools/ crew/ guards/ rules/ recall/ taste/ statusline.sh settings.template.json
  templates/project-layer/  # per-repo template
  .claude-plugin/ .codex-plugin/  # plugin manifests → point at global/ + skills/ (no dup beyond the codex skill mirror)
  install.sh              # hardened: idempotent, symlink, backup, no curl|sh
  bin/                    # back-compat shims → src/cli.js
  landing/                # hand-authored public landing page; design tokens shared with `forge dash`
  scripts/
    build-pages.mjs       # generates public/index.html, the live status page, from real repo data
```

Public site deploy (two independent Pages targets, both built from `landing/` +
`scripts/build-pages.mjs`): `.github/workflows/static.yml` (GitHub Pages — assembles
landing + status page into one `_site/`) · `.gitlab-ci.yml` (GitLab Pages — status
page only).

The plugin manifest, `install.sh`, and the npm bin **all reference `global/` +
`source/`** — no duplication; each channel just runs `forge sync` at the end. A test
asserts all three resolve to `global/`.

## Risks & honest boundaries

- **Enforcement ceiling** — guards enforce only what is expressible as a hook (paths,
  format, diff-size, budget). Semantic rules ("prefer functional") stay prose and
  _will_ sometimes be ignored. Forge **reduces, does not eliminate** rule drift. Say so.
- **Verification reduces, does not certify** — `crew` verifiers and the `atlas has`
  hallucination flag cut review burden; they do not prove the code correct.
- **No weight-level learning** — `recall` / `self-improve` are file-and-prompt memory
  only. No RL, no fine-tuning. Consolidation is a Haiku summarizer that can hallucinate
  → advisory, human-reviewable, secret-free.
- **Hook fragility is upstream** — Windows / worktree / long-session hook failures
  affect Forge guards too. Mitigated with defensive path resolution + `forge doctor`;
  the ceiling is inherited, not removed.
- **Char caps** — Codex 32 KiB, Windsurf 6k/12k, marketplace budget truncation →
  `forge sync` enforces a source size budget.
- **Own atlas + lean = new maintenance surface** previously outsourced. Atlas is scoped
  to the minimum graph that powers reuse + hallucination-flag, not a code-intel product.
- **Three channels triple drift surface** — mitigated by "one tree" + the resolve test.
- **Not shipped (exploring)** — deeper language-server / serena-style semantic
  resolution and an embeddings-backed atlas were prototyped but are **not in the
  runtime**. The shipped code graph is plain-JSON, tree-walk based, zero-dependency.
  `FORGE_EMBED` is the only embeddings path, and it is opt-in.

---

See [ROADMAP.md](ROADMAP.md) for direction and [`docs/adr/`](docs/adr/) for the recorded
architecture decisions (zero runtime deps, the SKILL.md standard, guard-over-prose).

## Repo map (generated)

Top-level directories sized by file count, edges = import counts between them —
rendered from the live import graph by `forge docs render`, so it can never drift
from the tree it describes.

<!-- forge:render:repo-map:begin (generated by `forge docs render` — do not edit) -->
```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#201a15','primaryTextColor':'#f2ede7','primaryBorderColor':'#372c22','lineColor':'#f26430','secondaryColor':'#272019','tertiaryColor':'#171310','edgeLabelBackground':'#201a15','clusterBkg':'#171310','clusterBorder':'#4a3b2e','fontFamily':'ui-sans-serif, system-ui, sans-serif','fontSize':'14px'},'flowchart':{'curve':'basis','padding':10,'nodeSpacing':36,'rankSpacing':44}}}%%
flowchart LR
  test["test<br/>119 files"]
  src["src<br/>110 files"]
  test["test<br/>121 files"]
  src["src<br/>111 files"]
  landing["landing<br/>61 files"]
  research["research<br/>37 files"]
  global["global<br/>5 files"]
  bench["bench<br/>3 files"]
  scripts["scripts<br/>2 files"]
  docs["docs<br/>1 file"]
  examples["examples<br/>1 file"]
  test -- 247 --> src
  test -- 244 --> src
  bench -- 8 --> src
  examples -- 4 --> src
  test -- 2 --> bench
  test -- 2 --> global
  test -- 2 --> scripts
  scripts --> src
  src --> global
```
<!-- forge:render:repo-map:end -->
