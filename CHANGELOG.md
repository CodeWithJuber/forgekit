# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Binary files no longer trip the commit gate's secret scan.** The staged scan reads every
  file with `git diff --text`, and the entropy leg flagged the XMP packet id
  (`W5M0MpCehiHzreSzNTczkc9d`, a constant fixed by Adobe's XMP spec) that the XMP packet
  wrapper carries inside PDFs, JPEGs and PNGs, so ordinary binary commits were refused. A staged file that git
  reports as binary (`--numstat` prints `-`/`-`) and that contains a NUL byte now gets the
  credential-format grammars only; a `binary` attribute on a text file does not qualify, so
  `.gitattributes` cannot switch the entropy leg off. The XMP packet id is also exempt from the
  entropy leg everywhere, like lockfile integrity digests. A `ghp_…` token inside a binary is
  still refused, and an unreadable diff still fails closed.

- **A handoff snapshot is read back whole at session start.** `forge handoff` wrote up to
  150 lines to `.forge/state.md` but the SessionStart loader injected only the first 80, so
  rows 81–150 of a valid handoff were silently dropped (the budget mismatch the formal
  synthesis's T4 correction names). Writer and loader now share one budget in one unit,
  `STATE_BUDGET_BYTES` (8 KB of snapshot body), and the writer keeps rows in priority order
  (goal and acceptance criteria, next steps, decisions, gotchas and open assumptions,
  in-progress files, then done) until the body fits. A section that lost rows ends with
  "(+N more not kept …)". Sections are now written in that priority order. Only a hand-edited
  or pre-budget file can still overflow the loader, and then the cut names the file.

- **The verifyToken example's completeness score matches the code again.** The docs
  (ARCHITECTURE.md, GUIDE, the cognitive-substrate README) and the `src/preflight.js` comment
  said "Change verifyToken in src/auth.js to require length > 20; update tests" scores ≈ 0.63
  (medium risk), but the code gives 0.878 (low risk). The prior was hand-set when that task
  had one concrete anchor (the filename, 0.63); since 2026-09-21 a named code identifier is a
  second anchor. The docs now show 0.88 and say why; the weights are unchanged. A test pins the
  value and checks that the two example outputs print it.

### Changed

- **The everyday blast-radius checks walk sibling and forward relations, tagged.** The
  substrate pre-action check (so also the ambient prompt hook and the `FORGE_ENFORCE` gate)
  and the Stop gate's repair checklist ran the reverse-only walk that the empirical
  refutation measured at recall 0.022, where 94.7% of the misses were sibling files. They now
  walk reverse + the paper's repaired sibling and forward relations at the frozen parameters
  already in `src/atlas.js`, and every file is tagged with the relation that reached it:
  `forge substrate` and the ambient advisory print `path (reverse|sibling|forward)` with a
  per-relation count, `--json` adds `impact.fileRelations` and `impact.relationCounts`, and the
  Stop gate's block reason lists the untouched co-change candidates. The enforce gate still
  counts only dependents toward its 25-file block (the wide walk would put 79 of this repo's
  98 source files over it, against 35 today, at precision about 0.09) and names the other
  candidates in its reason; `blastRelations` changes what it counts. A wide walk never relabels
  a reverse dependent, so its reverse-tagged set equals the reverse-only answer. Scope
  decomposition and lesson matching keep using dependents only. `relations: ["reverse"]`
  (`substrateCheck`, `repairReason`) is the explicit reverse-only option; `forge impact` and
  `predict_impact` are unchanged (reverse-only unless `--all-relations`). The
  `source/substrate.json` impact faculties move from `operational-v1` to
  `operational-v2-recall`, with a guarantee that says the frozen parameters were tuned on a
  different graph builder and are not held-out validated here.

- **`bin/learn-consolidate.sh` no longer lets a model prune memory.** It sent every learned
  lesson to Haiku with "DROP anything … contradicted" and rewrote `~/.claude/skills/learned`
  from the answer, which is pruning by the model's own judgment (the research requires pruning
  by ground truth). Consolidation is now deterministic (`src/learn_consolidate.js`): exact and
  near-duplicate lessons within a project merge (MinHash Jaccard ≥ 0.7, the ledger's own
  consolidation threshold), and a lesson is dropped only when its matching ledger claim in
  that project is dormant, retracted or pruned to the attic; a lesson the ledger knows nothing
  about is kept. `--repo <root>` names the ledger (default: the current directory), and
  `--dry-run` / `--json` report without writing. Originals are archived first, as before. The
  model rewrite remains behind an explicit `--llm` first argument, with "contradicted" removed
  from its prompt.

- **The gate docs no longer claim that repeated gates multiply their catch rates.** The
  headers of `src/commit_gate.js` and `src/gate.js`, ARCHITECTURE.md §5 and the Mintlify
  verification-gates page said each rung (Stop, pre-commit, CI) was an independent catch
  layer, so the silent-miss probability fell multiplicatively. The formal synthesis withdrew
  that (§5.3, corrected 2026-09-21): the same classifier run on the same diff fires together,
  so the residual is `(1−p)(1−c_max)`, and a later rung adds catches only where it sees what
  the earlier one could not (edits after the turn, a host where the Stop hook never ran).
  Comments and docs only; no behaviour change.

## [1.0.0] - 2026-09-22

### Added

- **`forge ledger verify --fix` re-addresses pre-CRLF-fold claims.** Accepting the old
  address on read keeps such a claim alive, but it and a teammate's freshly minted copy of
  the same fact remain two entries until their bytes agree — the fork the fold exists to
  prevent. The flag moves each claim to its current address and takes its evidence and
  provenance logs with it, unioning into an existing twin instead of overwriting (the logs
  are append-only sets deduped by content hash, so union IS the merge). Idempotent.

- **TypeSafe System One (Jev) as the fast proposer.** Where forge's LLM layer asked a text
  model for a judgment that is really a classification or a yes/no — `route`'s complexity band
  and preflight's assumption gate — it can now ask Jev instead: typed `choice`/`noul` answers
  with real probability distributions and confidence in ~150ms, rather than seconds of text
  generation followed by JSON parsing. The new `src/jev.js` client follows the existing
  proposer contract exactly: opt-in (`FORGE_LLM=1` plus `TYPESAFE_API_KEY`, overridable via
  `TYPESAFE_BASE_URL`), fail-safe (any error → null → text-LLM fallback → deterministic
  rubric, and a null never changes a verdict), zero-dependency (one raw HTTPS POST through
  the child-process-fetch pattern, the key travelling via child env — never argv, never
  logged), and secret-refusing on the way out. Routing keeps its `BAND_FLOOR` reconcile and
  gains `llm.provider: "jev"` plus confidence in `forge route --json`; the assumption gate
  scores all four rubric dimensions in one batched call (free-text clarifying questions stay
  with the deterministic rubric — a System One model judges, it does not author prose).
  `test/_setup.js` now scrubs `TYPESAFE_*` so the suite stays hermetic with the key exported.

### Fixed

- **A claim minted before the CRLF fold is migrated, not deleted.** Folding `
` into
  `
` changes a claim's content address, so a claim written by an earlier version on a
  Windows checkout carried the pre-fold address in its filename and failed its own address
  check on load — `loadClaims` returned nothing for it, and `forge ledger verify` reported
  it as an id mismatch. The read path now accepts the pre-fold address as well, so the
  claim stays readable and its evidence log keeps resolving; every WRITE uses the current
  rule, so the old form dies out as claims are rewritten. Content that matches neither
  address is still refused, which is what the check is for.

- **The impact benchmark's labels are ground truth again, and the numbers they feed are
  re-measured.** Four of the six label sets in `bench/impact_cases.mjs` had gone stale against
  the source — `isStale` was missing `src/substrate.js` (an aliased import) and
  `test/atlas_resolve.test.js`, `mergeStates` was missing `src/ledger_sync.js`, `claimText`
  three files, `contentHash` four — so the published precision/recall/F1 were scored against a
  fixture that no longer described the repo. Every case is re-derived with
  `git grep -n -w -F -e <symbol> -- 'src/*' 'test/*'` with each hit read, and the per-line
  evidence (plus the deliberate comment/string-only omissions) is recorded in the fixture. A
  new test re-runs that derivation and fails the moment labels and source disagree, so this
  cannot rot silently again. `contentHash`'s documented false negative is gone: a named import
  now resolves to the exact symbol node, so `src/atlas.js` is predicted at one hop despite the
  `const hash = contentHash;` alias. **Re-measured with `npm run bench`: precision 0.17,
  recall 1.00, F1 0.29** (edited-file-only baseline recall 0.27), replacing the
  precision 0.90 / F1 0.92 this repo had published since commit `eb68ea9`. The precision is
  the transitive closure being scored against direct-only labels — `impact()` walks reverse
  dependencies transitively by default, and at one hop the six cases return their labeled
  sets — not a graph that is wrong about who calls what; `reports/benchmarks.md` now says so
  where the table is. The `TODO(impact-numbers)` markers in `README.md` and
  `reports/benchmarks.md` are resolved and removed, and the other medians those two files and
  the landing page quote are re-synced to the same run's environment block.
- **`llm.escalateTo` is no longer advisory-and-inert — a real failure now consumes it.**
  Routing recorded the tier a proposer's higher vote would have picked and deliberately did
  not apply it (whitepaper §5.1: spend more only when an EXTERNAL check fails), but nothing
  ever read it back, so the doom-loop directive told agents to "escalate ONE model tier"
  without naming one. `meterRoute()` now stores that target alongside the task ref it
  already wrote, and `diagnose()` — the one place an external check has demonstrably failed,
  `THRASH_K` recurrences of a single failure signature — names it: "escalate to opus (the
  tier routing already flagged for this task)", plus `escalateTo` in `--json`. The model's
  vote still triggers nothing on its own; it only answers *which* tier once a real failure
  has earned an escalation. Fail-safe and opt-in: `forge diagnose --task "<task>"` (and the
  `task` argument on the `forge_diagnose` MCP tool) is what supplies the join key — without
  it, or with no routing record for that exact task, the wording is unchanged.
- **A CRLF checkout no longer forks a claim id.** `canonicalize()` NFC-normalized strings but
  passed line endings through, so the same logical claim written on a Windows worktree
  (`core.autocrlf` → `\r\n`) and on a Linux one (`\n`) produced different canonical bytes and
  therefore different content addresses: one fact stored as two claims that could never merge,
  with the evidence split between them forever. Every string in a canonical document — key and
  value alike — now passes through one rule: NFC, and `\r\n` → `\n`. Deliberately left alone,
  each documented at the call site: a LONE `\r` (in the captured terminal output a `diagnosis`
  body carries, a bare carriage return is a progress-bar control character, not a line ending —
  same conservative rule as `normalizeError()`), whitespace and indentation, blank lines, case,
  and every Unicode fold beyond NFC (no NFKC: `ﬁ` stays distinct from `fi`). **Migration note:**
  a claim minted before this change whose body contains `\r\n` re-addresses, so it no longer
  matches its filename and `forge ledger verify` reports it. Such a claim was already the
  duplicate half of a pair; re-mint it (or merge from a replica) to land on the shared address.
- **`caller_fanout` is no longer dead for callers that only have a path.**
  `featuresForEdit()` asked `grepFanout()` about `edit.symbol`, so every caller holding
  only a file path — which is every hook fired on an edit event — got `grepFanout(root,
  undefined) === 0`: a module with twenty importers scored exactly like one nobody
  references. Without a symbol the feature now falls back to the FILE's own fan-out (how
  many code modules name this one as a whole word), which is the honest answer such a
  caller can have. The "who references this module" rule — module stem, directory for
  `index`/`__init__`/`mod`/`main`, tests separated from callers — now lives once in
  `cortex_features.referencingFiles()` and the pre-edit hook uses it instead of its own
  copy, so the two can never drift.
- **`forge impact` actually resolves imports.** JS/TS import specifiers were stored as raw
  strings and matched against symbol names, so `"./util.js"` could only ever resolve by its
  last dotted segment: on this repo, 3 of 502 relative import statements resolved and all
  three were spurious (`"../scripts/build-pages.mjs"` → `mjs` → `const mjs` in `doctor.js`).
  `export * from`, `export { x as y } from`, multi-line clauses, dynamic `import()` and
  `require()` were not parsed at all, and the Python pattern crossed newlines (three stacked
  `import` lines fused into a single edge to a module named `"os<newline>import
  sys<newline>from pkg"`), dropped parenthesised lists, mapped `import pkg.core as c` to
  `pkg`, and never resolved a relative import. Specifiers now resolve through one shared
  resolver in `src/scope.js` — exact file, TypeScript NodeNext `./x.js`→`x.ts`,
  extensionless, `<dir>/index.*`, and Python modules indexed by PACKAGE ROOT
  (`src/mypkg/core.py` is `mypkg.core`, so a src layout answers exactly like a flat one) —
  and an import that resolves to no file stays unresolved instead of being pinned to whatever
  shares its name. **Measured on this repo: 1,196 → 1,392 import statements seen, 679 of 679
  relative ones resolved to the exact file the specifier names, 0
  wrong (was 3, all wrong).** On a ten-importer fixture the graph now finds 10 of 10 with no
  false positives (grep finds 10 with 2), and on a seven-importer Python fixture 7 of 7 (was
  4, plus a file whose only mention is a comment).
- **The impact graph no longer reads comments and strings as code, and a call belongs to its
  function.** A comment saying `class Parser` defined a second `Parser`, which made the name
  ambiguous and silently erased the real edge from `main.js`; a string containing an import
  was an import. Every structural regex now runs on a masked copy of the source (comments and
  string/regex contents blanked, offsets and line numbers preserved), and a call is attributed
  to the innermost enclosing function/class instead of the nearest preceding `const` — so
  `const value = leaf()` inside `mid()` no longer hides `mid`'s own callers from
  `impact(leaf)`. Bare names are never resolved across languages any more (a Python
  `from impact_oracle.oracle import …` used to land on the JS `const oracle` in `eval.js`),
  local definitions are not cross-file candidates, and names imported from a package are never
  re-guessed locally, and `emit(ctx) {` inside an object is a method DEFINITION rather than
  a call to whatever unique `emit` exists elsewhere: ambiguous references dropped on this
  repo fell from 3,136 to 862, and they are now COUNTED and reported instead of vanishing
  (`impact()` returns `ambiguousRefs`, `unresolvedImports`, `capped` and `skippedFiles`, and
  `forge impact` prints them).
- **Building the graph is linear again, and the file cap counts source files.** Line numbers
  came from a `slice(0, i).split()` over the whole file per match, and every call scanned
  every node, so a 16k-line file took seconds; extraction now uses a line index and scope
  intervals: a 16k-line JavaScript file plus a 16k-line Python file build in **0.3 s, down
  from 4.9 s** on the same machine (`test/atlas_resolve.test.js` keeps it under 2.5 s). The
  20,000-file cap counted JSON and Markdown against code and was never reported; it now
  bounds source files only, docs/configs have their own bound, and a capped graph says so
  in `forge atlas build`, in `impact()` and in `forge impact`.
- **Blast radius is no longer reverse-only — the refutation's sibling and forward relations
  are ported.** `research/empirical-refutation/` diagnosed that 94.7% of real misses were
  *siblings* (A and B both depend on module C, so C's contract shift co-changes both) and
  2.1% were forward-only, but only the Python prototype was repaired; the shipped JS graph
  still walked reverse edges exclusively, so `impact(serializer.js)` reported `app.js` and not
  the `deserializer.js` that shares `wire_format.js` with it. `impact()` now runs the two
  ported relations at the replication package's FROZEN parameters (sibling: 1 forward + 1
  reverse hop, weight 0.7, bridge in-degree cap 100; forward: ≤2 hops, weight 0.5), both
  terminal — a node they reach is reported, never expanded. Every result carries its
  `relation`, `relations: ["reverse"]` reproduces the old answer exactly, and
  `analyzeDiffImpact` (MergeField) receives the same two relations as terminal edges.
- **The impact-quality numbers are re-measured, and they are not the README's.** The
  README's precision 0.90 / F1 0.92 did not reproduce at HEAD (`evalImpact` over the
  committed `bench/impact_cases.mjs` gave precision 0.341, recall 0.972, F1 0.500 there).
  With the repaired graph it gives **precision 0.094, recall 1.000, F1 0.170** with all three
  relations and **0.146 / 1.000 / 0.248** reverse-only. The labels name only DIRECT
  referencers, so every transitive dependent, every doc that mentions the symbol and every
  sibling now counts against precision — restricted to code files the reverse-only precision
  is 0.346, and restricted to one hop it is 0.830 at recall 1.000. Four of the six label sets
  are also stale (`contentHash` has nine importers in `src/` today, six are labelled), so
  these numbers under-report precision; the fixture needs relabelling before any claim rests
  on it. What the repair fixes outright: nine `src/` files (every `src/emit/*.js`, plus
  `src/taste.js`) reported **"✓ found · impacted files: 0"** while being imported —
  **now none do**. The median blast radius of a `src/` file goes from 8 files to 16
  reverse-only and 70 with the sibling relation on, which is the frozen parameters working
  as measured, not a bug: `impact(…, { relations: ["reverse"] })` is the dependents-only
  view.
- **The in-repo Python prototype is the repaired v2, not the refuted v1.**
  `research/python-prototypes/impact_oracle/oracle.py` was byte-identical to the as-shipped
  version whose claims the refutation demolished. It now carries both repairs — the src-layout
  phantom-node merge (pooled recall 0.0220 → 0.2424) and the sibling/forward traversal
  (held-out precision 0.320, recall 0.647, **F1 0.428 vs grep's 0.371**, reversing 0.042 vs
  0.437) — with the frozen parameters as module defaults, 13 new regression tests, and
  `ImpactOracle(wm, sibling_enabled=False, forward_enabled=False)` for the old behaviour.
- **`forge atlas query` shows the definition you asked for.** Results were unranked, and a
  qualified name carries the file path, so `query build` returned 30 symbols from
  `scripts/build-pages.mjs` before `function build` itself. Matches are now ranked: exact
  name, case-insensitive exact, name prefix, name substring, then path-only matches.
- **Fan-out and churn stop lying.** `grepFanout` was a substring `git grep`, so "get" counted
  every file containing "target"; it now matches whole words (`-w -F`). `gitChurn` counted the
  last 50 commits of ALL history, so a file untouched since 2015 still scored 1.0; it now
  counts commits inside a 90-day window.
- **Non-finite weights are zero, not certainty.** The MergeField `clamp01` helpers disagreed:
  `merge_impact.js` mapped any non-number to 0 while `merge_impact_adapter.js` used
  `Number(value) || 0`, which turned `Infinity` into a maximal 1.0 criticality. One shared
  helper now maps every non-finite value to 0 and still accepts numeric strings.
- **`recommend()` no longer sends a non-finite score to the most expensive tier.** Every
  comparison is false for NaN, so `recommend(NaN)` — and `±Infinity`/`undefined` — fell
  through to fable. A non-finite score now routes to the default tier (sonnet) with an
  `unknown-score` reason, logged under `FORGE_DEBUG=1`.
- **`extractJson` reads the first balanced JSON object, not everything between the first brace
  and the last.** The greedy `/\{[\s\S]*\}/` meant any reply carrying two objects, or a stray
  brace in the prose around one ("Considering the {config} object: {…}"), parsed as nothing and
  the proposal was silently dropped — for every faculty that adjudicates (routing band,
  assumption gate, impact, distill). Brace counting is now string-aware, and a candidate that
  does not parse is skipped rather than grown.
- **The gateway model map parses versions instead of matching loose digits.** A tier's reference
  tokens were `{haiku, 4, 5}`, so "claude-3-5-sonnet-20241022" scored exactly as well as
  "claude-sonnet-4-5-20250929" for the Sonnet tier — the "5" of "3-5" matched the "5" of Sonnet
  5 — and won the lexicographic tie, pointing a self-hosted gateway at a two-generation-old
  model. Consecutive version numbers collapse into one token ("3.5"), a date stamp is not a
  version, and equal scores break toward the newest model of the family.
- **`classifyIntent` reports the winning intent's confidence, not a losing neighbor's.** When two
  runner-up rows outvoted one closer row, the reported confidence was the closer row's
  similarity — evidence for the intent that lost ("what does the release script do" → `release`
  at 0.571, the `question` neighbor's score; now 0.333).
- **`knowledge_router` keeps the first-person signal it routes on.** It tokenized facts with
  intent.js's stop-set, which drops `i/my/we/our/your/their` as function words — the one thing
  separating a personal preference (recall) from a project convention. "i prefer short commit
  messages" and "the team prefers short commit messages in this repo" both scored 1.00 against
  the same recall row; now 1.00 and 0.78.
- **A null `noul` from Jev is "no answer", not a confident zero, and a choice matches the offered
  option case-insensitively.** `Number(null)` is 0, so a dimension the API returned as null read
  as "definitely unspecified" and dragged the assumption gate's completeness down; it now fails
  safe like any other garble. A `"Mid"` answer to a `{cheap, mid, premium}` choice was thrown
  away entirely; it now resolves back to the `mid` we offered (an option we never offered still
  fails safe).
- **The preflight scanners no longer read addresses, code fences and prose as code.** On the
  80-task held-out set (diagnostic only — those tasks are spent for tuning), the entities a task
  was said to reference fell from 210 files and 1,414 symbols to 42 and 388 across the 64
  well-specified tasks. Four misfires:
  - a code fence's third backtick paired with the next inline backtick, so **every word inside a
    fence became an identifier** — a broker-URL log line yielded "Setting", "up", "delayed",
    "for", "broker" — and each one then went to the substring `git grep` that feeds routing
    fan-out. Fenced blocks are stripped before the inline-code scan, and an inline span now needs
    a closing backtick run of the same length, so RST ``double`` spans stop pairing across prose;
  - URLs, markdown links and images, `N/A` and `and/or` counted as **files**
    (`example.com/issue/12`). Addresses are removed before every scan (`stripUrls`), and a bare
    slash token must look like a path — an extension, a `./ ../ ~/ /` prefix, or a trailing `/`;
  - the concreteness anchors fired on URLs, image links, contractions (`'t break it, it'`) and
    versions (`since v2.3:`). The quoted-literal anchor now refuses apostrophes inside words, the
    filename anchor needs a letter-initial extension, and the worked-value anchor needs a number
    beside an arrow, an equality or a `key: 42` colon — the filename anchor's firing rate on
    gold-ask tasks falls from 0.69 to 0.31. `e.g.` and `example:` also fire at last: their
    trailing `\b` had made them unmatchable before a space;
  - **a named code identifier was not an anchor**, so "Rename getUser to fetchUser everywhere"
    was hard-flagged as having nothing concrete to act on. It now counts as one anchor (that task
    is no longer hard-flagged; with a file path it clears the gate outright), and the
    success-criteria cue matches `\btest` rather than the "test" inside "latest".
- **With the LLM layer on, the assumption gate no longer asks just because a task names
  something the repo lacks.** In bidirectional mode `reconcileAssumption` put `hasUnresolved` in
  the ask condition itself, so it forced an ask even when the rubric proceeded and the model
  judged the task complete — a grounded rename (`clamp01` → `clampUnit`) with a background URL:
  rubric proceeds, model 0.99 → asked, path `llm-tightened` — while tighten-only mode ignored it
  entirely. The reviewer measured 63 of 64 well-specified held-out tasks tripping it. Unresolved
  entities are now a floor on _clearing_ a rubric ask only, identically in both modes (a
  rename's new name is unresolved by definition).
- **A torn ledger line no longer swallows the next record.** A process killed mid-append (or a
  union merge that dropped the trailing newline) left a final line without `\n`; the next
  `appendEvidence` was glued onto it, became one unparseable line, and vanished from every read
  while the append still returned `ok:true` — the repro showed `[run-1]` visible after
  appending `run-3`. Every ledger log append (evidence, provenance, tombstones, quarantine) now
  terminates a torn final line first: `[run-1, run-3]`, and a re-append dedupes.
- **Claim canonicalization normalizes keys before sorting them.** Keys were sorted by their raw
  spelling and NFC-normalized afterwards, so an NFD key (`e` + combining accent) sorted before
  `f` while its NFC twin sorts after it. A claim minted with such a key was written with one
  byte order and re-hashed with another on reload: `loadClaims` saw 0 claims and `verify`
  reported an id mismatch. Keys are now normalized first; the pinned ASCII fixture ids are
  unchanged.
- **An MCP tool that throws now answers with a JSON-RPC error.** `serve()` swallowed handler
  exceptions (`.catch(() => {})`), so a request whose handler threw — e.g. `forge_remember` with
  an unwritable `.forge` — never got a reply and the client waited for its own timeout. The
  server now returns `-32603` with the tool name and message, and keeps serving (the repro
  received replies for ids `[2]` before, `[2, 1]` after).
- **`forge ledger sync` no longer erases teammates' evidence from the shared ref.** A push
  wrote the pushing replica's *verified* state, so any record it had to quarantine (a `file:`
  proof only a teammate's tree has, a commit it had not fetched) vanished from
  `refs/forge/ledger` for everyone — the review's alice/bob/carol run ended with the remote
  holding 0 of alice's 1 record. A push now writes the raw remote state joined with the local
  verified state (the same semilattice merge) and verification happens only on read: the
  remote keeps the record (1), bob and carol still quarantine it locally, and a re-run is
  still a byte-level no-op.
- **Restoring a superseded fact leaves it live.** Fact claims are content-addressed and
  tombstones are permanent, so `forge remember api-base v1` → `v2` → `v1` put the restored
  value back on v1's retired id: the ledger held no live `api-base` fact at all (`list`
  went from `["api-base"]` to `[]`). A retired value is now re-asserted as the next revision
  (the lowest `rev` whose claim is not tombstoned — deterministic, so teammates converge),
  and `reconcileFacts` matches store and ledger by content instead of by rev-0 id.
- **Eq. 3 retrieval ranks by relevance again.** Five defects compounded into "the ledger
  answers the wrong question":
  - *Scope was a strict priority.* The scope weight multiplied σ from outside, and with
    a+b+g = 1 the sigmoid only spans [0.5, 0.731] — so scope decided every ranking: an
    unrelated, 400-day-old, contradicted **symbol** claim scored 0.5375 against a
    perfect-match **repo** claim's 0.3853. Scope is now a bounded term inside σ
    (`s = 0.10`, symbol−global = 0.06): the same pair now ranks 0.6815 (repo) over 0.5622.
  - *Short queries found nothing.* `rel` was MinHash over 4-token shingles, so a 2–3 word
    query was one shingle no claim contained: "auth token refresh" scored `rel` 0 against
    the auth fact and ranked it **below** an unrelated CSS fact. `rel` is now
    `max(shingle Jaccard, query-term coverage)`; the same query ranks auth first (0.713 vs
    0.589).
  - *Any two non-ASCII texts were "identical".* The tokenizer split on `[^a-z0-9]`, so
    Arabic, Chinese or Greek text became the empty token set and two empty sketches agreed
    on all 128 lanes — Jaccard 1. Tokens are now Unicode-aware (`\p{L}\p{N}\p{M}`) and an
    empty set shares nothing with anything: Arabic vs Chinese is 0, and a real Arabic
    query retrieves its Arabic fact.
  - *Contradictions counted as recent evidence.* `rec` keyed on the newest evidence of any
    polarity, so a fresh refutation RAISED a stale claim's score (0.3280 → 0.3384). `rec`
    now keys on confirmations (or the mint), and the same contradiction lowers the score.
  - *Two similarity scales in one ranking.* With a partially embedded ledger, cosine
    (0.4–0.6 for unrelated same-domain text) competed with Jaccard (≈0), so every embedded
    claim outranked every lexical one. The backend is chosen once per ranking: cosine only
    when every candidate is embedded.
  `EQ3_WEIGHTS` no longer claims to be "calibrated in P8" — P8 shipped cost evaluation, not
  a retrieval calibration; the spec (01-pcm-protocol.md §4) is updated to match the code.
- **Déjà vu is gated on relevance, not on the total score.** `DEJA_FLOOR` (0.39) was tuned on
  repo-scoped summaries, but a symbol-scoped lesson scored ≥ 0.5 for any prompt, so an
  unrelated `parseConfig` lesson surfaced on EVERY prompt — including "translate the README
  into French" (0.538). The gate is now `DEJA_REL_FLOOR` on the `rel` term (0.5: at least half
  the prompt's content words appear in the remembered task): the unrelated prompt is silent at
  day 100 and day 400, while a genuine repeat still fires.
- **Future-dated evidence no longer counts at full weight for years.** A record dated 10 years
  ahead (a skewed clock, a hand-written `t`) pinned `rec` at 1.000 and kept full val weight
  until the calendar caught up. Age is now the distance from now, so that record's `rec` is
  0.000 two years later and its val weight ≈ 0, while a one-day skew stays negligible.
- **A learned lesson stops flapping out of the injection set the next day.** One Stop-hook
  confirm put a lesson's val at exactly 0.6 against an `active` bar of 0.6, so a single day of
  decay (0.5988) demoted it: a lesson was injected on the day it was learned and never again
  (with three confirms it dropped out around day 75). Activation is now hysteretic — on at
  0.6, off below 0.55 — so one confirm keeps a lesson active for ~52 days, three for ~124, and
  a contradiction still demotes it immediately. The test that only read on the confirm day now
  reads at days 101, 130, 150 and 160.
- **Dormancy latches, and pruning is wired.** A claim refuted by a human revert (val 0.333)
  drifted back above the 0.35 dormancy floor 11 days later — with no new evidence — and
  re-entered retrieval. Dormancy now latches at the evidence event and only a later
  *confirmation* clears it; decay alone never does. `pruneToAttic` had no callers at all, so
  the spec's forgetting rule (01-pcm-protocol.md §3) was unimplemented: the new `pruneLedger`
  archives tombstoned or dormant claims that have had nothing new for 2·T, and runs at
  session end (the déjà-vu Stop write), on `ledger merge` and on `ledger sync` import.
  Nothing is deleted — the bytes move to `attic/`, every log stays, a re-import never
  un-prunes, and new evidence brings a claim back with its whole history.
- **The reuse cache's "exact" tier means the same task again.** The exact and near tiers
  compared the SHAPE-normalized spec, in which every identifier is `⟨ident⟩` — so
  "add pagination to listOrders" was served the **listUsers** artifact at tier exact,
  similarity 1, and (because the tokenizer's `\w` is ASCII-only, which erased every Arabic
  word) two unrelated Arabic specs were exact matches of each other. Artifacts now carry an
  identity key — Unicode-aware tokens, case and punctuation normalized, identifiers kept —
  which the exact and near tiers compare; the shape form still keys the adapt tier, so the
  listUsers artifact can still be offered as a starting point for listOrders, never as the
  answer. The three collision cases from the review are now misses.
- **The LSH prefilter stopped dropping three of every four adapt candidates.** The comment
  claimed "≈0.96 at J=0.8 and ≈0.17 at J=0.5" for 16 bands × 8 rows; the real figures are
  0.95 and 0.06, and at the adapt threshold J=0.6 recall was 0.24 — so once a ledger passed
  32 artifacts, most adapt-tier hits silently became misses. Banding is now 32 × 4 (0.99 at
  J=0.6, ≈1.00 at J=0.8): in the review's own harness, 67 of 67 adapt-band pairs are found
  with the prefilter active, against 39 of 67 before.
- **Goal anchoring measures the right thing, per checkpoint.** Three separate defects:
  - The per-prompt advisory compared the working diff against the **current prompt**, so
    "ok, now run the tests please" reported every changed file as goal drift. The hook now
    re-runs the check against the persisted goal (`.forge/goal.md`), and with no goal set it
    makes no drift claim at all — a prompt is not a goal.
  - The CUSUM chart was fed the **cumulative** off-goal ratio every prompt, so one static
    off-goal file alarmed by itself after three idle prompts (C = 0.32 → 0.63 → 0.95 → 1.27
    > h = 1.0). It now gets the per-checkpoint increment — the off-goal fraction of what
    actually moved since the last prompt — so idle prompts score 0 and drain the chart,
    while a file edited again scores 1 again.
  - M5 minimality ignored untracked files, which is where over-engineering lives: a 6-class,
    212-line "framework" dropped next to a one-line fix measured as 1 file, +1 line, 0
    warnings. Untracked files are now part of the measured footprint (2 files, +213 lines,
    13 new abstractions, 2 warnings) whether or not they have been `git add`ed.
- **The doom-loop signature sees the whole failure.** It hashed `tool_response.stdout` only
  and just its first 800 characters, so a stderr-only failure (jest, mocha, tsc) was never
  seen at all, and three different failures behind one long passing header shared a signature
  and were reported as a loop. It now covers stdout and stderr and the whole normalized
  output (head + tail above 64 KB). The advisory also stops claiming "different edits aren't
  fixing it" when nothing was edited between the runs.
- **`LEDGER.md` stopped conflicting in the conflict-free store.** The generated index is
  rewritten on every ledger write and each row carried `val 0.50` — a number that changes
  with the clock and with each replica's evidence — so two teammates adding one fact each got
  a merge CONFLICT in `.forge/ledger/LEDGER.md`. Rows are now stable (id, kind, the claim's
  own text), and the ledger ships its own nested `.gitattributes` marking the index
  `merge=union linguist-generated`: the review's alice/bob merge is clean.
- **The per-prompt hook stopped re-reading the whole ledger, three times.** A ledger is one
  small file per claim plus its logs (300 claims = 900 files), nothing compacted it, and the
  hooks ask for it three times per prompt (lessons, déjà vu, reuse peek). `loadState` now
  keeps a derived snapshot beside the ledger, validated by a stat-only fingerprint of every
  file's (path, size, mtime) — any external edit, git merge or prune rebuilds it from the
  files, and the cache is gitignored. Measured on a 300-claim ledger (Windows, the review's
  own harness): one `loadClaims` 619 ms → 112 ms, and the per-prompt hook path
  (ambient substrate check + déjà vu) 3026 ms → 517 ms.
- **A recorded UI interaction verdict is dated today.** `recordInteraction` defaulted to
  `t = 0` and the CLI passed no day, so every verdict landed 56 years in the past and decayed
  to nothing on arrival: five failing UI runs left the design fingerprint's val at exactly
  0.5000. They now move it to 0.3636.
- **A refuted fact stops being broadcast to every tool.** `.forge/brain`'s index is inlined
  into the emitted `AGENTS.md`, and it never asked the ledger what a fact was worth: a fact
  three CI runs had contradicted (val 0.23, dormant) was still shipped verbatim to Codex,
  Cursor, Gemini and everything else that reads `AGENTS.md`. The index now withholds facts the
  ledger has sunk below the dormancy floor, and — like the overflow pointer — says how many
  and why rather than dropping them silently. `forge_remember` also reports a refusal
  ("Not remembered — refused: looks like a secret…") instead of answering "Remembered" for a
  write the store rejected.
- **Only a real test run counts as one.** The test-command grammar matched anywhere in a
  command, so `echo "run npm test later"` and `grep -r 'jest' package.json` marked a session
  "tested" — minting a `test.run` confirm for a session that ran no tests — and `npm test ||
  true` counted as a pass because the `|| true` swallowed the exit code. A command now has to
  BE a test run (start of the command or after a shell separator) and keep its exit code.
- **CI is green again on Linux.** `global/guards/run.mjs` was committed without its
  executable bit, so `forge doctor`'s plugin-hook check (which `access(X_OK)`s every script a
  hook names) reported `warn` on Linux and failed `test/doctor.test.js` on Node 20 and 22 for
  every push since #140. Windows ignores `X_OK`, which is why the Windows job stayed green.
  The file now carries mode `100755`, like its sibling `secret-redact.mjs`.
- **The test suite is hermetic.** It inherited the developer's environment, so it was green
  in CI and red on any machine where forge was actually installed and enabled — the two
  things a maintainer does. An exported `FORGE_LLM=1` both flipped the "llm off by default"
  assertion in `test/substrate.test.js` and made the faculties fire real model calls, and a
  real `~/.forge` reached `doctor()`'s machine-scoped install check through
  `test/doctor.test.js`. Wall time was 593s with two failures. A new `test/_setup.js`,
  preloaded via `--import` into every test process, scrubs `FORGE_*`/provider env by prefix,
  sandboxes `$HOME` to a throwaway tmpdir, and forces the keyless HTTP runner instead of
  shelling out to a real `claude` binary: **0 failures in ~40s**. `test/hermetic.test.js`
  pins the scrub list against `envVarsRead()` so the two cannot drift, and fails loudly if
  anyone drops the `--import` wiring. Two assertions were wrong rather than merely leaky and
  were corrected: `doctor` asserted a global `failed === 0` to prove a local property about
  `na` rows, and a comment in `substrate` claimed no runner reaches the real CLI — the
  opposite of the truth, and the reason that file spent 85s on live calls.
- **`verify --deep` no longer claims coverage it never had.** The `residual` silent-miss
  bound multiplied `∏(1 − wⱼ)` over every lens that "ran": it used the precision-style lens
  weights as catch probabilities, multiplied checks aimed at disjoint defect classes as if
  they were independent tries at one defect, and counted lenses that ran over nothing. With
  the tests never run and an empty diff it reported **0.042** — 96% coverage from zero
  checks. Each lens now names its target class and an assumed catch probability in its own
  `catch` column; same-class lenses combine as nested checks (`1 − c_max`, review F2), a lens
  that examined no input catches nothing, and the figure is the worst class, with
  `residualByClass` in the provenance. The same case now reports **1**; a typical clean run
  reports 0.7 instead of 0.005.
- **The pre-edit risk advisory can fire.** The hook passed the predictor only the file path,
  so four of its seven features were pinned to 0 and the heuristic topped out at
  σ(−1.0) = **0.27**, below the 0.66 "high" band: the high-risk advisory could never appear.
  The hook now computes them from the repo and the edit itself — callers and tests from one
  bounded `git grep` of the module name, whether the edit rewrites an existing declaration,
  and whether any caller is in the working diff — and the advisory names the reasons. A
  hot file with ten importers, no test, and a rewritten exported signature now scores 0.91
  ("high"); the same file with a covering test and a body-only edit stays quiet. In
  `src/predictor.js`, `aucPr` now ranks tied scores as one threshold (the same data gave
  **1.0 or 0.333** depending on input order; now 0.333 either way), and the kill criteria
  no longer decide on a held-out split under 10 samples or 2 of each class (a 4-sample split
  with no positive used to disable a perfectly predictive feature) and compare AUC-PR with
  the exact chance baseline of a random ranking instead of a fixed 0.6 (pure noise at 80%
  positives passed 0.6 and let the learned model take over; a real 10%-prevalence signal
  at AP 0.33 was disabled).
- **`forge radar` rings reflect the risk they find.** The ring score was a weighted mean in
  which clean signals counted as zeros with the heaviest weights (`deprecated: false` 1.0,
  "no advisories" 0.9), so they diluted everything else: a dependency 4 majors behind with
  a 3-year-stale latest release scored **0.221 → adopt**, currency risk could never exceed
  0.255 (so "assess" was unreachable from the score), and a high-severity advisory alone
  scored 0.247 → adopt. The score is now a noisy-OR, `1 − ∏(1 − wₖ·sₖ)`, like the lesson
  and consensus scores: the same dependency scores 0.485 (trial), maximal currency risk
  0.545 and a high advisory 0.630 (both assess). Absent evidence still lands in "assess"
  through the evidence-count gate, never through the score.
- **`forge cost` counts what a session actually cost.** Without `ccusage`, the fallback
  estimate from Claude's session logs priced only `input_tokens` and `output_tokens`,
  ignoring `cache_creation_input_tokens` and `cache_read_input_tokens` (most of Claude
  Code's input), and summed every log line although Claude Code writes one response on
  several lines with the same message id. A one-message fixture logged three times
  estimated **$0.038 against $0.228**. Cache writes are now priced at 1.25× the model's
  input rate (2× for 1-hour writes) and reads at 0.1× (Anthropic's caching multipliers;
  the price table carries base rates only), and each message id counts once across all
  log files; the fixture now estimates $0.228. `forge cost --stages` stopped calling its
  composed figure a "lower bound" that "can only grow": the route factor goes negative
  when routing prices above the always-premium baseline (measuring one such stage took the
  composition from 50% to 0%). It is now labeled "measured stages only, not a bound". And it
  no longer prints "the paper measured a 62% routing saving" as context: the line marks
  the figure as refuted next to the measured −20.2% on total spend
  (`research/empirical-refutation`).
- **`forge rank` hazard counts incidents, not sessions.** The history overlay summed
  `val()` over lesson claims AND every deja session summary naming a file, but a summary
  is minted for every session, first-try successes included, and a session whose own
  tests passed carries a confirm outcome: every edit became an "incident", five ordinary
  sessions added 2.5 to a file's history, and a tested, passing session added **0.64**
  against an untested one's **0.5**. Only lesson claims (recorded mistakes) count now;
  session summaries add 0.
- **Context assembly stops a source at its 3rd optional item, and only that source.** The
  per-source diminishing-returns cut (`δ^(j−1)`, δ = 0.7, "fourth+ item from one source:
  value has decayed away") was checked after taking the item with a 0.2 floor, so it took
  **6** items before stopping, and it used `break`, which ended the fill for every source.
  The cut is now checked before taking an item, at the floor the comment describes (the
  4th item's δ³ ≈ 0.34), and skips only that source: 10 candidate facts now yield 3.
- **Non-ASCII names no longer collide, and NaN no longer propagates.** `slug()` kept only
  `[a-z0-9]`, so every non-Latin name ("مفتاح الواجهة", "数据库地址") slugged to `""` and fell
  back to the same literal — two facts with different names overwrote each other under one
  `fact` slug. It is Unicode-aware now (NFKC, letters/marks/digits of any script), with a
  short content hash for names that carry no letter or digit at all; ASCII slugs are
  unchanged. `clamp01(NaN)` returned NaN (`Math.max(0, Math.min(1, NaN))`) and poisoned
  every score it fed; it fails to 0, along with any non-numeric input. `cosine()` promised
  "never NaN" but squared components before dividing, so vectors with components ≳ 1e154
  overflowed to Infinity/Infinity = **NaN** and components ≲ 1e-162 underflowed to a false
  zero vector; it now scales each vector by its largest component, rejects non-finite
  components, and clamps the result to [-1, 1].
- **The learning loop runs in real installs again.** `cortex.sh` runs the Stop hook detached,
  as `(node … stop &)`, and a background job in a non-interactive shell gets `/dev/null` as
  stdin. So every Stop payload arrived empty, the session id fell back to `"default"`, and
  the real session was never processed. No correction episodes, lessons, contradictions or
  deja summaries were written, and `.forge/sessions/<id>.jsonl` was never cleared. The tests
  missed it because they piped into `cortex_hook_main.js` directly. The shim now reads the
  payload before detaching and pipes it into the background node. A new shim-level test
  drives `node run.mjs cortex.sh …` the way Claude Code does: before the fix the session log
  was still there 30 s after Stop; now it is consumed and `episodes.jsonl` is written in
  about 3 s, on Linux and under Git Bash on Windows.
- **Completion-gate evidence can no longer be produced by the agent alone.** The `verify`
  provenance stamp and the gate's once-per-session marker are files under `.forge/`, so a
  hand-written `{"tests":{"status":"PASS"},"codeState":…}` satisfied the gate's strong leg and
  a pre-written `<sid>.blocked` switched the gate off entirely. Both are now MAC'd with a
  machine-local key kept outside the repo (`$XDG_STATE_HOME/forgekit/evidence.key`, mode
  0600, created on first use), and an unsigned one is ignored. This is a raise, not a
  boundary: an agent with shell access can still read the key — real unforgeability needs a
  signer it cannot reach (CI, or a helper process). Three more evidence holes closed: a
  comment-only touch to a test file (`// touched`) no longer counts as test evidence (the
  added lines must contain real code), a `package.json` test script that masks its own
  failures (`node --test || true`, `|| exit 0`, `--passWithNoTests`) reports INCOMPLETE
  instead of PASS, and `forge scan`'s external scanner now ADDS to the built-in heuristic
  instead of replacing it — a clean `snyk-agent-scan` exit used to return early, so the
  signatures for `curl … | sh`, prompt injection and credential exfil never ran. `imagine`'s
  dry-run reads the runner's OWN (last) TAP summary and cross-checks the exit code.
- **The cost governor now governs.** It only wrote to stderr and exited 0, which a PreToolUse
  hook shows to nobody, so it neither capped nor informed. Past the real-spend ceiling
  (`FORGE_COST_CEILING`) it now emits `permissionDecision: "ask"` with the reason — the human
  decides — and the volume/broad-command nudges ride along as `additionalContext` instead of
  invisible stderr.
- **`forge harden` writes a deny list Claude Code actually reads.** Its sandbox block emitted
  a `credentials.deny` key that exists nowhere in Claude Code's settings schema, so the
  credential paths it "denied" were never denied. It now writes `permissions.deny` with real
  `Read(<glob>)` rules for `~/.aws`, `~/.ssh`, `~/.config/gcloud`, `~/.netrc`, `~/.npmrc` and
  `~/.git-credentials`.
- **The settings allowlist no longer auto-approves three dangerous commands.** `Bash(fd:*)`
  covered `fd -x <anything>` (arbitrary execution) and is gone; `Bash(git branch:*)` covered
  `git branch -D` and is replaced by the read-only spellings; `git branch -d/-D` and
  `git diff --output` are denied outright. (A deny rule is prefix-matched, so
  `git diff HEAD --output=…` still relies on the permission prompt — noted in the review
  follow-ups.)
- **Lockfile commits are no longer refused as leaking a secret.** The entropy leg flagged
  content-integrity digests as secrets: 100% of package-lock and yarn.lock `sha512-` hashes,
  99% of SRI `sha384-` and 88% of go.sum `h1:` hashes. The real `left-pad@1.3.0` integrity
  line was refused by the commit gate, which pushed users to `--no-verify` and switched off
  the whole scan. These digest shapes are now exempt from the entropy leg only, so format
  rules still apply. All four rows now score 0%.

### Security

- **The secret filter can no longer be made to hang.** The key-assigned branch of
  `hasSecret`/`redactSecrets` (`\b[\w-]*KEY[\w-]*…`) backtracked cubically on long runs of
  key-ish words: 6 KB of `token-token-…` took 5 s and 12 KB took 40 s. It runs on every tool
  output via the secret-redact hook, so a large output outlived the hook timeout and passed
  through unredacted. Every quantifier that could re-scan a run is now bounded; 40 KB of each
  pathological shape (`token-`, `secret_`, `password=`, `auth=`, `x://a:`, …) now takes
  under 5 ms, pinned by a timing regression test.
- **Credentials in URLs, STS keys and short or slash-bearing values are now caught and masked
  whole.** URL userinfo (`postgres://`, `mongodb+srv://`, `amqp://`, `redis://:pw@`,
  `https://oauth2:glpat-…@`), AWS `ASIA…` STS key ids, `AUTH=`/`CREDENTIALS=` env values,
  `Authorization: <scheme> <credential>` headers, GitLab `glpat-` tokens and TypeSafe
  `apikey_<40hex>_<64hex>` keys went from 0% to 100% detected and redacted in the review's
  matrix. `DB_PASSWORD=hunter2` (under 8 chars) was detected but never masked; unquoted values
  were masked only up to their first `/`, which left about 16 chars of 30% of AWS secrets
  visible. Of 2,000 random `AWS_SECRET_ACCESS_KEY=<40 base64>` lines, 1,995 are now masked
  whole, up from 1,038. The rest (about 0.2%) start with `/`, so they are read as a path. Ordinary URLs,
  `$VAR` references, kwargs like `f(password=pw)` and counters like `MAX_TOKENS=4096` are
  still left alone. `secret-redact.sh`'s shell prefilter — which decides whether the Node
  redactor runs at all — was widened to match: a short URL password has no 20-char token
  run, so the guard used to skip the scan entirely and the credential reached the
  transcript.
- **The guards parse their payload with a real JSON parser, and fail closed.** Without `jq`
  — stock Git for Windows, most minimal images — every guard fell back to a regex that cut
  the value at the first escaped quote: `echo "x"; cat .env` arrived as `echo \`, so the
  secret-read deny never fired, and `git diff -- ".env"` slipped through too (2 of this
  repo's own tests only passed on machines with jq). `printf … | grep -q` under `pipefail`
  also lost its match to SIGPIPE whenever grep exited early, so a large command silently
  stopped being checked. `protect-paths` is now a thin launcher over `protect-paths.mjs`
  (the split `secret-redact.sh` already uses): one parser, no pipelines, and an unparsable
  payload or an internal error DENIES (exit 2) instead of exiting 1, which Claude Code reads
  as a non-blocking hook error. `_guardlib.sh` and the status line read fields through the
  same parser (`guards/hookfield.mjs`), so the status line no longer collapses to
  `<dir> · <branch> · ?` without jq. The rule set also grew what the literal, case-sensitive
  substrings missed — `git reset --hard`, `git clean -f…`, `find … -delete`/`-exec rm`,
  `chmod -R`, `dd … of=`, lowercase SQL `drop table` — while the SAFE `git push
  --force-with-lease`, which the old `git push --force` substring blocked, is allowed again.
  `.aws/credentials`, `.netrc`, `.npmrc` and `.git-credentials` join the protected list, and
  protect-paths now also runs on **Read** in both hook manifests: a plugin install ships no
  `permissions.deny` block, so nothing stood between the agent and `.env` there.
  `resolveBash` no longer selects `…\Microsoft\WindowsApps\bash.exe` — the Store alias for
  the same WSL launcher, which cannot run a `C:\…` guard path, so every guard exited 127
  (fail open).
- **Session hook logs no longer store raw secrets, and `init` keeps them out of git.** The
  `prompt` and `capture` hooks appended the user's prompt and every Bash command verbatim to
  `<repo>/.forge/sessions/<id>.jsonl`. A pasted `GITHUB_TOKEN=ghp_…` or an `Authorization:
  Bearer ghp_…` curl landed on disk in the repo, and `forge init` did not gitignore the
  directory. Every string in a session event is now passed through `redactSecrets` before
  it is written (the file now holds `GITHUB_TOKEN=[REDACTED]`). `init` also writes a nested
  `.forge/.gitignore` that ignores `sessions/` without touching the user's root
  `.gitignore`, so a deliberately committed ledger or `decisions.md` stays committable.
- **The commit gate's secret scan now fails closed.** It read `git diff --cached` with the
  default 1 MiB `execFileSync` buffer. On overflow the diff became `""`, so a `ghp_` leak
  alone was refused (exit 1), but the same leak staged next to a 1.5 MB file was "allowed"
  (exit 0). A repo-controlled `.gitattributes` `-diff`/`binary` marking or a `textconv`
  driver also hid the added lines. The scan now diffs with `--text --no-ext-diff
  --no-textconv` and a 256 MiB buffer. If that fails, it retries one file at a time, and any
  file git still cannot diff is refused as unscanned instead of passed. All three bypasses
  are refused now. The Stop gate's code-state fingerprint (`computeCodeState`) had the same
  1 MiB blind spot: a stale `verify` PASS survived a later code edit whenever the pending
  diff was over 1 MiB. It now hashes a `--binary` diff with the same buffer, and it reports
  "cannot bind" rather than hashing `""` when git fails.

### Security

- **Only evidence forge actually resolved can lift a claim into the trusted band.** Any
  untyped or unknown-prefix ref counted as fully resolved: `lgtm`, `session:x`, `ci:1`,
  `human:claude@yes` and `git:HEAD` each took one confirm to val 0.643, and
  `forge reuse mint --ref lgtm` was served at tier exact. "Resolved" now means forge
  re-derived the pointer — a `git:` object id, resolved at every append/import gate and
  re-resolved by `verify` — plus the two bridge pointers on their own bridge oracle
  (`episode:` ↔ `cortex.episode`, `legacy:` ↔ `legacy.import`). Everything else, including
  `ci:`/`human:` locators and symbolic `git:HEAD`, counts at format strength and is capped at
  0.55, below the 0.6 serving floor; an `agent:` identity never supplies human-family evidence
  at full strength. The review's three hand-written `human.accept` lines now reach 0.55
  instead of 0.787. What remains: a hand-written line citing a real commit sha still counts —
  closing that needs signed evidence (key infrastructure), which this release does not add.
- **Serving a cached artifact no longer confirms it.** Every `forge reuse` hit appended a
  passing `graph.reval` confirm, so ten daily serves moved val from 0.643 to 0.864 and an
  artifact stayed served (0.710, tier exact) after two failing test runs. Only a failed
  revalidation is written back (as a contradiction); ten serves now append nothing, and the
  same two failing runs drop it to 0.427 — a miss. `mintArtifact` reports `serves` from the
  confidence the proof actually earns instead of "some evidence was passed".
- **The MCP ledger write tools act as the agent and only propose.** `forge_ledger_ratify` and
  `forge_ledger_retract` ran under the human's `gitAuthor()`; retract accepted any 2-character
  prefix and permanently tombstoned the first sorted match, and ratify's description promised a
  confidence change it never made. Both are now stamped `agent:mcp`. Ratify mints a distinct
  agent-proposed decision (never deduped into, or counted as, a human ratification) and says it
  changes no confidence. Retract requires one exact 64-character id and records a
  pending-retraction proposal — the claim stays live, val unchanged — shown by `forge_ledger_query`,
  `forge ledger stats` and `forge ledger show` until a human runs `forge ledger retract`, which
  now also requires the full id. `getClaimByPrefix` refuses an ambiguous prefix instead of
  returning the first sorted match.

### Documentation

- **The formal synthesis's Theorem D is restated as a bound, and its definitions are fixed.**
  An external deep review (2026-09-21) found the theorem circular as stated (its criterion,
  `P(≥1 miss) → 1`, also condemns the composed system) and its Eq. 5 dependent on an
  independence the design contradicts — the same classifier at Stop, pre-commit and CI fires
  together, so the product understates the residual 400× in the paper's own example. The
  synthesis and the extended preprint now state the residual as `(1 − p)·P(no check fires |
  miss)` with Fréchet bounds, bound it by `ε` over an explicit `(p, q)` region, show that the
  gate's catch rate depends on agent behaviour (a STATE.md touch passes it), and fix the `lfp`
  definition, the oracle-vs-`Δ*` "identity", T4, T5, T6 (A7 gains the catch-all arm
  `src/knowledge_router.js` already has), A1's type error, A3's definitional I1, the use of
  Rice's theorem, the faculty table (now matching the whitepaper), Eq. 1 vs the amnesia
  equation, the Appendix A tally (9 confirmed, not 8), and the "independent" convergence.
  Priority is conceded in both, as the refutation paper already did. Each paper ends with a
  dated Corrections section quoting the original wording; `crosswalk.json`/`.md` and the
  formal-synthesis README follow.
- **The refutation paper's statistics are tightened without changing the refutation.** The
  LaTeX source and the extended preprint now report repository-cluster bootstrap intervals
  (every ground-truth pair is mirrored and files cluster in nine repositories: oracle
  precision [0.15, 0.91], recall [0.0005, 0.052], seed 1234), no longer claim the repaired
  oracle beats grep (3/3 repositories, sign-test p = 0.125, pytest 71% of pairs, relation
  choice made on all nine repositories), say that the gold labels and the "independent" second
  pass are one model, add cost per judged-correct output ($1.06 vs $1.76, from 6 and 3 of 64),
  qualify the "96.8% fixable" ceiling, correct the calibration paragraph (bins 27/5/28/4/16,
  ECE 0.103 or 0.078, p = 0.028), and explain 801 labelled vs 759 evaluated files.
- **The whitepaper marks its refuted prototype claims in place.** A status banner, inline
  markers and a Corrections section cover the impact oracle's "never misses an affected file"
  (recall 0.022 on real repositories), the 62.1% routing saving (−20.2% held out), M1's
  worst-case cost (the sum over every tier, not cheap + premium), Eq. 1 vs M2, and a misquoted
  Faros figure ("31.3% _more_ PRs merged with no review"). The docs copy and
  `docs/cognitive-substrate/deliverable-package.md` (which had no refutation banner) match.
- **The README and docs stop calling the impact graph conservative and stop presenting 62% as
  a saving.** The graph can miss affected files, so it is now described as approximate and
  an empty impact set as "unknown". The README's impact-quality row (precision 0.90, F1 0.92)
  did not reproduce — `evalImpact` gives precision 0.34, recall 0.97, F1 0.50 at `1a82388` —
  and is marked for re-measurement after the impact-graph fix; the prototype rows now sit
  beside their real-data refutations (recall 0.022; −20.2%). `docs/GUIDE.md`,
  `reports/cost-eval.md`, `reports/benchmarks.md`, the substrate-v2 plan, the Mintlify intro,
  the capability map and `source/substrate.json`'s limits say the same.
- **`research/recompute_corrections.py` re-derives every corrected number.** Standard-library
  Python (it includes a minimal Parquet reader), fixed seeds printed beside each result, run
  against the extracted replication package. PDFs built from the corrected sources could not
  be rebuilt here and are flagged as predating the corrections.
- `CLAUDE.md`: Biome 2.5.2 → 2.5.5 (matching the pin), "600+ tests" → "1000+", and the lint
  command `npx biome check` → `npm run check` — the documented command fails outright, since
  the npx package is `@biomejs/biome`, not `biome`.
- **OpenClaw is a first-class emit target — the compiler's tenth tool.** Instructions need
  no new file: OpenClaw appends the execution folder's `AGENTS.md` after its configured
  agent-workspace files as project context, so the canonical source reaches it the same way
  it reaches Codex, Cursor and Copilot. MCP is registered explicitly rather than silently:
  OpenClaw keeps its server registry in the user's global `~/.openclaw/openclaw.json`, which
  Forge will not write to, so `forge sync` emits an OpenClaw-shaped fragment to
  `.openclaw/mcp.json` and reports the exact enabling command
  (`openclaw mcp add forge-cortex --command forge --arg cortex-mcp`). `.openclaw/mcp.json`
  is an ordinary managed MCP target: idempotent, per-target ownership (a same-name server
  you wrote yourself is preserved until `--adopt`), and reversible via
  `forge integrations remove`. `openclaw` is now selectable and auto-detected by
  `forge tools`. The packaged `.codex-plugin/plugin.json`, `global/tools`, and `.mcp.json`
  also form an OpenClaw-compatible Codex bundle: installing a trusted checkout or packed
  archive loads Forge's skills and bundle-scoped MCP server without the config-only path's
  manual global registration. Forge installs **nothing** into OpenClaw's hook system — there
  are no ambient guards there, only `AGENTS.md`/skill text and the MCP tools.

### Changed

- **`forge impact` stays focused by default; the wide walk is `--all-relations`.** The
  sibling and forward relations ported from the empirical refutation's repaired oracle are
  a recall instrument: on this repo they take the median answer from 15 files to 78 of ~450
  (max 196) — recall 1.00, precision 0.09 — and the substrate's 25-file blast threshold
  would trip on almost every edit. `impact()` now walks reverse dependencies only unless a
  caller passes `relations` (`IMPACT_RELATIONS` for all three), and `forge impact
  --all-relations` asks for the wide walk. The relations themselves are unchanged, at their
  frozen parameters; only which ones run by default changed.

- **`forge route calibrate` stops calling itself "outcome-calibrated routing".** Nothing in it
  comes from an outcome: the fixture is 24 hand-written task phrases with hand-assigned
  complexities, and forge records nothing that could replace them — a `route` metrics event
  carries the chosen tier and a task hash, a `verify` event carries pass/fail with no task
  reference, so no (task, tier, outcome) triple exists to calibrate on. `calibratedComplexity`
  has no caller in `src/` either: routing keeps the raw rubric. The command heading and closing
  note, the module comment, GUIDE and ROADMAP now say so plainly, and joining a routed task's
  tier to its verification result is named as open work rather than implied to be done.
- **The routing rubric stops counting a task's length twice and stops matching on one shared
  word.** Both defects pushed every real task into the middle: on the reviewer's 80-task
  held-out set the router sent 54 of 64 well-specified tasks to mid and reached premium once.
  - **Length was weighted twice** — by the repo facet's `size` signal and again by the rubric's
    `struct.length` — and both saturate on real issue prose, so every long task was floored near
    the cheap/mid line whatever it was about. The later of the two (`struct.length`, added with
    the k-NN rubric) is gone; `rubricSignals().lengthTokens` stays as an informational field.
  - **One shared word counted as a match.** 146 of 167 top-3 matches rested on a single token,
    and against an exemplar whose whole footprint is that token (`fix a typo` → `{typo}`) the
    overlap coefficient reads 1.00 — full confidence in a coincidence, which is how "resolve the
    deadlock between the comment writer and the comment indexer threads" matched "add a comment"
    at 1.00 and routed mid. A neighbor now has to share `RUBRIC.minShared` (2) grams, or the
    task's whole footprint when the task is shorter than that, so "fix the deadlock" still
    matches its exemplar.
  - `rubric.band` now uses recommend()'s own cutoffs (0.25 / 0.55) instead of a second, different
    pair (0.3 / 0.6) that disagreed with the tier actually routed.
  - **No exemplar labels into the fable band any more.** The architectural rows carried y = 0.85,
    at or above the 0.8 fable cutoff, while `model_tiers` puts "architecture, cross-module
    refactor, novel algorithms" on Opus and keeps Fable for research-grade reasoning; they are
    0.78 now (the held-out calibration fixture too).
  - Diagnostic on the spent 80-task set (**not** an evaluation — those tasks are burnt for
    tuning, and routing was measured in an empty repo): exact tier accuracy 0.344 → 0.453, the
    predicted distribution 9/54/1 → 38/25/1 (cheap/mid/premium), and premium-vs-rest AUROC
    0.652 → 0.753. Premium recall is still 0 of 17: the toy exemplar bank has no vocabulary for
    real premium issue prose, which needs a real-issue bank and a **new** held-out set.
- **Model routing reconciles the proposer's band with the deterministic band, not a point
  score.** `routeTask` compared the proposer's band floor (cheap 0.15 / mid 0.40 / premium 0.65)
  against the deterministic point score, so even a vote that _agreed_ moved the score: a
  fable-level task (0.887) with a Jev "premium" vote dropped to 0.688 (opus) and was logged
  `llm-lowered`; a sonnet-level 0.431 with a "mid" vote became 0.400, also "lowered"; a 0.087
  prime-finder with a "cheap" vote was "raised" to 0.150; and a premium vote could never yield
  fable. The new pure `reconcileRoute` maps the score to its band first (recommend()'s 0.25 /
  0.55 cutoffs): the same band keeps the score (`llm-agreed`), a lower band moves it to that
  band's ceiling. The old one-band point bound (`routingBand`, removed from
  `source/substrate.json`) also blocked correct down-routes from the top of a band — a 0.508
  task with a 0.95 "cheap" vote stayed on sonnet; it now lands on haiku. The strong-signal floor
  (`signalFloor`) still holds a confidently-hard topic at mid.
- **A proposer vote moves the tier only when the proposer is confident.** Jev's confidence was
  logged but ignored — a 0.34 and a 1.00 "cheap" vote routed identically. A vote now needs
  p(band) (Jev's probability on the voted band, else its confidence) ≥ `minConfidence`:
  `ROUTE_MIN_CONFIDENCE` = 0.8, configurable per call and as `llm.minConfidence` in
  `source/substrate.json`. 0.8 is an a-priori conservative default, **not fit to data** — it
  has to be chosen on fresh labelled tasks (the frozen 80-task held-out set is spent). The
  text-LLM proposer reports no probability, so by default it can no longer move the tier
  (`llm-overruled`, `overruledBy: "confidence"`); `minConfidence: 0` switches the gate off.
- **The proposer can no longer raise the tier.** The "free raise" escalated on the model's own
  assessment, which whitepaper §5.1 rules out (escalate "only if an external check on the
  output fails … never by the model's self-assessment"). A higher-band vote is now recorded,
  not applied: path `llm-raise-deferred` — a prime finder with a 0.99 "premium" vote stays on
  haiku instead of jumping to opus. The would-be tier is reported as `llm.escalateTo`, an
  **advisory recommendation only**: nothing in forge acts on it automatically (no
  verifier-failure path consumes it yet). Route provenance is now `deterministic` / `llm-agreed` / `llm-lowered` /
  `llm-raise-deferred` / `llm-overruled` (+ `overruledBy`); `llm-raised` is gone.
- **The assumption gate compares the proposer's verdict with the rubric's instead of clipping
  one scale onto the other.** The rubric's logistic saturates on real issues (median
  completeness 0.983 on the 80 held-out tasks) while Jev's mean noul is a probability centred on
  0.5, and the reconcile bounded Jev to det ± 0.25 — so Jev almost never had a say: with a stub
  proposer at Jev's reported median (0.29), 74 of 80 reconciled values sat exactly at det − 0.25
  (the reviewer measured 71 of 79 with real Jev answers, which are not in the repo). Each reading
  is now judged against its own threshold (the rubric's `askThreshold`, the proposer's 0.5); the
  proposer flips the verdict only when it holds its own with probability ≥ `minConfidence`
  (`GATE_MIN_CONFIDENCE` = 0.8 — a-priori, not fit to data; same `llm.minConfidence` key as
  routing); tightening is always allowed, and clearing still stops at the no-anchor and
  repo-grounding floors. The reported `completeness`/`risk` stay the rubric's, the proposer's
  reading is `provenance.proposalCompleteness`, and a blocked flip is `llm-overruled` with
  `overruledBy`. The `band` key is gone from `source/substrate.json`.
- **MCP targets address their server bucket by dotted key path.** `emit/mcp.js` resolved a
  single top-level key (`mcpServers`, `servers`, `context_servers`); OpenClaw nests its
  registry under `mcp.servers`. The resolver now walks a path, creating missing objects only
  on write, and refuses to restructure a file where any step already holds a non-object —
  that shape is the user's and is reported, never rewritten.

### Fixed

- **Claude Code hooks no longer fail on Windows with `spawn bash ENOENT`.** Every Forge hook
  (the plugin's `hooks/hooks.json`, the `settings.template.json` that `forge init` merges, the
  statusline) was exec form with `command: "bash"`. Exec-form hooks are spawned directly — no
  shell, a plain `PATH` lookup — and a default Git for Windows install puts `git.exe` on `PATH`
  (`Git\cmd`) but not `bash.exe` (`Git\bin`, `Git\usr\bin`), so SessionStart and every other
  guard died before it ran. Hooks now spawn the zero-dependency launcher
  `global/guards/run.mjs` (`node run.mjs <guard>.sh …`), which resolves bash — `FORGE_BASH`,
  `CLAUDE_CODE_GIT_BASH_PATH`, the Git install that owns `git` on `PATH`, the standard install
  dirs, then `PATH` (never WSL's System32 `bash.exe`) — and passes stdin, stdout and the exit
  code through verbatim, so exit-2 blocks are unchanged. POSIX behaviour is identical (`bash`
  from `PATH`). `forge init` heals a Forge-owned install left in the old `bash` spelling in
  place — ownership manifest included, so uninstall still reverses it — while a hand-written
  hook at a Forge path is left alone; `forge doctor` shows the resolved bash, flags stale hooks
  (`--fix` re-merges) and requires the launcher as an install asset. Regression tests cover the
  Windows default-install `PATH` shape, paths with spaces on both OSes, the no-bash failure
  mode (exit 1 + hint, never a fabricated block) and the packed archive.
- **`protect-paths` no longer dies (exit 1, fail-open) on machines without `jq`.** Its grep
  fallback ran under `set -euo pipefail`, so a payload missing `command` (every Write/Edit) or
  `file_path` (every Bash call) aborted the guard before it could decide — invisible in CI, where
  `jq` is preinstalled, but the norm on Windows. The fallback now yields an empty field exactly
  like the `jq` branch, so `.env` writes and destructive `rm` are blocked without `jq`.

## [0.32.1] - 2026-08-22

### Fixed

- **Plugin load: dropped the duplicate `hooks` declaration from the manifest.** Claude Code
  loads the standard `hooks/hooks.json` automatically, so `manifest.hooks` pointing at that
  same path registered it twice and the loader rejected the entire plugin
  (`Duplicate hooks file detected`) — taking every skill, agent, guard and the `forge-cortex`
  MCP server down with it. `manifest.hooks` is for additional hook files only; the guards are
  unchanged and still load from the plugin root. A regression test in `test/channels.test.js`
  now fails if the standard path is ever re-declared.

## [0.32.0] - 2026-08-14

### Changed

- **Landing: source-owned technical instrument.** Replaced the delayed, externally pinned
  SPA shell with an immediate-rendering, dependency-free editorial page. The new experience
  explains memory, foresight, and guardrails through accessible interactive panels; shows
  repository-measured evidence and beta limits; and keeps version, palette, install paths,
  responsive behavior, and runtime ownership inside the repository’s existing quality gates.

## [0.31.0] - 2026-08-07

### Changed

- **impact: hazard-aware blast radius.** `forge impact` now fuses the code graph with
  team memory: SCC-aware propagation (from `forge rank` Tarjan cycles — a change to any
  file in a circular-dependency cluster impacts all co-members) and a data-driven
  threshold derived from PageRank centrality and ledger incident history
  (`effectiveThreshold = base / (1 + hazard)`). No new constants — every enhancement is
  computed from infrastructure already in the codebase. `--basic` flag reverts to the
  fixed-threshold mode for comparison.

### Fixed

- **docs: refresh post-v0.30.0 staleness.** ARCHITECTURE.md repo layout and component
  descriptions updated for `rank.js`, `collide.js`, `docs_render.js`; mintlify Labs card
  now lists `rank` and `collide`; mermaid theme normalization extended to `.mdx` files
  (6 mintlify diagrams were rendering in default blue/grey instead of the branded palette).

## [0.30.0] - 2026-08-07

### Added

- **`forge collide` — the parallel-session conflict radar.** The everyday failure of
  the agent-fleet era: two sessions silently edit the same or import-coupled files and
  the conflict surfaces at merge time. Every session already mints a ledger summary of
  the files it touched, and those claims team-merge over plain git — so "who else was
  just in here?" is a pure read: no server, no presence protocol, no new storage.
  `risk = 1 − ∏(1 − recᵢ × strengthᵢ)` over recent foreign sessions (7-day recency
  half-life — a collision is about now; direct hits count full, 1-hop import
  neighbors half). Advisory and fail-open, with hook-minted absolute paths
  relativized like the rank join. Exposed to every MCP-capable agent as
  `collide_check` (21 MCP tools — counts and tables regenerated by
  `forge docs render`).

### Fixed

- **The rank hazard join now matches production claims.** Hook-minted lessons and
  session summaries store raw tool-input paths (absolute), while the atlas speaks
  repo-relative POSIX — so `forge rank`'s history overlay never matched a real claim
  and hazard silently degenerated to bare centrality (found by adversarial review,
  reproduced against the live mint pipeline). `history()` now relativizes claim paths
  against the repo root; a test pins the production path shape.
- **`beliefDiff` tombstone edge cases.** A claim minted _and_ retracted inside the
  diff window was reported as "appeared" with a live confidence — a retracted claim
  presented as a current belief; it now lands in `retired` (`from:null, to:null`).
  Claims already tombstoned before the window no longer surface as strengthened or
  weakened through pure decay — dead beliefs don't move.
- **`forge rank` determinism and hardening.** All orderings now use locale-independent
  codepoint comparison (`localeCompare` consults ICU tables that differ across
  machines, contradicting the module's own cross-machine guarantee); `centrality()`
  counts a duplicated atlas node id once, as PageRank already did; a corrupt
  `.forge/atlas.json` degrades to the `built:false` hint instead of crashing the CLI
  and hanging the `rank_code` MCP call; a negative `--top` clamps instead of slicing
  in from the end of the list.
- **Temporal CLI guards.** `forge ledger diff` refuses a `<since>` after `<until>`
  (previously printed silently inverted classes), and `ledger at`/`diff` reject
  impossible calendar dates (`2026-02-31`) instead of letting `Date.parse` roll them
  into a day nobody asked about.

## [0.29.0] - 2026-08-07

### Added

- **`forge docs render` — the docs that can write themselves, do.** `docs check` could
  only detect drift; every fix was still a human hand-editing tables across five files.
  The derivable doc surfaces are now generated from the same registries the check reads,
  into marker-managed blocks (the `reports/benchmarks.md` pattern): the README command
  table and the GUIDE group map from `COMMANDS`/`GROUPS`, the MCP tool table from the
  `TOOLS` registry, every literal "N MCP tools" count phrase across all six files it
  lives in, one shared mermaid theme derived from `brand.json` (change the brand,
  re-render, every diagram in every tracked markdown file re-themes), and a repo map in
  `ARCHITECTURE.md` drawn from the live import graph. `docs check` gains a `render`
  reconciler: a stale registry-derived block is an error whose message is the fix
  (`forge docs render`); tree-derived output (repo map, diagram theme) warns without
  failing unrelated PRs.

## [0.28.0] - 2026-08-07

### Added

- **`forge rank` — load-bearing code, measured.** Weighted PageRank centrality over the
  atlas graph (same edge priors as the blast-radius search), Tarjan SCC circular-import
  clusters over the directed import graph, and Hopcroft–Tarjan articulation points
  (chokepoint files whose removal splits the repo) — joined with each file's
  past-incident history from the evidence ledger: `hazard = centrality × (1 + history)`,
  where history is the val()-weighted sum of lesson and session claims naming the file.
  Structurally central code that has already bitten the team outranks equally central
  code that hasn't. Deterministic end to end (sorted-order power iteration, no
  `Math.random`), fail-open without a ledger, and exposed to every MCP-capable agent as
  the `rank_code` tool (20 MCP tools total).

- **Time-travel for team memory.** The ledger is append-only and every record carries
  its day, so past beliefs are recomputable — now they are queryable: `forge ledger at
<date>` rebuilds any past day's state with `val` scored by that day's evidence and
  clock, and `forge ledger diff <since> [<until>]` classifies what changed between two
  days (appeared / retired / strengthened / weakened, with an epsilon floor). Pure
  functions in the ledger core (`stateAt` is a lattice morphism — it commutes with the
  CRDT merge, property-tested), no new storage, no clock reads.
- **Merkle state root.** `stateRoot()` hashes the whole verified ledger state into one
  permutation-invariant root (leaf per claim over its logs in canonical order, shard
  hashes over the store's 2-hex-char prefixes — so divergence is localized, not just
  detected). Surfaced as `forge ledger root` and used by `ledger sync --dir` as an
  O(state-read) already-in-sync fast path — the ref transport's tree-SHA equality
  already was this check; now the dir transport has one too.

### Changed

- **`impact()` dequeues in O(1).** The label-correcting blast-radius search in
  `src/atlas.js` drained its frontier with `queue.shift()` — O(n) per dequeue on V8
  arrays, quadratic on large frontiers — and rescanned the start set with a linear
  `includes` inside the inner loop. The queue now drains through an index pointer and
  the start set is a `Set`; processing order, and therefore every reported confidence,
  is unchanged. A new test pins the max-product diamond semantics any future rewrite
  must preserve.
- **Lesson glob compilation is memoized.** `matchScore` runs per (lesson × file) on
  every PreToolUse hook and recompiled the same trigger-glob RegExp each time; compiled
  globs are now cached in a module-level map bounded by the distinct globs in the
  lesson set.
## [0.27.4] - 2026-08-04

### Fixed

- **CI is green again.** Every pipeline had been red since the landing page became a built
  SPA: `test/pages.test.js` still enforced the hand-authored static contract against
  `landing/index.html`, failing six assertions and taking the test matrix, the quality
  gate, and both install-smoke jobs down with it. The landing shell now carries inline
  critical CSS with the `brand.json` colors and system font stack — so it paints branded
  before the jsDelivr chunks arrive instead of flashing white — plus the missing
  `apple-touch-icon` and a `theme-color` that matches the palette. The type/space scale
  assertion is now scoped to the generated status page, and the landing metric and version
  assertions verify what is stated rather than requiring it; color and font-stack parity
  stay enforced across both surfaces. A new test pins integrity of the jsDelivr asset
  references, which nothing had been checking — `static.yml` never deploys
  `landing/assets/`, so a stale pin 404s the whole site on a green build.

## [0.27.3] - 2026-07-21

### Changed

- **The Mintlify docs site is now English-only.** The five hand-maintained translated
  locale trees (`ar`, `hi`, `cn`, `zh-CN`, `zh-Hans`) were removed — keeping parallel prose
  in sync by hand was the main source of documentation drift. `mintlify/docs.json` now
  declares a single `en` language. To bring translations back, enable Mintlify's built-in
  AI auto-localization instead of hand-maintaining parallel `.mdx` trees; the setup steps
  are documented in `mintlify/README.md`. The English-scoped `checkMintlify` drift guard is
  unaffected.

## [0.27.2] - 2026-07-21

### Changed

- **Synced the docs with the code and added a Mintlify drift guard.** `docs check` now has
  a `checkMintlify` reconciler that reconciles the hand-maintained Mintlify site
  (`mintlify/`) against the code the same way it already does README/GUIDE — every command
  must be documented on the English site as `forge <name>`, and any env var the site names
  must be one the code reads (no phantom vars). The site had drifted (it was outside the
  reconciler) and is now brought current: the `FORGE_LEDGER_ONLY` default flip, the
  `problem-solver` skill, the `forge dash` write guard, the `Labs (experimental)` command
  group, and version-neutral wording (was "new in v0.19"). Top-level docs updated too —
  `ROADMAP.md` (legacy-store retirement now shipped), a stale `forge cortex` sample in
  `docs/GUIDE.md`, and the `ARCHITECTURE.md` tool map (adds `problem-solver`/`catchup`).
  `mintlify/docs.json` locale code `zh` aligned with its `zh-CN/` directory.

## [0.27.1] - 2026-07-21

### Security

- **The `forge dash` write routes are now guarded against CSRF and DNS-rebinding.** The two
  human-driven writes (`POST /api/ratify`, `POST /api/retract`) on the unauthenticated
  localhost dashboard now refuse (`403`) any request whose `Host` header isn't the loopback
  interface (a domain rebound to 127.0.0.1) or whose browser `Origin` isn't the loopback
  origin (a cross-site POST). Native clients that send no `Origin` still work; a deliberate
  non-loopback `--host` bind opts out. Covered by new regression tests.

## [0.27.0] - 2026-07-20

### Changed

- **The PCM ledger is now the DEFAULT memory store — the legacy-store migration is
  finished (M2).** `FORGE_LEDGER_ONLY` defaults on: `.forge/lessons/*.md` and recall/brain
  fact files are no longer written, and every read (cortex injection/summary, routing,
  `recall`/`brain`, the pre-edit advisory, doctor) materializes from the ledger. The ledger
  has been the convergent dual-write store since P1, so existing memory is already there;
  `forge ledger import` back-fills any pre-ledger history. `FORGE_LEDGER_ONLY=0` is a
  one-release escape hatch that restores the legacy file store. The legacy-store test
  suites are pinned to the escape hatch; a new end-to-end test exercises the full
  create→confirm→promote learning loop under the default.

### Fixed

- **Closed the ledger-only read/write gaps the default flip exposed (M2).** `brain.remember`
  (and the `forge_remember` MCP tool) now shadow the fact into the ledger, so a fact is no
  longer lost when no file is written; `cortex_features.featuresForEdit` and the distill
  loop's lesson lookup now read the merged ledger view instead of the legacy file store.

## [0.26.2] - 2026-07-20

### Fixed

- **`reconcileFacts` no longer risks wiping memory under `FORGE_LEDGER_ONLY` (M2).** The
  reconcile heuristic tombstones any author-owned fact claim with no backing file; under
  ledger-only there are no fact files, so it would have tombstoned every fact. It is now a
  guarded no-op when ledger-only is active (the ledger IS the store then — there is nothing
  to reconcile against). Covered by a new no-data-loss regression test.

## [0.26.1] - 2026-07-20

### Changed

- **Split the `run()` god-function in `src/cli.js` into a dispatch table (H3).** The former
  ~2,420-line `run()` (a flat 44-branch `if (cmd === …)` chain) is now a ~44-line dispatcher
  that looks the command up in a `HANDLERS` map; each command is an independently navigable,
  independently mergeable module-scope `async` handler. Behavior is byte-identical — the same
  argv in, the same stdout/stderr/exit-code out (the full spawn-based suite is unchanged and
  green) — the pre-dispatch middleware (`--help` interception, first-run hint, `cortex-mcp`),
  the unknown-command fallback, `process.exitCode` error model, and the main-module import
  guard are all preserved.

## [0.26.0] - 2026-07-20

### Added

- **`problem-solver` skill** (`global/tools/problem-solver/`) — a universal,
  framework-driven problem-solving cycle (Clarify → Classify → Diagnose → Generate →
  Decide → Act & Sustain) bundled through the plugin's `skills` directory. Ships a
  frameworks reference (5 Whys, Fishbone, First Principles, TRIZ, Cynefin, DMAIC/PDCA/8D/
  A3, Design Thinking, Nine Windows, weighted decision matrix, pre-mortem), a disciplines
  reference, and a fill-in canvas.

### Fixed

- **Broke a static ESM import cycle in the memory layer.** `lessons_store.js`,
  `cortex_distill.js`, and `adjudicate.js` now import `hasSecret` directly from its
  source of truth (`secrets.js`) instead of a re-export in `recall.js`, eliminating the
  `recall → ledger_read → lessons_store → recall` cycle (a top-level-eval TDZ hazard).
- **Importing the package as a library no longer executes the CLI.** The package root
  (`exports["."] → src/cli.js`) now guards its top-level `run()` behind a main-module
  check (symlink-resolving, so the global `forge` bin still runs), and exports `run`.
  `package.json` `sideEffects` now names the CLI entry accurately instead of `false`.
- **Hermetic tests.** `test/init.test.js` no longer merges hook guards into the
  developer's real `~/.claude/settings.json`; it pins `settingsPath` under a temp dir.
- **The unimplemented-command stub now exits non-zero**, so scripts and CI no longer
  read a "not wired yet" command as success.
- Replaced literal NUL bytes with `\0` escapes in the `reuse.js`/`diagnose.js`
  content-hash separators (byte-identical runtime output; the source is now clean text).

### Changed

- **The release pipeline is now closed-loop.** `release.yml` gains a per-ref
  `concurrency` group, makes npm publish and GitHub Release creation idempotent (so a
  wedged release can simply be re-run), and adds a final verification step that FAILS the
  job when a tag did not produce both a GitHub Release and (when publishing is enabled) an
  npm version — the silent wedge that orphaned tags v0.22.2/v0.23.2/v0.24.0 now surfaces
  as a red, notified failure. See `docs/RELEASING.md` for the orphan-tag note.
- **Consolidated duplicated helpers into `src/util.js`.** One read-only, trimmed `git()`
  replaces four byte-identical copies (session/handoff/update/docs_check); a shared
  `readJsonSafe()` replaces the ledger store's local copy. Deliberately-divergent git
  helpers (verify.js's arg order + `FORGE_DEBUG` logging; the un-trimmed docs-sync
  variants) are documented rather than force-merged.
- Removed the dead `plugin` entry from `package.json` `files`, the vestigial
  `.gitlab-ci.yml`, and the dangling `@AGENTS.md` import in `CLAUDE.md`; fixed the
  off-palette Codex plugin `brandColor`.
- **Broke a layering cycle in `repo_config.js`.** `applyPrimaryTool` no longer reaches
  back into the sync compiler via a dynamic `import("./sync.js")`; the sync runner is now
  injected by the caller (`cli.js`), keeping the config leaf acyclic.
- `ledger_store.js`'s `git cat-file -e` ref resolver now passes `--` before the ref
  (defense in depth against a ref that begins with `-`).
- **Refreshed `ARCHITECTURE.md`** for the v0.20–v0.24 modules that were missing from the
  reference: `commit_gate` (`forge precommit`), `consensus` (`forge verify --deep`),
  `knowledge_router`, `deja`, and `docs_impact` (`forge docs impact`).

## [0.25.0] - 2026-07-20

### Changed

- **Landing + status pages: token-driven fluid type scale and spacing scale.**
  `src/brand.js` now computes a fluid `clamp()` type scale (`--fs-n2`…`--fs-7`) and a
  4px-base spacing scale (`--sp-1`…`--sp-24`) from a formula, the same way it already
  derived the color palette from `brand.json`. `landing/index.html` and the generated
  status page (`scripts/build-pages.mjs`) now consume these tokens for every
  font-size/margin/padding/gap instead of hand-picked pixel values; `test/pages.test.js`
  enforces that both surfaces stay in lockstep with the formula. `forge uicheck design`
  now reports the landing page's spacing values 100% on-grid (previously 96% on an
  inconsistent 2px base).

## [0.24.0] - 2026-07-20

### Added

- **`forge docs impact` — a reusable documentation-impact graph.** Where `docs check`
  reconciles a fixed list of registries and `docs sync` scans a diff for raw identifiers,
  `docs impact` answers the general question the project kept forgetting: _"I changed X —
  which documented surfaces mention X and are now potentially stale?"_ It works in three
  data-driven stages: (1) a pluggable extractor registry derives the **typed** entities
  the project documents (command names, CLI flags, `FORGE_*` env vars, MCP tool names,
  exported symbols, brand tokens, the version, `package.json` fields) from their canonical
  sources — reusing `docs_check`'s `envVarsRead`/`srcFiles` and the `COMMANDS`/`TOOLS`
  registries; (2) a word-boundary- and code-fence-aware scan of every doc surface (all
  tracked `*.md`, `CITATION.cff`, the plugin manifests, the landing page, `package.json`)
  builds an inverted index entity → `file:line`; (3) an impact query maps the entities a
  git diff changed to every doc location that references them, ranked by confidence.
  Advisory by default (`--strict` exits non-zero for CI); `--since <ref>`, `--staged`,
  `--min-confidence <n>`, and `--json` flags; `docs check` prints a one-line advisory
  pointing here when the working tree touched a documented entity. New `src/docs_impact.js`.

## [0.23.2] - 2026-07-20

### Fixed

- **Windows path portability (Git Bash CI).** Several subsystems compared or emitted paths
  with the OS-native separator or as raw filesystem paths, which broke on Windows where
  `path.relative`/`join` yield `\` and drive letters look like URL schemes:
  - `atlas` and `scope` now normalize every repo-relative path to POSIX (`/`) before using
    it as a graph node id, cache key, or comparison target, so impact/decompose/graph
    results match on Windows (a no-op on Linux/macOS). A shared `toPosix` helper lives in
    `src/util.js`.
  - `uicheck` visual target resolution no longer mistakes a Windows drive-letter path
    (`C:\…`) for an unsupported URL scheme, so local files render and the playwright-absent
    path still degrades to a clean skip.
  - `init` writes hook/statusline commands into `settings.json` in POSIX form. `bash`
    (Git Bash) treats `\` as an escape, so a native Windows path would corrupt the command;
    ownership/dedup matching normalizes separators too, keeping merges idempotent.
  - The `secret-redact` guard imports `src/secrets.js` via a `file://` URL instead of a raw
    path, so the Node redactor no longer degrades to a silent no-op on Windows.
  - `imagine`'s sandboxed dry-run attributes per-file pass/fail by comparing paths in POSIX
    form, and `build-pages` tolerates CRLF when parsing the changelog for the status page.

## [0.23.1] - 2026-07-19

### Fixed

- **`forge imagine --dry-run` per-file attribution on macOS.** `dryRun()` matched node
  `--test`'s realpath'd `location:` diagnostics against a raw `mkdtemp` worktree path; on
  platforms where `tmpdir()` is itself a symlink (macOS: `/var`→`/private/var`,
  `/tmp`→`/private/tmp`) the two never matched, so the pass/fail-per-file breakdown was
  silently dropped. The worktree root is now canonicalized with `realpathSync` before
  comparison (a no-op on Linux). The CI smoke matrix now runs the full unit suite on
  `macos-latest`, which surfaced this.

## [0.23.0] - 2026-07-19

### Security

- **PostToolUse redaction now honors the structured-output contract (CR-01).** Built-in
  tools (Bash, Read, Grep, …) return structured objects, and Claude Code ignores an
  `updatedToolOutput` whose shape doesn't match the original — the previous redactor
  stringified objects, so its replacement was silently discarded and the unredacted
  output stayed visible. Redaction is now recursive and type-preserving: strings are
  redacted in place, arrays/objects keep their exact keys and structure, non-string
  leaves pass through untouched, and an unchanged response emits no rewrite. Tests now
  cover Bash-shaped, Grep-shaped, and nested structured responses.
- **Strict mode is honest and actually propagates (CR-02).** The shell wrapper no longer
  swallows the redactor's exit status with an unconditional `exit 0` — a strict-mode
  (`FORGE_GUARD_STRICT=1`) degradation now reaches Claude as exit 2. Documentation and
  comments no longer claim strict mode "blocks": PostToolUse fires after the tool ran, so
  exit 2 is surfaced stderr feedback, not enforcement — blocking belongs to the
  PreToolUse guard. A wrapper-level regression test drives the real `secret-redact.sh`.
- **Guard blocks shell writes to protected paths (HI-06).** The PreToolUse guard now blocks
  writes/mutations to protected paths (`.env`, keys, `secrets/`, `.ssh/`) via redirections and
  truncations (`> .env`, `: > .env`), `tee`, `sed -i`, `cp`/`mv`/`install`, and `dd of=`, not
  just reads. Interpreter-driven writes (`python -c`, `node -e`) remain out of scope and are
  documented as such — this is defence in depth, not a sandbox.
- **Hardened git secret-reader detection (HI-07).** Reader detection now sees through wrappers
  and global options (`env`/`command`/`VAR=val` prefixes, `/usr/bin/git`, `-C`/`--no-pager`/`-c`/
  `--git-dir`/`--work-tree`) and covers `git blame`/`show-index`/`bundle`.
- **Broader hook tool coverage (HI-08).** The protect-paths PreToolUse matcher now includes
  `NotebookEdit`, and the secret-redact PostToolUse matcher includes `WebFetch`, `NotebookEdit`,
  and MCP tools (`mcp__.*`); the settings template and plugin manifest stay in sync.

### Fixed

- **`forge verify` runs every detected suite (HI-01).** A polyglot repo where a passing Node
  suite hid a failing or unexecuted pytest suite no longer reports PASS — every detected
  executable suite runs, and a non-executable or missing one makes the overall result
  INCOMPLETE. Per-suite `executed`/`notExecuted` detail is recorded.
- **Verification is bound to the final code state (HI-02).** Provenance records a `codeState`
  fingerprint (git HEAD + a hash of working/staged/untracked changes); the completion gate only
  counts a `forge verify` PASS as evidence when that fingerprint still matches at Stop, so code
  edited _after_ verification no longer passes on a stale stamp.
- **Completion gate detects edits to pre-dirty files (HI-03).** The session baseline stores a
  content fingerprint per already-dirty file, so further edits to it during the session are seen
  instead of hidden by its start-of-session dirty state.
- **A changed test file is no longer proof (HI-04).** A deleted or empty test file no longer
  satisfies the code-change evidence requirement; the test leg needs a substantive (existing,
  non-empty) test file or a code-state-bound verify PASS.
- **Honest spawn and metrics classification (ME-01, ME-02).** Spawn failures (missing binary,
  permission/exec-format errors, signal kills, timeout) are reported INCOMPLETE rather than a
  false test FAIL — only a real non-zero exit counts as FAIL; deep-verify metrics no longer
  count NOT_CONFIGURED/INCOMPLETE runs as a pass. Provenance records `gitAvailable` so a failure
  to detect changed files is never reported as a clean tree (ME-04).
- **Ownership-safe settings uninstall (HI-05).** The settings merge records an `_forgeOwned`
  manifest of exactly what it added (permissions genuinely absent before, hook guard-identities,
  statusLine, `$schema`); `forge init --remove-settings` reverses only those, never a user-owned
  entry that predates Forge. Ownership is path-aware, so a user's custom hook that merely shares
  a basename with a Forge hook is never claimed or removed; a legacy scan seeds the manifest for
  pre-manifest installs.
- **Init aborts on profile-persistence failure (HI-09).** When `forge init --profile` can't
  persist because `.forge/forge.config.json` is corrupt, init now aborts before sync,
  `.gitattributes`, and the settings merge — zero side effects — instead of continuing and
  reporting the error afterward.
- **Safer installer transactions (HI-10).** `install.sh` backs up a user-owned symlink at a
  destination instead of silently replacing it, and stops (`Uninstall INCOMPLETE`, non-zero)
  rather than removing assets that settings hooks still reference when settings cleanup fails.
- **Verification surfaces monorepo suites (ME-03).** `detectStack()` now reports `workspaces`
  (declared workspace globs) and `packageRoots` (nested package roots found via a bounded,
  capped scan), so a root test command can no longer silently claim to cover a whole
  npm/pnpm/Turborepo/Maven/Gradle/Python monorepo.
- **Evidence resolution strength gates confidence (ME-05).** `ci:`/`human:`/`file:` refs are
  format- and existence-checked, and unresolved pointers like `test:<id>` or a non-existent
  `file:` path can no longer lift a claim's confidence into the trusted/serving band; a
  resolvable git-ref confirmation still counts exactly as before.
- **Secret-bearing ledger metadata is refused (ME-06).** Secret-shaped evidence refs, authors,
  tombstone reasons, and provenance metadata are refused before they can be written to the
  ledger — the same detector already applied to claim content — and quarantined records are
  stored redacted.
- **Trusted quarantine identity (ME-07).** Quarantine keys rejected records by a trusted content
  hash instead of the record's own (attacker-controllable) hash, so distinct forgeries sharing a
  fake hash are both retained and malformed lines with no hash are captured instead of dropped.
- **Per-target MCP ownership and atomic add/remove (ME-08, ME-10).** Adoption is tracked per
  `{server, target}`, so adopting a same-name server for one tool never authorizes overwriting
  another tool's entry (legacy `adopted: [name]` still honored and migrated); `integrations add`
  records nothing on a partial emit and `remove` keeps the entry (reporting an incomplete
  transaction) if any target cleanup fails, so config and disk never drift silently.
- **Divergent registry-name MCP entries preserved (ME-09).** A user's own MCP server sharing a
  built-in name (e.g. `forge-cortex`) is no longer overwritten without explicit `--adopt`.
- **Validated MCP names and safe serialization (ME-11).** Managed server names must match
  `^[a-z0-9][a-z0-9_-]{0,63}$`, `foo`/`forge-foo` Continue-file collisions are rejected before
  any write, and command strings are quoted safely into YAML and TOML.
- **Non-object JSON is treated as corrupt (ME-12).** Repo config and global settings now reject
  valid-but-non-object JSON (`null`, `[]`, `"x"`, `42`) as corrupt instead of silently
  overwriting it, preserving the original bytes.
- **Crash-safe config writes (ME-13).** `forge.config.json` writes take a timestamped backup and
  go through a temp file + atomic rename.
- **Complete tool list (ME-14).** `roo` is now a selectable primary tool, and
  aider/continue/windsurf/roo are auto-detected from their on-disk markers, reconciling
  `forge tools` with the MCP emit targets.
- **Functional doctor health probes (ME-15, ME-16, ME-17, ME-18).** `forge doctor` validates the
  actual Forge hook wiring against the template (not just the `_forge` marker), verifies
  `~/.forge` is a symlink/dir whose required guard assets resolve (catching plain-file shadows
  and dangling links), runs a real redactor self-test instead of trusting Node's presence, and
  records a partial `--fix` sync (nested `action:"error"` rows) as a failed repair.
- **Explicit PARTIAL sync status (ME-19).** `forge sync` returns and reports an aggregate status;
  if any target fails mid-run the result is `PARTIAL` and `sync`/`init` say so and exit non-zero
  instead of implying every tool is configured.
- **Fail-safe legacy rules (ME-20).** A corrupt legacy `.forge/rules.json` no longer aborts
  `forge sync` — it warns once, falls back to default rules, and leaves the file's bytes intact.
- **Exact gitattributes rule detection (ME-21).** The ledger union-merge rule is detected by its
  exact active line, so a comment mentioning `.forge/ledger/` no longer suppresses the real rule.

### Changed

- **Disclose the global settings merge before it happens (ME-22).** `forge init` now prints the
  global `~/.claude/settings.json` merge disclosure before the merge mutates the file, not after.

- **Hooks install in exec form (ME-23).** Hooks and the statusline now use Claude Code's exec
  form (`"command": "bash", "args": [...]`) instead of a shell string, so a guard path containing
  spaces works with no quoting — removing the shell-quoting hazard the earlier RA-12 fix worked
  around. Upgrades are seamless: an existing install written in the old shell-string form (or the
  `${CLAUDE_PLUGIN_ROOT}` plugin spelling) is deduped by guard identity and healed in place to
  exec form on the next merge, and ownership tracking / uninstall are form-agnostic — so a
  re-install never duplicates a hook and uninstall still reverses exactly Forge's own additions.

- **Honest positioning (ME-24).** README no longer claims "one brain for every AI coding
  agent", "enforced guardrails", or that every task passes a deterministic gate: automatic
  hooks are Claude Code-specific (advisory by default, enforcement opt-in via
  `FORGE_ENFORCE=1`), other tools receive shared instructions and MCP tools, and
  guardrails are described as defence in depth, not a security sandbox.

## [0.22.1] - 2026-07-18

### Changed

- **Only real profiles (RA-14).** `forge init --profile` now accepts `minimal` and
  `standard` only — the former `web-app`/`backend-service`/`library`/`regulated` names
  were always aliases of the full pack (sync only ever branched on `minimal`) and are now
  deprecated aliases of `standard`: accepted with a deprecation warning, stored as
  `standard`, and a legacy name already stored in an existing config still syncs as
  standard (with a one-time warning). New exported `validateProfile()` maps legacy names
  before any side effect.
- **Honest wording (RA-22, RA-23, RA-24).** package.json's description now says what
  ships — shared memory, impact analysis, and guardrail hooks emitted as native config —
  instead of "the cognitive substrate every frozen model is missing". README's loop intro
  now states that the automatic pre-action check is Claude Code hooks (advisory by
  default, enforcement opt-in via `FORGE_ENFORCE=1`) while other tools receive
  instructions and MCP tools to invoke; the comparison table now claims what the ledger
  does today — evidence must name a known oracle and a typed, format-checked reference at
  append time — rather than implying stored evidence is re-verified on load.

### Security

- **Git read-command bypasses closed (RA-05).** The `protect-paths` guard now classifies
  `git diff`, `git stash`, `git cat-file`, `git archive`, and `git grep` as content
  readers, closing the secret-file read path via git plumbing (`git diff -- .env`,
  `git cat-file -p HEAD:.env`, `git archive HEAD .env`). The settings template moves
  `Bash(git stash:*)` from allow to ask: `git stash show -p` can dump stashed secret
  content with no path token for the guard to match, so the permission prompt is the
  only defense there.
- **Secret redactor no longer fails silently (RA-06).** Any redaction failure prints a
  visible `secret redaction DEGRADED` warning to stderr, and new `FORGE_GUARD_STRICT=1`
  escalates degraded redaction to a blocking exit instead of passing unredacted output
  through.

### Fixed

- **`forge verify --deep` can no longer pass when nothing ran (RA-01).** Deep `ok` now
  requires the core tests status to be PASS in addition to the lens consensus; the
  result, provenance, and metrics carry an additive four-state `status`
  (PASS/FAIL/INCOMPLETE/NOT_CONFIGURED), and a repo with no configured verifier exits 1
  with `NOT VERIFIED` instead of printing PASS.
- **`forge verify` executes the detected runner (RA-08).** pnpm/yarn/bun repos spawn
  their own package manager instead of a hardcoded `npm test`; pytest runs directly;
  non-executable detections (go/cargo/mvn/gradle/dotnet/rspec/phpunit) or a missing
  binary report an honest INCOMPLETE naming the real command. `detectStack()` gains a
  structured `testRunners` field (`{bin, args, label}`) alongside the unchanged
  `testCommands` strings; npx-based runners are report-only and never executed.
- **CLI verify output distinguishes all four states (RA-09).** `BLOCKED` is reserved for
  a runner that actually failed; anything that never completed prints `NOT VERIFIED`
  (still exit 1) instead of the misleading "tests failing".
- **Ledger log lines are hash-verified at read time (RA-02).** `readLog()` recomputes
  every record's content hash and drops forged/corrupt lines (evidence lines must also
  be valid outcomes), so a hand-edited log line can no longer move `val()`. Imports and
  merges no longer bypass validation: imported evidence goes through the full append
  gate (oracle/ref checks including `git:` resolution against the destination repo), and
  rejected records are quarantined as sealed audit lines under `quarantine/<claimId>.log`
  with a `quarantined` count surfaced by `forge ledger merge`. `validOutcome()` rejects
  typed-but-empty refs (e.g. `git:`), matching append-time validation.
- **Stale ambient atlas is no longer authoritative (RA-07).** When the atlas is stale and
  a hook can't rebuild it, impact, impacted files, and predicted tests are dropped rather
  than silently computed from stale data; renderers say "impact unavailable" without a
  contradicting test list, and `FORGE_ENFORCE=1` never hard-blocks on a stale blast
  radius.
- **Completion gate enforces real obligations (RA-10).** Code changes now owe test
  evidence — a test file moved with the change or a fresh passing `forge verify` run — in
  addition to docs/state; a handoff alone no longer satisfies the gate for code
  (config-only changes keep the lighter docs-or-handoff bar). Kill switch, block-once,
  and fail-open behavior are unchanged.
- **Doctor honesty (RA-19, RA-20).** A missing atlas reports subsystem health
  `UNAVAILABLE` (new neutral `na` status) instead of `ACTIVE`, and `doctor --fix`
  records a repair that returns an error object (e.g. `mergeSettings` refusing a corrupt
  file) as failed with the reason instead of successful.
- **Settings failures propagate (RA-04).** `forge init` fails (exit 1, stderr) when the
  settings merge is refused or errors, and `install.sh` reports `Install INCOMPLETE` and
  exits 1 instead of printing `Done.` when hooks weren't wired.
- **Hook paths are shell-quoted (RA-12).** Hook and statusline commands merged into
  `~/.claude/settings.json` single-quote the package path, so installs under a path
  containing spaces work; old unquoted entries dedupe against and are upgraded to the
  quoted form on re-merge.
- **Invalid profile aborts before side effects (RA-13).** An invalid
  `forge init --profile` value no longer leaves a partial repo scaffold, `.forge/` write,
  or settings merge behind.
- **Reversible settings uninstall (RA-11, RA-17, RA-18).** New
  `forge init --remove-settings` (also run by `install.sh --uninstall`) reverses the
  settings merge — template-shaped hooks/permissions/statusline and the `_forge` marker
  are removed with a backup, user entries untouched. The installer header now tells the
  truth about the global, reversible merge, announces it before merging, and gains
  `--no-settings` to skip it.
- **MCP emitters are no longer destructive (RA-03).** Installed integrations are recorded
  in `.forge/forge.config.json` (`mcp.integrations`), and `forge sync` and
  `forge integrations add` both emit the same full managed set — the sync/add/sync
  oscillation that deleted each other's servers is gone.
- **MCP configs respect ownership (RA-21).** Continue gets one forge-marked YAML per
  managed server (the legacy combined file is migrated away only when provably forge's),
  Codex servers live in `# forge:managed:<name>` blocks refreshed by byte-compare, and a
  same-name JSON entry the user configured is never overwritten — it is reported with an
  `--adopt` hint instead. New `forge integrations remove <name>` reverses an add,
  deleting only forge-owned entries, blocks, and files; running it twice is a no-op.
- **Stop-hook auto-sync detects body drift (RA-16).** Auto-sync now byte-compares
  `AGENTS.md` against the exact content sync would write instead of trusting the embedded
  marker hash, so a hand-edited body with an intact marker is repaired.
- **Repo config consolidated; malformed JSON fails loudly (RA-15).** `src/repo_config.js`
  is now the single per-repo config module: `readForgeConfig`/`writeForgeConfig` operate
  on the unified `.forge/forge.config.json` (unknown keys round-trip through writes),
  migration-read the legacy `.forge/config.json` (`primaryTool`/`tools`; the unified file
  wins on key conflicts, the legacy file is left in place), and never silently discard
  corrupt JSON — reads warn once per process on stderr and report the corrupt path, and
  writers (`forge init --profile`, `forge tools <name>`) refuse to overwrite an
  unparseable config instead of replacing it with defaults. `forge sync` still fail-opens
  to default rules on a corrupt config but surfaces a warning in its report.

## [0.22.0] - 2026-07-17

### Fixed (audit remediation)

- **Onboarding & state safety.** `forge init` no longer silently replaces a
  present-but-unparseable `~/.claude/settings.json` (it refuses and preserves the
  original), backs the file up before changing it, and writes atomically
  (temp + rename). Hook/statusline commands now resolve to the installed package
  (`~/.forge/…` → `<pkg>/global/…`) so npm-global installs don't reference an
  unmaterialized `~/.forge`. Personal recall moved to the XDG state dir instead of
  the source tree; `install.sh` separates read-only assets from mutable state,
  migrates any `global/recall/facts`, and no longer routes path ops through `eval`.
- **Security defaults.** Removed broad default Bash read allows
  (`cat`/`head`/`tail`/`rg`/`git show`/`git log`) so secret-file reads prompt
  instead of auto-approving, and moved dependency installs (`npm ci`/`npm install`/…)
  to `ask`. `protect-paths` now blocks reading a protected path via Bash
  (e.g. `cat .env`, `git show HEAD:.env`). Secret redaction is reimplemented in Node
  (`secret-redact.mjs`) with no `jq` dependency and prints a visible DEGRADED warning
  rather than silently no-op'ing; `forge doctor` treats missing `node` as a failure.
- **Managed-file integrity.** `writeIfChanged` and `forge doctor` now compare the full
  file body against the canonical source instead of trusting the embedded `forge:sync`
  marker, so a hand-edited managed file (`AGENTS.md`, etc.) with an intact marker is
  detected and restored on `forge sync` (P0-08).
- **Third-party MCP is opt-in.** `context7` is no longer installed by default; `forge
init` wires only forge's own server. New `forge integrations` command adds an optional
  server (e.g. `context7`) after showing its package, network behaviour, and the files it
  touches, writing only with `--yes` (P0-06). MCP emitters now refresh a drifted
  forge-owned entry instead of leaving a stale one (user servers untouched).
- **Core correctness.** Atlas staleness is inventory-aware (a new/removed file now
  invalidates the graph), and `forge impact`/`substrate` report "impact unavailable" on a
  stale/missing atlas instead of presenting 0 impacted files as trustworthy (P0-07).
  `forge verify` returns `PASS | FAIL | INCOMPLETE | NOT_CONFIGURED` (never "pass" when no
  verifier ran), drives real test commands off the stack detector, and includes untracked
  files in provenance (P0-09). Ledger evidence refs are validated — a typed `git:<sha>`
  ref must resolve before it can affect confidence (P0-10).
- **Effective-date pricing.** Model prices support scheduled `{effectiveFrom,
effectiveUntil}` windows resolved by `priceOf(model, date)`; Sonnet 5 now carries its
  $2/$10 introductory rate (through 2026-08-31) and the $3/$15 successor, and `forge route`
  shows the current effective price (P0-12).
- **Release integrity.** A reusable `quality-gate` workflow (tests, Biome, typecheck,
  ShellCheck, zero-dep assertion, version-drift, docs check, `npm pack`) is now required by
  CI, the version bump, and the release — a tag/publish can no longer proceed on `npm test`
  alone while other gates fail (P0-11).
- **Honest claims & wording.** Dropped scanner "ok to install" certification language
  (S-01); renamed `P(defect)`→`defectRiskScore` and `residual`→`remainingUncheckedWeight`
  in output; reframed the preflight score as a heuristic; qualified "proof-carrying
  memory" as evidence-referenced and "zero-config" as guided/low-configuration across the
  docs; added a beta status block and per-benchmark sample sizes.

### Added / changed (product)

- **Policy profiles & repo config.** `forge init --profile minimal|standard|web-app|
backend-service|library|regulated` writes `.forge/forge.config.json`; the `minimal`
  profile emits only the five core-safety rules instead of the full engineering pack
  (P1-02). `forge.config.json` gives explicit override semantics — `profile`,
  `disableSections` (drop by id/title), and `rules` (append) with deterministic order
  (P1-03).
- **Change-obligation guidance.** The completion gate now spells out change-type
  obligations (code → docs + a test, config → config docs; test-only owes nothing) so it
  points at the right artifact instead of accepting any doc/state touch as done (P1-05).
- **Subsystem health.** `forge doctor` reports each key subsystem (secret-redaction,
  guards, atlas, managed-config, pricing) in a standard `ACTIVE|DEGRADED|UNAVAILABLE|
FAILED` vocabulary so a degraded control stays visible (P1-06).
- **Help grouping.** Experimental commands are grouped under "Labs (experimental)" in
  `forge --help`, separating the core reliability loop from experiments (P1-01).
- **UI rule.** Replaced the "make chain-of-thought visible" AI-UX rule with safe-rationale
  guidance (assumptions, tool actions, sources, verification evidence — no hidden reasoning
  traces) (P1-04).

## [0.21.1] - 2026-07-17

### Fixed

- **`forge deja` could never fire.** `DEJA_FLOOR` was 0.55, above the ~0.42 ceiling
  `retrieve()` can produce for a repo-scoped `summary` claim (the σ term is < 0.73 and the
  0.6 repo scope-weight caps it), so the anti-repetition advisory was a permanent silent
  no-op. Recalibrated to 0.39 — inside the real band (unrelated ≈0.34, identical ≈0.42) —
  with an end-to-end test that drives `recordSessionSummary` → `dejaAdvisory` so the floor
  can't drift out of range again.
- **`forge harden` crashed in a linked worktree/submodule.** `.git` is a _file_ there, not
  a directory, so `mkdirSync('.git/hooks')` threw `ENOTDIR` and aborted the whole command.
  The hooks dir is now resolved via `git rev-parse --git-path hooks`.
- **`forge ledger sync` could silently skip a push to a new/pruned remote.** The idempotence
  check compared against a _stale local_ `refs/<cli>/ledger` left from a prior remote; a
  remote lacking the ref was reported `upToDate` without ever receiving the ledger. It now
  only trusts the short-circuit when the fetch actually found the ref on this remote.
- **`forge verify --deep` evidence base could diverge.** `added` fell back to `--cached`
  but `changedFiles` did not, so the structural lenses (impact/docsdrift) went silent on a
  base whose worktree matches HEAD while the index differs. `changedFiles` now mirrors the
  same fallback.
- **Cortex halt metrics were always "pass".** The preflight hook read `result.gate?.halted`,
  a field `substrateCheck()` never returns, so the cost dashboard's halt-rate was
  permanently zero. It now reads the real signal (`assumption.shouldAsk`).
- **`forge radar` usage misattribution.** A dep whose name is a `name.`-prefix of another
  (`lodash` vs `lodash.debounce`) could steal the other's import count via a first-match
  break in alphabetical order; names are now matched most-specific-first.
- **`forge precommit` diff-header parse.** An added content line beginning with `++ `
  rendered as `+++ ` and was misread as a file header (dropping that line, mis-attributing
  the rest); the parser now tracks hunk state so headers are only matched before the `@@`.

## [0.21.0] - 2026-07-17

### Added

- **Per-command help + word forms.** `forge <command> --help` / `-h` now works for
  every command (intercepted centrally in the dispatcher, no longer silently dropped),
  alongside the word forms `forge help [command]` and `forge version`. Help renders from
  the same `COMMANDS` table the docs check reconciles: entries may now be a plain summary
  string OR a rich `{summary, usage, flags, examples, env}` object (both coexist; the
  high-traffic commands are migrated), read through new `commandSummary`/`commandHelp`
  helpers. An unknown command now suggests the nearest match ("did you mean …?") via a
  character-bigram `suggest()` over the existing `setOverlap` similarity.
- **`forge doctor --fix` — one-command auto-repair.** Each safely fixable finding now
  carries a repair that reuses an existing idempotent function: missing
  hooks/permissions in `~/.claude/settings.json` → `mergeSettings`, a missing ledger
  union-merge rule → `ensureLedgerGitattributes`, a missing/stale `AGENTS.md` → `sync`,
  and non-executable guards → `chmod +x`. `forge doctor --fix` runs the repairs, prints a
  `repairs:` block, then re-checks; a second run is a clean no-op. Unsafe findings
  (provider keys, MCP count, pricing, gateway) stay report-only. The `node` check is now
  reconciled with `package.json` engines (`>=20`): fail below 18, warn on 18–19, ok on 20+.
- **Zero-config settings wiring + first-run hint.** `forge init --settings-only`
  runs only the idempotent, `_forge`-marker-guarded settings merge (hooks +
  permissions into `~/.claude/settings.json`) with no repo emit, and `install.sh`
  now calls it instead of printing a block to paste by hand (honoring `--dry-run`).
  When a real command runs before settings are forge-managed, one tip line to stderr
  points at `forge init` / `forge doctor --fix`; it is stateless, self-silences once
  init runs, and `FORGE_NO_HINT=1` mutes it.
- **`forge tools` — primary-tool config + auto-gitignore for secondary-tool artifacts.**
  A repo that only uses one agent no longer has to track every other tool's emitted
  files. `forge tools <name>` records the primary tool in `.forge/config.json` and writes
  a marked, reversible block into `.gitignore` (`# forge:gitignore:begin … :end`, managed
  by `src/gitignore.js`) that ignores exactly the NON-primary emit targets — computed from
  `sync()`'s own report rows, so the block always matches what Forge emits. User lines,
  the shared `AGENTS.md`, and the primary tool's own files are never touched. `forge tools`
  shows the detected/primary tool (auto-detected from which agent folder exists, mirroring
  provider detection) and what's gitignored; `forge tools --reset` clears the config and
  strips only the block. Opt-in — plain `forge sync` never writes `.gitignore`.
- **`forge dash` first-run clarity.** `dashData` now reports a `meta.empty` /
  `meta.forgeDir` signal (true when `.forge/` holds no ledger claims and no metrics
  events), and the dashboard shows a plain-language empty-state banner ("No data in
  .forge/ yet — run `forge sync`, then work a session") plus a `?` legend that
  explains what every panel means in one sentence. Display-only — the append-only
  ratify/retract writes are unchanged.
- **Web session-start install hook.** `.claude/hooks/session-start.sh` (wired into the
  repo's `SessionStart` hooks alongside the existing recall/cortex context hooks) makes
  Claude Code on the web ready to lint and test: synchronous, idempotent, gated on
  `CLAUDE_CODE_REMOTE=true` (a no-op locally), and it skips the install entirely when the
  dev toolchain is already resolvable.

## [0.20.0] - 2026-07-17

### Added

- **`forge know` — the A7 knowledge-router.** Total routing (formal-synthesis
  Theorem T6) of any fact to its storage home: exemplar k-NN over a labeled bank
  (`src/knowledge_router.js`) picks among claude-md / rule / skill / state /
  decision / ledger-fact / recall; below-confidence facts fall back to the ledger
  (provenance `fallback`) instead of being dropped. Append-only homes are written
  directly (decide log, repo-ledger fact claim, personal recall store), curated
  files get advice naming the right command, secrets are refused before dispatch,
  and `--dry-run`/`--json` route without writing. Distilled Cortex lessons that
  read like decisions or durable facts auto-route to those homes (fail-open).
- **Commit-level gate rung (`forge precommit`).** The gate lattice's middle rung
  (turn ⊂ commit ⊂ PR): `src/commit_gate.js` classifies staged files with the same
  registry-derived classifier as the Stop gate (code staged with no doc/state artifact
  → finding) and runs the built-in secret detector over staged added lines as a
  gitleaks fallback. `FORGE_COMMIT_GATE` sets the mode (`warn` default · `block` ·
  `0` kill switch); a detected secret blocks in every mode. `forge harden` now installs
  a pre-commit hook that runs gitleaks when present, then the commit gate — and never
  clobbers a user-authored hook (writes `pre-commit.forge` beside it instead).
- **Pin/downgrade via `update --to <version>`.** New `applyUpdateTo` in
  `src/update.js`: for a git checkout it fetches tags, verifies the release tag
  exists (unknown version → honest miss, never a throw), and detached-checkouts
  the tag with a note on how to return to latest; npm-global installs get the
  exact `npm i -g <pkg>@<version>` instruction instead.
- **Multi-lens verification consensus.** `forge verify --deep` (new `src/consensus.js`)
  runs a LENSES table over the diff — tests, unknown symbols, unreviewed impact
  radius, docs drift, secrets in added lines, spec-lock drift, plus an optional
  `--llm` majority-of-3 reviewer panel — and aggregates noisy-OR
  `P(defect)=1−∏(1−wᵢsᵢ)` with the same cross-family gate as the lesson miner: a
  lone structural signal (or the model reviewer alone) never blocks; a failing test
  suite or a leaked secret blocks solo. Findings extend `.forge/provenance.json`
  with per-lens evidence and the Theorem-D residual `∏(1−cⱼ)` over the lenses that
  ran, and each run appends one `stage:"verify"` metrics record.
- **`forge radar` — dependency-currency rings (I4 verified currency).** New zero-dep
  `src/radar.js` reads this repo's Node manifests, probes the registry (injectable
  `fetchImpl`; metadata + bulk advisories; 4s timeout) and classifies every dependency
  into an adopt/trial/assess/hold ring from _evidence_ — staleness (540-day half-life),
  major-version lag, severity-weighted advisories, deprecation; atlas usage is stakes,
  not risk. Deprecated or a critical advisory → `hold`; fewer than two verified evidence
  kinds → `assess` (never adopt on absence). Cached at `.forge/radar.json`
  (`FORGE_RADAR_TTL_H`, default 24h); `--offline` serves the stale cache or fails
  honestly; `--refresh` re-probes; `--json` for tooling. A network scan records I4
  evidence into the ledger (`currency:<dep>` facts, supersede semantics) plus a metrics
  line, and the pre-edit hook surfaces a cache-only advisory when a file imports a `hold`
  dependency (kill switch `FORGE_RADAR=0`).
- **Cross-machine memory sync.** `forge ledger sync` push-pulls the PCM ledger through a
  git ref (`refs/forge/ledger` via `hash-object`/`mktree`/`commit-tree` plumbing;
  non-fast-forward races re-merge and retry ≤3 — monotone by the CRDT join, so nothing is
  lost) or a shared directory (bidirectional union-merge; `FORGE_SYNC_DIR` is the default
  dir target). Target precedence: `--dir` > `--remote`/`--ref` > the repo's git remote >
  `FORGE_SYNC_DIR` > an honest "no target". `--personal` syncs the per-user ledger beside
  the recall store, making recall facts portable across machines. Fails open (offline,
  missing remote, or corrupt remote blob → an honest reason, never a throw); the git
  runner is injectable so tests drive it with local bare remotes and never touch the
  network.
- **Anti-repetition memory (`forge deja`).** A first-try success mints no Cortex lesson,
  so its trace used to be discarded when the session ended — the root of cross-session
  repetition. Now every session Stop mints one `summary` claim (an existing ledger kind)
  with a secret-redacted gist of the task and the files touched, attaching a `test.run`
  confirm outcome when the session's own tests passed (so verified work outranks a mere
  attempt). New `src/deja.js` `dejaLookup` ranks prior summaries/lessons/diagnoses via the
  same Eq. 3 retrieval as `ledger query`; `forge deja "<task>"` surfaces them, and the
  pre-action substrate shows a one-line "déjà vu" advisory when a prompt matches prior
  solved work. Kill switch `FORGE_DEJA=0`. Because summaries are ordinary ledger claims,
  `forge ledger merge` carries them between machines.
- **Dashboard v2 (`forge dash`).** The localhost lens gains four panels over the
  durable `.forge/` stores plus live refresh: Radar (dependency-currency rings read
  from the `.forge/radar.json` cache — never fetches), Trends (per-stage
  `metrics.jsonl` history bucketed by day as inline-SVG sparklines, 90-day window),
  Memory browser (ranked recall search over the ledger via `retrieve`, with
  confidence and freshness bars), and Session timeline (durable mint/tombstone events
  across sessions). New read-only endpoints `GET /api/history`, `/api/claims?q=&kind=`,
  `/api/radar`, and `/api/timeline`; the page polls every 5s, paused while the tab is
  hidden. The append-only write discipline (only `POST /api/ratify` and `/api/retract`)
  is unchanged, and corrupt or missing stores degrade to empty sections.
- **Static HTML report (`forge report`).** New zero-dep `src/report.js` emits a
  self-contained `.forge/report.html` — the offline twin of `forge dash` (no server, no
  fetch, no CDN, no JS to read it). `renderReport` is pure and reuses `dashData`, buckets
  `metrics.jsonl` into a 90-day activity sparkline (server-side inline SVG), reads the
  `.forge/radar.json` cache directly and defensively (absent → the radar section is
  omitted), and draws its palette from `rootTokensCss()` so it matches the dashboard.
  `--out <path>` overrides the default location.

## [0.19.0] - 2026-07-17

### Added

- **Color-aware CLI output.** New zero-dep `src/fmt.js`: `supportsColor` honoring the
  `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > TTY precedence, brand-token painting
  (24-bit from `brand.json` when `COLORTERM` declares truecolor, portable 16-color
  fallback otherwise), visible-width-aligned `table`, and `bar` confidence meters —
  adopted across `ledger` (stats/blame/query), `cortex`, `route`, `doctor`, and
  `cost` output plus the `--verbose` title line. Piped output stays escape-free.

### Fixed

- **Research crosswalk reconciled with the code.** The formal-synthesis paper's
  crosswalk (rows 5/6/12/14 and the README §11 binding paragraph) cited hooks that
  no longer exist (`docs-guard.sh`, `session-context.sh`, `intent-router.sh`); the
  bindings now name the real system (`cortex.sh` → `src/gate.js` stopGate,
  `src/session.js` rehydrationBlock, `src/intent.js` exemplar k-NN), with kit-only
  names marked by a `kit:` prefix. A new `crosswalk` docs-check reconciler fails CI
  when any non-`kit:` `.js`/`.sh` binding in `crosswalk.json` names a file that does
  not exist in `src/`, `global/guards/`, or `hooks/`.

## [0.18.0] - 2026-07-16

### Changed

- **Single design-token source.** `brand.json` gained a `colors` block (full dark +
  light palettes) as the one source of the visual palette, plus `fonts` and `site`.
  `src/brand.js` exposes it via `cssVars(scheme)` + `rootTokensCss()` pure helpers;
  the generated status page (`scripts/build-pages.mjs`) now injects tokens from that
  one source (and gains light mode), and `test/pages.test.js` enforces full-palette
  parity — every dark and light hex in `brand.json` must appear on both public pages,
  so the landing page and status page can no longer fork into two palettes claiming
  to be one.
- **Landing page redesign.** Rebuilt `landing/index.html` on a Stat-Led structure:
  the real shipped hero diagram is now embedded (inlined so it resolves in local
  preview and at the deployed site root), the fake terminal chrome, placeholder
  digit/glyph icons, and faux-live pulse dot are gone, capabilities use real inline
  SVG icons in a hairline-divided layout instead of a uniform card grid, and the
  sticky-nav blur is compositor-light. Light-mode accents are darkened to meet AA
  contrast on the light paper.
- **Accessibility + design-system hygiene.** All accent/supplementary-text pairs on
  both themes are now verified ≥4.5:1 (bumped `--faint` in dark + light, and light
  `--brand`/`--ok`, at the single brand.json source). Border-radii are collapsed onto
  a deliberate 3-level scale (`--radius-sm` / `--radius` / pill), so `forge uicheck
design` passes spacing-scale, radius-levels, and shadow-levels with a healthy
  slop-distance. Focus rings appear instantly (no animated outline), motion is
  transform/opacity-only under `prefers-reduced-motion`.

### Added

- **Social + icon metadata on both public pages.** The landing and generated status
  pages now ship `og:image` / `twitter:image` (a 1200×630 brand card,
  `docs/assets/og.png`, rasterized once via Chromium — an author artifact, not a
  runtime dep), a favicon + apple-touch-icon (`docs/assets/favicon.svg` /
  `apple-touch-icon.png`), and consistent `canonical` == `og:url`. The status page
  gained a full Open Graph / Twitter / `SoftwareApplication` JSON-LD head; the deploy
  workflow copies the brand assets to the Pages root so the absolute URLs resolve.
- **Brand-aligned status line.** `global/statusline.sh` now renders the exact brand
  tokens (ember `#f26430`, warm-taupe greys) in 24-bit truecolor from a named palette
  block, with a 256-color fallback when the terminal can't do truecolor. New
  `test/statusline.test.js` smoke-tests the segments, the exact truecolor hexes, the
  fallback, and graceful degradation on minimal input.
- **Mermaid theme-value guard.** `forge docs check`'s `checkDiagrams` now verifies each
  `%%{init` block carries the brand's actual color values (ember + warm-black from
  `brand.json`), not just that a theme directive is present — a diagram can no longer
  declare a theme and still render off-brand. README leads with a `Start in 60 seconds`
  block, and `ARCHITECTURE.md` documents `brand.json` as the single color source.

### Fixed

- **Status-page metrics were silently stale.** The `impact` and `saved` regexes in
  `scripts/build-pages.mjs` no longer matched the current README, so those
  "repo-sourced" numbers were really hardcoded fallbacks. Regexes fixed to parse the
  README, and a non-match is now a hard build error (`mustMatch`) instead of a silent
  fallback; the dead `claim` field is removed.
- **Generated status page no longer ships stale/leaky.** `public/index.html` is a
  build artifact (regenerated at deploy), so it is now gitignored and dropped from
  the npm `files` list — a stale committed copy (old version + a dev-branch name
  leaked into a visible chip) can no longer be published in the tarball.
- **Landing → status link** now points at the absolute Pages URL, so it resolves in
  local file preview instead of 404-ing on `./status/`.

## [0.17.0] - 2026-07-15

### Added

- **OpenAI + Gemini provider detection** — `autoDetectProvider()` now recognizes
  `OPENAI_API_KEY` and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) as zero-config
  fallbacks after Anthropic, exposing `openai` and `gemini` as built-in providers
  with tier→model maps. Both are reached over their OpenAI-compatible
  chat/completions surface: `src/llm.js` gained an OpenAI-compatible wire format
  (`resolveHttpProvider()` now returns a `format` field) alongside the Anthropic
  Messages path, so a native key from either vendor works with no manual config.
  Anthropic credentials still win when present. `forge config` status and
  `listDetectedProviders()` surface the new keys.

## [0.16.0] - 2026-07-15

### Added

- **Playwright interaction loop** — `forge uicheck interact <file-or-url>` drives the
  page headless under `prefers-reduced-motion` and checks what it _does_
  (console-clean, keyboard-reachable, focus-visible, reduced-motion), where
  `uicheck visual` only fingerprints what it paints. The verdict is recorded through
  the ledger's cross-family-gated `behavioral` oracle (advisory by default;
  `--record` appends it as evidence on the project `fingerprint` claim, `--enforce`
  gates). Reuses the visual gate's Playwright resolver + loopback-only target guard;
  Playwright stays an optional tier (ADR-0005) with a graceful skip. New
  `src/uiinteract.js` (`runInteractions`, `summarizeVerdict`, `verdictOutcome`,
  `recordInteraction`) with a browser-free test suite.

## [0.15.0] - 2026-07-15

### Added

- measured-promotion gate + outcome-calibrated routing

## [0.14.0] - 2026-07-15

### Added

- **Measured-promotion gate + outcome-calibrated routing (`forge route calibrate`)** —
  a reusable `src/promote.js` generalizes the risk predictor's kill-criteria: an
  advisory signal (a calibrated weight, later a consolidation cluster or hazard
  estimate) may become active **only** if it beats the current baseline on held-out
  data under a metric+margin — the honesty register (overview §4), never an assertion.
  First application: `forge route calibrate` fits an affine correction of the routing
  rubric toward a held-out labeled fixture and promotes it only if it lowers held-out
  MAE. Advisory by default — routing keeps the rubric until a promotion is adopted
  (`calibratedComplexity` mirrors `predictor.riskFor`). Zero deps, fully unit-tested.
- **Legacy-store retirement (`FORGE_LEDGER_ONLY`)** — the PCM ledger can now be the
  _only_ store. Since P1 it has been the convergent write store (dual-write) with a
  merged read (`ledger_read`); with `FORGE_LEDGER_ONLY=1` the legacy files
  (`.forge/lessons/*.md`, recall/brain fact files) stop being written and every read
  materializes from the ledger — cortex confirm/create/distill dedup against
  `ledgerLessons`, `mergedLessons` returns the ledger view, and `recall.readFact` falls
  back to the ledger (also fixing merged teammate facts that had no local file). Run
  `forge ledger import` first to backfill. Default off keeps the legacy files canonical.

## [0.13.0] - 2026-07-15

### Added

- Custom-gateway model remap (`src/gateway_model_map.js`). The tier table pins public
  Anthropic IDs that a self-hosted LiteLLM/proxy gateway may not serve; when a non-default
  gateway base URL is set, Forge fetches `GET /v1/models` once per process and scores each
  advertised model against every tier's family (family-word gate + `setOverlap` name-token
  score, deterministic tie-break) to remap `haiku/sonnet/opus/fable` onto the gateway's real
  IDs. `forge doctor` surfaces the resolved `tier→model` mapping under a **gateway models** row.
  Zero breaking change — the `MODELS` export shape is unchanged, it fails safe to the stock ID
  on no gateway / unreachable `/v1/models` / no family match, and an explicit
  `.forge/providers.json` alias or `ANTHROPIC_MODEL` override always wins. Direct
  `api.anthropic.com` sessions never probe and are byte-identical.

## [0.12.4] - 2026-07-11

### Fixed

- security: drop two inert `curl`-pipe deny rules from the settings template.
  Claude Code only honors `:*` as a trailing wildcard, so the trailing pipe made
  the colon a literal and the rules matched nothing. Real pipe-to-shell
  enforcement already lives in `protect-paths.sh`, now tightened to also catch a
  no-space pipe and a `zsh` target. Adds a regression test for template rule
  shape.

## [0.12.3] - 2026-07-11

### Fixed

- bump.mjs keeps ROADMAP's "Now" marker in sync

## [0.12.2] - 2026-07-11

### Fixed

- allowlist bibliography citation-key false positives in gitleaks
- don't let an empty Unreleased section blank the status page changelog

## [0.12.1] - 2026-07-11

### Fixed

- don't let an empty Unreleased section blank the status page changelog

## [0.12.0] - 2026-07-11

### Changed

- **Goal-drift classification is graded and identifier-aware (`src/anchor.js`).** A changed
  file's on-goal/off-goal call is now a **noisy-OR** (`1 − (1 − p)^hits`) over how many
  distinct goal concepts it exhibits in its path **and** the identifiers it defines (via the
  atlas), thresholded at the single-hit floor — replacing the binary path-substring match, so
  a file that implements the goal but never names it in its path is caught deterministically,
  not just by the opt-in LLM pass. `driftScore` stays the off-goal fraction, so the CUSUM
  detector's operating point is unchanged (an on-goal checkpoint scores 0 and drains the chart);
  the sharper classification is what improves the signal.
- **Specification completeness is a logistic estimator (`src/preflight.js`).** The M2
  assumption gate's `s(x)` completeness score is now a logistic over its features
  (concreteness, named specifics, vagueness, a smooth `tanh` length term) — replacing the
  additive scorer's magic coefficients and discontinuous word-count steps. The `sigmoid`
  bounds it to (0,1) with no clamp, each feature's pull stays attributable, and a labeled
  bank could refine the weights via `predictor.js`'s `trainLogistic`. Calibrated to keep the
  documented examples (a bare "make the auth better" ≈ 0.23 → ask; a concrete verifyToken
  edit ≈ 0.63 → proceed).

### Added

- **`forge docs check` now guards intra-repo links and roadmap freshness** — two more
  reconcilers close recurring "docs rot" classes: `checkLinks` resolves every Markdown
  anchor (`#x` and `path.md#x`) against the target file's real headings using
  GitHub-exact slugs (an em-dash yields `--`, never collapsed), catching dead anchors like
  a renamed `#install`; `checkRoadmap` fails when ROADMAP's "Now" marker trails the shipped
  `package.json` version.

### Fixed

- **Dead and fabricated docs** — a fabricated `forge route` example in `docs/GUIDE.md`
  (an impossible `Fable 5 / Opus` / "premium tier" output) now shows the real routed
  verdict; broken `#install` anchors in `ONBOARDING.md` and the substrate README now point
  to `#60-second-quickstart`; a dead `#use-it-in-a-script` self-link resolves; and ROADMAP's
  "Now" marker is current (v0.11.0). All now enforced by the new docs-check guards.

## [0.11.0] - 2026-07-11

### Added

- **`forge stack`** — dynamic stack detection: reads the repo's dependency manifests
  (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`,
  `pom.xml`/`build.gradle`, `*.csproj`) and reports its real languages, frameworks,
  package managers, and test commands — data-driven (extend by adding a `SIGNATURES`
  row), not a hardcoded menu. The detected test commands now drive the substrate's
  verification checklist instead of assuming npm.
- **Six more atlas languages** — Ruby, C#, PHP, Kotlin, Swift, and C/C++ join JS/TS,
  Python, Go, Rust, and Java (whose method defs are now indexed too). One `RULES` table;
  the walk, completion gate, and docs sweep pick each up automatically.
- **`forge update`** — self-update: `--check` reports whether a newer version is
  available (commits behind upstream, from a cached hourly fetch), bare applies it
  (`git pull --ff-only` for a checkout, or the `npm i -g` command otherwise). `forge
doctor` surfaces a non-nagging "update available" notice; `FORGE_NO_UPDATE_CHECK=1`
  silences it. Fail-open: offline / non-git / detached-HEAD never error.
- **Self-dogfood** — a committed `.claude/settings.json` wires forgekit's own guards via
  `${CLAUDE_PROJECT_DIR}`, so the repo runs its own completion gate, cortex, and guards
  during local dev without a marketplace install.
- **Auto-release on merge** — pushing a `feat`/`fix`/`perf`/breaking change to `master`
  now cuts the release automatically (bump → tag → npm publish → GitHub Release); a
  chore/docs-only merge skips cleanly (`bump.mjs auto` exits `3`). When `[Unreleased]` is
  empty, `bump.mjs` synthesizes the changelog body from commit subjects so every release
  still describes itself. Manual **Actions → Bump version** dispatch stays available.
- **`forge docs check` now guards diagrams, model prices, and benchmark numbers** — three
  new reconcilers close the blind spots behind recurring complaints: every `mermaid` block
  across all Markdown must carry the branded theme and use `<br/>` (not a literal `\n`);
  model prices in the docs must match `src/model_tiers.json`; and every bolded `N ms`
  claim in the README must be a value `reports/benchmarks.md` actually measured.

### Changed

- **CLI output is quiet by default** — the `Forge <command> — …` title line no longer
  prints on every command; results come first. `--verbose` or `FORGE_VERBOSE=1` restores
  it. The `--help` / `--version` banner is unchanged.
- **Unified public design system** — the landing page and the generated status page now
  share one warm ember/near-black palette and a system font stack (the landing page no
  longer declares the Inter webfont it never loaded). `test/pages.test.js` enforces token
  parity, a non-empty changes list, and no phantom webfont.
- **Restyled the terminal statusline** — a restrained palette (muted structure, one ember
  accent, green/red reserved for the diff) with consistent `·` separators and a subtle
  context-limit marker instead of an alarming red block.
- **Plain-language docs pass** — the README and GUIDE openings lead with what forgekit is
  and does; the deep math (`y = f(x)`, join-semilattice, Beta posteriors) moved into
  parentheticals or the white paper, and comparison-table cells no longer cite code
  identifiers as if they were user features.

### Fixed

- **Broken diagrams** — two `mermaid` diagrams rendered in Mermaid's off-brand default
  theme, one with literal `\n` node breaks GitHub showed as garbage; both fixed, and the
  over-wide 13-node pre-action pipeline was regrouped so it reads at GitHub width.
- **Status page "Latest changes" list** — wrapped CHANGELOG bullets were truncated
  mid-sentence (and could render empty); the parser now joins lazy/indented continuation
  lines into the full item.

## [0.10.0] - 2026-07-10

### Added

- **The completion gate** — a synchronous Stop hook (`global/guards/completion-gate.sh`
  → `src/gate.js`) that blocks a session ONCE when code changed but no doc or state
  artifact moved with it, answering with the repair checklist (`forge docs sync`,
  `forge handoff`, `forge decide`, plus a CUSUM goal-drift alarm when the session's
  recorded drift sustained). Loop-safe (`stop_hook_active` + once-per-session marker),
  fail-open on every error path, kill switch `FORGE_STOPGATE=0`. Classification derives
  from the atlas registries + the shared test-file predicate — no parallel regex lists.
- **`forge handoff`** — the bounded session snapshot: rewrites `.forge/state.md`
  (≤150 lines; goal/phase, acceptance criteria, done, next, gotchas, recorded
  assumptions, in-progress git files) and SessionStart re-injects it, so the next
  session resumes instead of re-assuming. Refuses secrets like every forge store.
- **`forge decide`** — append-only ADR-lite decision log (`.forge/decisions.md`,
  `D-####` numbering) + a machine-readable `decision` ledger twin; bare `forge decide`
  lists the last ten. Supersede with a new entry, never an edit.
- **`forge docs sync`** — the diff-driven half of docs↔code alignment: changed
  identifiers (paths, definitions, called symbols — from added AND removed lines) swept
  against every doc artifact → UPDATED / STALE (file:line hits) / VERIFIED-UNAFFECTED
  (reason recorded). Advisory by default, `--strict` for CI, `--base <ref>` to widen;
  CHANGELOG and the decision log are exempt (append-only history).
- **Session baseline + rehydration** — SessionStart records the session's git anchor
  (`.forge/sessions/<sid>.base`; a resume never moves it), prunes week-old session
  artifacts, and injects the handoff snapshot + last 10 commits + uncommitted changes.
- **Intent protocol cards** — UserPromptSubmit classifies the prompt with the same
  exemplar k-NN math as routing (labeled bank incl. Hinglish rows, overlap similarity,
  confidence gate) and injects a bugfix/feature/refactor/release protocol card once per
  run of that intent; questions get no ceremony. Kill switch `FORGE_INTENT=0`.
- **Recorded assumptions** — when preflight proceeds without asking, the assumption is
  appended to the session log, named in the advisory, and surfaces in the next handoff;
  the per-prompt goal-drift score is recorded the same way and feeds the gate's CUSUM.
- **Config artifacts in the atlas** — CI workflows (`.github` is now walked),
  manifests, and Dockerfiles become `config:` nodes with `references` edges to the code
  paths they name, so `forge impact` lists the configs a change can break (lockfiles
  excluded as generated churn).
- **End-to-end skills + agent** — `handoff`, `sync-docs`, and `catchup` skills, a
  `doc-sync` crew agent that repairs stale docs in its own context, and an
  `end-to-end` rules section (Definition of Done, no silent assumptions, decision log)
  compiled into every tool by `forge sync`.

### Fixed

- **`cortex.sh` hook entry resolution in symlink installs** — `~/.forge/src/…` pointed
  at the nonexistent `global/src/`, silently no-opping every cortex hook outside plugin
  mode; the shim now resolves through the symlink (`pwd -P`), same as `secret-redact.sh`.
- **Twelve defects found by a two-angle adversarial review of the new layer, all with
  regression tests** — the gate no longer attributes pre-session dirt, branch-switch/pull
  commits, or vendor trees to the session (session-scoped changed set: committer-time
  window + SessionStart dirty snapshot); `-z` NUL parsing keeps unicode/space/arrow paths
  correctly classified; an unwritable block-once marker stands down instead of blocking
  every turn; a missing `session_id` disables gating instead of sharing `default` state;
  a >7-day resume re-anchors instead of losing its baseline to the prune; `readState` no
  longer truncates snapshots whose rows contain `<!--`; `forge decide` takes a lock so
  concurrent appends can't mint duplicate D-#### ids; the docs sweep stopped scanning its
  own bookkeeping (`.forge/state.md`), scans touched docs for REMOVED symbols (the rename
  case), counts lowercase symbols only inside backticks, dedupes recorded assumptions,
  and errors on an unknown `--base` instead of mislabeling the report.

## [0.9.0] - 2026-07-10

### Added

- **Gateway environments work end to end** — `ANTHROPIC_AUTH_TOKEN` is recognized
  everywhere `ANTHROPIC_API_KEY` is; `ANTHROPIC_MODEL` / `FORGE_MODEL` pin one model
  (bypassing tier routing); a gateway-looking `ANTHROPIC_BASE_URL` auto-classifies as
  LiteLLM; and the LLM proposer falls back to **direct HTTP** (`src/llm.js`, Anthropic
  Messages API) when the `claude` CLI is absent — or on `FORGE_LLM_HTTP=1`.
- **`forge docs check`** (+ CI job + doctor check) — reconciles README/GUIDE/
  ARCHITECTURE/ROADMAP against the code: every CLI command documented, every env var
  read is documented and every documented var is real, MCP tool counts/names match the
  registry, CHANGELOG sections non-empty. First run found 56 real drift issues,
  including a phantom env var. `scripts/bump.mjs` now refuses to rotate an empty
  `[Unreleased]`.
- **Docs are in the impact graph** — the atlas parses markdown into doc nodes with
  `references` edges to the code they name, so `forge impact src/foo.js` lists the
  docs that go stale, and the pre-edit hook says so before the edit.
- **Persistent goal** — `forge anchor set/show/clear` stores the active goal in
  `.forge/goal.md`; SessionStart re-injects it and a bare `forge anchor` checks
  against it. `goalDrift` also returns a graded `driftScore` for the CUSUM detector.
- **AGENTS.md auto-repair** — the Stop hook re-runs sync when the managed AGENTS.md
  drifts from its canonical inputs (disable: `FORGE_AUTOSYNC=0`).
- **Entropy secret detection** — `src/secrets.js` is the single source of truth
  (format grammars + Shannon-entropy gate for unknown-vendor tokens); the
  `secret-redact` guard now imports it, ending the JS/shell regex divergence.
- **`src/math.js`** — Shannon entropy, charset classes, exact set Jaccard/overlap.

### Changed

- **Routing scores by exemplar similarity, not keyword lists** — the text rubric is
  similarity-weighted k-NN over a labeled `EXEMPLARS` bank (overlap-coefficient on
  stopword-filtered unigram+bigram sets, credibility-shrunk); the four topic keyword
  regexes and their additive magic weights are gone. Tune routing by adding labeled
  rows, not by editing weights.
- **Lesson matching is graded** — the keyword tier of `matchScore` scores by token
  overlap (same-module partial credit) instead of all-or-nothing string equality.
- **Substrate minimality warnings derive from computed signals** (preflight missing
  dimensions + route score) instead of a second keyword copy.
- **`forge scan` detects obfuscated payloads** — long high-entropy base64 blobs flag
  as findings alongside the signature rules.
- **`providerStatus` probes `/health` on any custom base URL** and reports behavioral
  gateway evidence (a proxy that answers /health is a gateway, whatever its hostname).

## [0.8.1] - 2026-07-08

### Added

- **MCP write tools** — `forge_remember`, `forge_ledger_ratify`,
  `forge_ledger_retract` join the read tools (19 tools total).

### Changed

- Simplified CLI surface and improved dashboard UX empty states.

### Fixed

- Stale documentation across command references.

## [0.8.0] - 2026-07-08

### Added

- **Forge work system** — auto-install flow, multi-provider routing, the cost
  dashboard (`forge dash`), and the cortex MCP server's read-path tools.
- **Zero-config provider auto-detection** — `autoDetectProvider()` resolves the
  provider from the environment (LiteLLM local/hosted, OpenRouter, Anthropic);
  `forge init` reports what it found.
- **Hosted LiteLLM gateway support** — `emitGatewayConfig()` writes a
  `litellm.config.yaml` exposing complexity tiers as model aliases.

### Fixed

- TypeScript errors and Biome 2.5.2 lint warnings across source and tests.

## [0.7.0] - 2026-07-08

### Added

- **Optional embeddings tier** (`src/embed.js`, ADR-0005; ROADMAP "Next"): set
  `FORGE_EMBED=cmd:<command>` (stdin/stdout JSON protocol — any local model or script)
  or `FORGE_EMBED=http:<url>` (OpenAI-compatible, `$FORGE_EMBED_MODEL` /
  `$FORGE_EMBED_KEY`, key never logged) and `forge reuse query` + `forge ledger query`
  replace the MinHash `rel` term with embedding cosine (near/adapt ≥ 0.85/0.7 — a
  higher bar than Jaccard's 0.8/0.6 to match dense cosine's noise floor), fixing the
  documented weak spot on very short specs. Vectors are disk-cached
  (`.forge/embed-cache.jsonl`, content-hash keyed, corrupt-tolerant, truncate-oldest);
  both commands print the backend that served (`sim: minhash` / `sim: embed(cmd)`);
  any provider failure degrades silently to MinHash. `dependencies` stays empty —
  the tier is configuration, not a package; the pure ledger core never imports it.
- **`forge uicheck visual <file-or-url>`** — the Playwright visual loop
  (07-ui-quality-gate §5): renders the page headless at two viewports, fingerprints
  the **computed** styles of every visible element (what the cascade and runtime
  theming actually painted, with used `auto`-margins and never-painted UA noise
  filtered out), and runs the identical `design` gate over that rendered vector —
  screenshots land in `.forge/ui/`. Playwright stays an optional tier (ADR-0005):
  `package.json` gains no dependency, absence degrades to a "skipped (no browser
  runtime)" note with exit 0 (`npm i -D playwright-core` or `FORGE_PLAYWRIGHT=…` to
  enable), and non-loopback http(s) targets are refused by default (`--remote` to
  override) — a gate that fetches arbitrary URLs is an exfiltration hazard.

### Changed

- **Ledger read-path flip (P2).** Reads are now a merged view (legacy ∪ ledger) via the
  new `src/ledger_read.js`, so teammate knowledge that arrives with `forge ledger merge`
  actually reaches injection and retrieval: cortex lesson surfaces
  (`lessonsForContext`, `startupBlock`, `summary`, the substrate advisory and routing
  past-mistake density) map ledger `lesson` claims onto the legacy lesson shape with an
  evidence-derived status (tombstoned → retired, val ≥ 0.6 → active, val < 0.45 with a
  contradiction → quarantined, else candidate), and fact surfaces (`recall list`/
  `MEMORY.md`, brain's `AGENTS.md` index) include live ledger `fact` claims — always
  deduped by legacy id/slug with the local file winning, and best-effort (a missing or
  corrupt ledger degrades to legacy-only). Write paths (`recordMistake`'s
  confirm-vs-create lookup, `recordContradiction`, `applyDistillation`) deliberately
  keep reading the legacy store they edit; convergence comes from content-addressed
  claim ids. `reconcileFacts` now only tombstones locally-authored claims, so a merged
  teammate fact survives `forge recall consolidate`. Legacy formats are still written —
  full retirement is the next step.
- **Professional redesign of the public site, gated by forge's own UI system.** The
  landing page (`landing/index.html`) and the generated status page
  (`scripts/build-pages.mjs` → `public/index.html`) are rebuilt on one design system —
  the `forge dash` eight-color warm-ink/ember palette, a strict 4px spacing base, three
  radius levels, one shadow — and both now pass `forge uicheck design` **and** the
  rendered `forge uicheck visual` gate (the old pages failed with 15–19 accumulated
  colors and 5–9 radius levels; a project fingerprint claim is minted so conformance is
  checked too). Scroll-reveal is JS-gated progressive enhancement (no-JS UAs, crawlers,
  and reduced-motion users see the full page), and the Pages workflow (`static.yml`) now
  builds and deploys an assembled `_site/` — landing at the site root, status page at
  `/status/` — instead of uploading the entire repository as the artifact.

## [0.6.0] - 2026-07-07

### Changed

- Docs consolidation pass: deduplicated cross-doc prose into single canonical homes
  (the substrate README now points at the GUIDE's command reference, output table, and
  honest-limits list instead of repeating them), added orientation diagrams
  (ARCHITECTURE four-layer compiler + ledger, substrate-v2 phase graph with all phases
  marked shipped, the GUIDE daily loop), brought the ROADMAP current, and refreshed the
  model-facing skills/crew guidance for the v0.5.0 surface (`forge context`,
  `forge imagine --run`, `forge diagnose`, `forge ledger blame`, `forge cost --stages`,
  `forge uicheck design --taste`) without growing the skills' context payload.

## [0.5.0] - 2026-07-07

### Added

- Security & OSS hardening: CodeQL, gitleaks secret-scan (blocking; verified clean on the
  full history), and OSSF Scorecard workflows; refreshed repo topics; SECURITY.md now
  states the supported line (0.5.x) and documents the ledger's forgery-resistance
  properties (content-hash verification; oracle weights never trusted from records).
- **UI fingerprints resolve CSS `var()` indirection**, so design systems declared as
  custom properties fingerprint fully (the dashboard now reads as a 6-value 4px scale
  with two radius levels instead of one lonely spacing value), and the five taste
  profiles gain machine-readable constraint JSONs (`global/taste/<name>.json`) wired
  into `forge uicheck design --taste <name>` — with auto-pickup from a
  `forge taste`-managed DESIGN.md. Prose steers generation; the JSON is what the gate
  checks.
- **One-click release automation.** `scripts/bump.mjs` (node stdlib only, unit-tested)
  bumps every version field in one shot — `package.json`, `package-lock.json`, both
  plugin manifests, `CITATION.cff`, the landing page — rotates the CHANGELOG
  `[Unreleased]` section under a dated heading, and prints the new version;
  `npm run bump -- <patch|minor|major|auto>` (auto = conventional commits since the last
  tag: BREAKING → major, feat → minor, else patch). The new `bump.yml` workflow makes a
  release one click from the Actions tab (commit + tag + dispatch of `release.yml`);
  `release.yml` now soft-skips npm publish when `NPM_TOKEN` is missing instead of
  failing, and CI gained a version-drift guard (`node scripts/bump.mjs check`).
- **Benchmark harness (`npm run bench`) + measured results doc.** `bench/bench.mjs`
  (node stdlib only) measures the substrate primitives as medians of N runs after
  warmup — atlas build/incremental/impact latency on this repo, ledger
  mint+put/loadClaims/mergeDirs/val() on seeded synthetic fixtures, reuse fingerprint +
  exact/near-LSH lookup at 100 and 1000 artifacts, `assemble()` and full
  `substrateCheck` wall time — and writes the tables plus an environment block into
  `reports/benchmarks.md`. The same run scores `impact()` precision/recall/F1 against a
  committed, hand-labeled case set from this repo's real import graph
  (`bench/impact_cases.mjs`, every reference cited; one known-miss alias case kept in on
  purpose), reported next to — never blended with — the paper prototype's
  mutation-derived numbers, plus a structural-only contrast with adjacent tools (note
  stores, LLM gateways, plain RAG), every row checkable from the named source.
- **Loop closure (P5 of the substrate-v2 plan): doom-loop diagnosis, imagination, CUSUM
  drift, checkpoint cadence.** `forge diagnose "<error>"` hashes each failure into a
  signature (line numbers, addresses, timestamps, and absolute paths normalized out) and
  counts recurrences in a 50-entry ring; the 3rd identical hit is thrash — it mints a
  content-addressed `diagnosis` claim into the team ledger and tells the agent to STOP
  retrying and escalate ONE model tier with the diagnosis as the prompt's head (the same
  loop becomes a one-per-team event, not one-per-session). `forge imagine "<task>"` is the
  static half of the consequence simulator (paper Eq. 4): entities → blast radius →
  predicted breaks with confidence, plus the minimal dry-run test suite via weighted greedy
  set cover (weight = file size as a duration proxy; classic ln-n approximation) and
  `riskScore = Σ confidence`. **`forge imagine --run` executes that minimal suite in a
  sandboxed ephemeral git worktree** (HEAD-only — refused on a dirty tree unless
  `--allow-dirty`), parses the TAP summary into per-file verdicts, always removes the
  worktree (verified in a finally), and meters the run (`stage: "imagine"`); on this repo
  the 8-test selected suite measured 1.3 s where the full suite takes ~60 s.
  `anchor.cusum()` adds the M4 one-sided CUSUM control chart (k = 0.35,
  h = 1.0): sustained small drift alarms, a single exploratory spike drains back to zero.
  `verify.checkpointCadence()` prices M6's "when to check?" as the optimal-stopping
  threshold rule `n* = ⌈checkCost / (pErr·tokensPerStep·costPerToken)⌉`, clamped to
  [1, 50] — every input measured or priced, no magic constants.

- **Context assembly + completeness gate (P4 of the substrate-v2 plan).** `forge context
"<task>"` makes what goes into the window a budgeted optimization and makes
  _sufficiency_ a computed set. The required-knowledge set `R(edit)` — the target's
  definitions, its hop-1 dependents from the atlas, sibling tests, and team lessons
  trusted past val ≥ 0.8 — is derived, then covered by pinned items with a **compression
  ladder** (full → head → pointer): a tight budget downgrades granularity instead of
  silently dropping coverage. Optional items (trusted facts) fill remaining budget
  greedily with per-source diminishing returns. `missing = R \ covered` becomes derived
  clarifying questions ("the task names `X` but the repo doesn't define it — which file
  implements it?"), shown in `forge substrate` and — under `FORGE_ENFORCE=1` — blocking:
  acting on missing context is acting on a guess. Incomplete context stops being a
  feeling and starts being a set difference.
- **Generated-UI quality gate (P6 of the substrate-v2 plan).** Taste becomes measurable:
  `src/uifingerprint.js` extracts a deterministic design fingerprint from CSS/JSX/Tailwind
  classes — pure static parsing, no LLM, no screenshots — covering palette (HSL + 12-bin hue
  histogram), spacing (base unit by residual-minimization approximate GCD, on-scale
  fraction), font families, radius and shadow levels. Two distances gate generated UI:
  `slopDistance` to a shipped, rationale-documented generic-template signature set
  (default-Tailwind blue/indigo, stock Bootstrap, the AI-landing gradient) must stay HIGH,
  and `conformance` to the project's own fingerprint — stored as a shared `fingerprint`
  ledger claim via `mintProjectFingerprint` — must stay LOW; `uiGate` failures are
  actionable per-feature edits, never a bare score. Scale-conformance checks
  (spacing-on-base, radius/shadow level caps, palette bound) join `ASSERTABLE_CHECKS`.
  `forge uicheck` gains `fingerprint <file...> [--mint]` and `design <file...>` (exit 1 on
  fail) alongside the unchanged contrast math.
- **Local dashboard (P7 of the substrate-v2 plan).** `forge dash [--port N]` serves a
  read-only lens on the substrate's state: a `node:http` stdlib server (localhost-only,
  zero runtime deps) with ONE self-contained HTML page — inline CSS/JS, no CDN, no
  framework, no build step. Panels: Ledger (claims with val bars, kind filter, contested
  claims — val ∈ [0.4, 0.6] with ≥1 contradiction — and per-author trust), Cost/Cache
  (stage counters + measured saved-token estimates from `.forge/metrics.jsonl`), and
  Impact (atlas blast-radius explorer via `/api/impact?target=X`). Every claim row shows
  its `forge ledger blame <id>` command — no unexplained scores anywhere in the UI. Data
  is separated from serving (`dashData()` vs `serve()` in `src/dash.js`) so the payload
  is tested without sockets, and corrupt/missing stores degrade to empty sections instead
  of taking down the lens. The ratify/retract POSTs are a follow-up; this phase never
  writes.
- **Measured cost report (P8 of the substrate-v2 plan).** `forge cost --stages [--json]`
  computes per-stage cost factors as pure arithmetic over `.forge/metrics.jsonl`
  (`src/cost_report.js`): gate halt rate, tier-weighted cache hit rate (exact 1.0 / near
  0.85 / adapt 0.5), route saving priced against the always-premium baseline, and context
  assembly — then composes `C = C₀ · Π(1 − fᵢ)` over ONLY the measured stages. A stage with
  no events reports "no data", never a default; the composed figure is a lower bound whose
  caveats name every unmeasured stage; the paper's 62 % routing figure is cited as context,
  and ~90 % appears only as a labeled target. `substrateCheck` now meters the assumption
  gate on the explicit path (one `gate` halt/pass line per decision; ambient hooks stay
  write-free), `recordGate`/`recordRoute` give future stage wiring one obvious call each,
  and `reports/cost-eval.md` scaffolds the paired-run harness report with a truthful
  empty state.

- **Proof-carrying reuse cache (P3 of the substrate-v2 plan).** `forge reuse` turns
  "reuse already-generated code" from prose into a deterministic system: verified code
  becomes an `artifact` claim keyed by a normalized task fingerprint (volatile literals →
  typed placeholders; MinHash sketch + 16×8 LSH banding for near-match), looked up through
  the exact → near → adapt → miss ladder. An artifact serves ONLY while its proof holds —
  confidence above the 0.6 floor (an unverified mint sits at the 0.5 prior and does not
  serve) and every declared dependency still resolving in the atlas; a failed revalidation
  appends a `graph.reval` contradiction, so stale code demotes itself for the whole team.
  `forge reuse query|mint|stats`, a reuse stage in `forge substrate` (read-only on the
  ambient hook path), and `src/metrics.js` — the stage-tagged `.forge/metrics.jsonl` the
  cost model's measured savings are computed from. The `reuse-first` skill now calls the
  cache before advising a repo search.

- **Team memory (P2 of the substrate-v2 plan).** The PCM ledger becomes shared:
  `forge ledger merge <path>` performs the conflict-free semilattice merge of any other
  ledger tree (a teammate's checkout, a worktree, a backup) — identical knowledge minted
  independently converges to one claim with every author preserved in its provenance log.
  `forge ledger blame <id>` is the accountability view (every mint, every oracle outcome,
  every retraction, per-author trust). `forge ledger query "<text>"` ranks live claims by
  the paper's Eq. 3. Every claim, evidence record, and tombstone now carries the git
  identity (`FORGE_AUTHOR` override; cached; best-effort). **Per-author trust**
  `u(author) ∈ [0.5, 1]` is computed from the oracle track record of the claims an author
  minted — smoothed to 1.0 for new teammates, floored at 0.5, self-confirmation excluded —
  and optionally weights `val()`. `forge doctor` now checks the union-merge driver is
  present (a populated ledger without it WILL conflict) and the ledger's normal form.

### Fixed

- **PCM ledger hardened after an 8-angle adversarial review of the P1 merge.** The
  conflict-free-merge guarantee is now structural: claim file bytes are a pure function of
  (kind, body, scope) — byte-identical on every replica — while provenance and tombstones
  move into per-claim append-only logs (hash-deduped, union-merged like evidence), so
  concurrent mints and concurrent retractions can never produce a git conflict or a
  merge-order-dependent state. Forged evidence is now powerless AND detectable: `val()`
  takes oracle weights from the ORACLES table (never the stored record) and skips unknown
  oracles, while `forge ledger verify` recomputes every record's content hash and flags
  mismatches, ghost oracles, and inflated weights. `forge ledger import` is truly
  idempotent (claims already tracked live are never re-synthesized — no double counting).
  Cortex shadow-writes: distillation now supersedes (evidence carried over, template claim
  tombstoned); evidence refs carry the confirmation counter so same-day sessions with
  colliding episode ids stay distinct; regex-detected reverts contradict at the
  conservative bridge weight instead of the full-weight human oracle. Fact claims: one
  CRLF-tolerant parser (`recall.readFact`), trimmed bodies (shadow path and import path
  mint one id), same-name updates supersede the stale claim, and `forge recall
consolidate` reconciles deletions into tombstones. `putClaim` repairs corrupt/truncated
  claim files instead of trusting `existsSync`. `forge ledger --personal` reaches the
  personal ledger (previously write-only); `forge ledger show` resolves by shard instead
  of scanning; `forge init` emits the union-merge `.gitattributes` rule into consumer
  repos. `SCOPE_WEIGHT` has one home (ledger core; lessons re-exports).

### Documentation

- **Substrate v2 plan: the whitepaper, completed (`docs/plans/substrate-v2/`).** Nine specs
  - two ADRs mapping every remaining paper faculty/mechanism to a concrete algorithm, unified
    by the **Proof-Carrying Memory (PCM) protocol**: every stored unit (lesson, fact, cached
    artifact, graph edge, design fingerprint, diagnosis) becomes a content-addressed claim whose
    confidence is a decayed Beta posterior over independent-oracle outcomes — retrieval implements
    the paper's Eq. 3, team memory is a conflict-free CRDT ledger merged over git, code reuse is a
    proof-carrying artifact cache, context assembly is a token-budget knapsack with a set-cover
    completeness gate, and generated-UI quality is a measurable slop-distance/conformance gate.
    ADR-0005 relaxes the zero-dependency rule to selective optional deps with stdlib fallbacks;
    ADR-0006 converges all persistence on the PCM ledger. `ROADMAP.md` now carries the P1–P8
    phase plan. Docs only — no runtime behavior changes.
- **Visual flow diagrams in the entry-point docs.** A "one source → every tool + pre-action gate"
  mermaid in `README.md` and a "your day with Forge" loop in `ONBOARDING.md` (alongside the
  propose→verify diagram in the substrate README) — making the model easier to grasp at a glance,
  while preserving the docs' existing dry-precise voice.

### Added

- **Proof-Carrying Memory ledger (P1 of the substrate-v2 plan).** `src/ledger.js` — the
  pure PCM core (ADR-0006): content-addressed claims over canonical JSON, an oracle
  taxonomy in which only independent signals (tests, CI, human accept/revert) may move
  confidence, a time-decayed Beta-posterior `val` that decays toward _uncertainty_ (never
  toward false), the paper's Eq. 3 retrieval score, dependency-free MinHash similarity +
  union-find consolidation clustering, and a join-semilattice merge (property-tested:
  commutative, associative, idempotent — teammate ledgers converge in any order).
  `src/ledger_store.js` — the git-native on-disk ledger (`.forge/ledger/`): one immutable
  file per claim sharded by id, append-only hash-deduped evidence logs (union-merge safe,
  see `.gitattributes`), tombstones, attic, `LEDGER.md` index, and a CI-friendly
  normal-form `verify`. `forge ledger stats|verify|show|import` CLI. The legacy stores
  stay the read path in P1: cortex shadow-writes every lesson event (create/confirm/
  human-revert contradiction) into the ledger, `forge remember` / `forge recall add`
  shadow facts, and `forge ledger import` back-fills history idempotently
  (`src/ledger_bridge.js`). Secret-refusal now lives in the ledger core so no claim kind
  can store a credential (re-exported from `recall.js` for compatibility).
- **Uniform `--json`.** `doctor`, `route`, `preflight`, `verify`, and `scope` now accept `--json`
  (previously only `impact`/`substrate`/`anchor` did) — so CI and scripts can gate on the health
  check, the routed tier, the assumption gap, and the verification result.
- **`forge doctor` sees more silent misconfiguration.** New checks: guard scripts present **and
  executable**, `jq`/`git` availability (several guards degrade without `jq`), atlas
  **presence + freshness** (a stale graph misleads impact/verify), and **model-pricing staleness**
  (warns when the verified date is >90 days old).
- **Evaluation harness (`src/eval.js`).** The deterministic core of the prototype's mutation-testing
  idea: score the impact oracle's precision/recall/F1 over labeled cases and against the
  edited-file-only baseline the paper measured against — so the graph-quality claim is checkable in CI.

### Changed

- **Model tiers carry a currency + a verified date.** `model_tiers.js` exports `PRICING_CURRENCY`
  ("USD") and `PRICING_VERIFIED`, which `forge doctor` uses for the staleness warning.
- **One shared call-site extractor (`src/extract.js`).** `atlas.js` and `verify.js` each kept their
  own copy of the call regex + builtins ignore-list; they now share one module so the two can't
  drift apart.

- **Opt-in enforcing gate (`FORGE_ENFORCE=1`).** The substrate's assumption gate can now be a real
  _halt_ (the paper's Eq 5 / M2 "block on insufficient input"), not just advice. On the Claude Code
  ambient path it blocks a prompt with **no concrete anchor at all** ("fix it", "make it better") —
  or an action into a very large predicted blast radius — and returns the clarifying questions.
  Deliberately low-false-positive: a specified task is never blocked, and it's **off by default**
  (`enforceDecision()` in `src/substrate.js`).
- **M5 anti-over-engineering is now measured, not guessed (`forge lean`).** The paper's
  `φ(y) − φ*(x)` check replaces the old three-keyword stub: `src/lean.js` reads the working diff
  and flags the footprint beyond what the task asked for — new abstractions the task never named,
  a large diff for a short ask, files touched beyond the stated scope. Folded into
  `forge substrate` (a `minimality.footprint` field) and available standalone as `forge lean "<task>"`.
- **Doom-loop breaker (self-correction).** Complements the shell guard (which catches the _same
  action_ repeated) by catching the subtler loop the paper names — _different edits that keep
  producing the same test failure_. `cortex_hook` now captures a normalized signature of failing
  test output; `detectDoomLoop` fires when one signature recurs past a threshold, and the
  pre-edit hook surfaces a "stop and find the root cause" advisory with the diagnosis.
- **Consequence simulation — failing-tests class (Eq 4).** `forge substrate` now predicts the
  tests likely to break _before_ an edit (`impact.predictedTests`): the impacted files that are
  tests, plus each impacted source file's sibling test — surfaced so you run the narrowest
  affected tests first, not after the fact.

### Changed

- **`forge sync` now adopts an existing project `CLAUDE.md` instead of skipping it.** Previously a
  repo with its own `CLAUDE.md` was left untouched — which meant Forge's shared rules never
  reached Claude Code there. Sync now prepends the one-line `@AGENTS.md` import (idempotent,
  every original line preserved) and reports `adopted`. `AGENTS.md` keeps its back-up-then-write
  behaviour; your skills and other tool files are untouched.

### Fixed

- **The Cortex capture/learn loop now works in the dotfile install too.** `global/settings.template.json`
  wired only `cortex.sh preflight` (1 of 6 modes), so dotfile users got the substrate advisory but
  **never captured events or distilled lessons** — the learning loop was dead for them while plugin
  users had it. The template now wires all six modes (`session-start`, `prompt`, `preflight`,
  `pre-edit`, `capture`, `stop`), matching `hooks/hooks.json`.
- **`forge verify` can't hang.** `runTests` now bounds the test run with a timeout
  (`FORGE_VERIFY_TIMEOUT_MS`, default 10 min); a timeout is reported honestly as "did not complete",
  never as a pass.
- **Secret-refusal no longer guts auth-related work.** `SECRET_RE` matched the bare words
  `secret`/`password`/`api key`, so any task or lesson merely mentioning them was silently
  refused — disabling the LLM proposer (`adjudicate`) and blocking memory persistence
  (`recall`/`lessons`) for exactly the high-risk code you most want help on. The word arm now
  requires a value-shaped assignment (`password = "…"`, `SECRET_KEY: …`); credential _formats_
  (`sk-…`, `ghp_…`, JWTs, …) are still refused.
- **One malformed file no longer takes down memory.** `lessons_store.load`/`readEpisodes` and
  `cortex_hook.readSession` now skip a corrupt lesson file / JSONL line instead of throwing
  (which previously broke retrieval, routing, and the pre-edit advisory everywhere `load` is used).
- **`recordMistake` reports `refused` (not `created`) when a save is rejected**, so the Stop hook
  never tries to distill a phantom lesson; `applyDistillation`/`recordContradiction` surface the
  real write result too.
- **Atlas emits `inherits` edges** (`class X extends Y`; Python `class X(Base)`) — the weight was
  defined but never produced, so base-class changes were invisible to blast-radius.
- **Atlas is incremental + staleness-aware.** `build()` reuses per-file extraction by content
  hash (a sidecar cache) instead of re-parsing the whole repo; `isStale()` lets `verify` rebuild
  when the cached graph is out of date (post-edit hallucination detection was running on a stale
  atlas). A capped graph now degrades to "uncertain" rather than raising false "unknown symbol".
- **Performance:** `resolveEdges` is O(E) (was O(E·N) — a full node scan per edge); `impact()`
  reuses one memoized reverse-adjacency map across the up-to-8 calls per `substrate` run.
- **`substrate` no longer recomputes preflight twice** (or fires a redundant assumption model
  call): the gap is computed once and threaded into routing.

### Added

- **Opt-in LLM adjudication for the substrate (`FORGE_LLM=1`)** — one shared, fail-safe `claude -p` proposer (`src/adjudicate.js`) wired thinly into the assumption gate (M2), model routing (M1), impact/blast-radius, and goal-drift (M4). The model only _proposes_; every proposal is verified against the deterministic rubric, the code graph, or a grep before it can move a verdict. Off by default — behaviour is unchanged unless enabled — never blocks, and the ambient Claude Code hook stays deterministic unless `FORGE_LLM_AMBIENT=1`. `forge substrate --json` carries an `llm.provenance` map per faculty for auditability.
- **Bidirectional verified reconcile (default on when `FORGE_LLM=1`; `llm.bidirectional` in `source/substrate.json` to disable).** A verified reading may now _reduce_ caution as well as add it — clear a false "ASK FIRST" (`llm-cleared`) and route a task _down_ a tier (`llm-lowered`) — but only within `band` and never past the hard floors: the gate can't clear a task with no concrete anchor or one naming symbols/files the repo lacks, and routing can't drop below a strong-signal (algorithmic/architectural) floor. Set `llm.bidirectional: false` for the conservative tighten-/raise-only mode. Impact edges stay graph-+-grep-verified; goal-drift stays off→on with a goal-referencing reason.
- **Explicit memory `val` term** — lesson retrieval now decomposes into the white paper's `relevance × freshness × validity × scope`, with `validity()` (a ground-truth Beta posterior over confirmed vs. contradicted outcomes) exported and ranked so outcome-confirmed lessons outrank merely-recent ones.

### Changed

- **Unified the model-call path** — the Cortex distiller now shares the `adjudicate` runner instead of its own `claude` shell-out.

## [0.4.0] - 2026-07-06

### Added

- **Forge Cognitive Substrate** — one pre-action command (`forge substrate`) plus an MCP surface (`substrate_check`, `predict_impact`, `assumption_gate`, `route_task`, `scope_files`): assumption gate, transparent model routing, impact/blast-radius, scope decomposition, Cortex lessons, minimality, and a verification checklist.
- **M4 goal-anchoring (`forge anchor`)** — a deterministic goal-drift check that flags changed files off the stated goal. All 11 white-paper capabilities now ship a real mechanism.
- **Atlas v2 graph** — dependency nodes/edges + reverse-dependency impact traversal (the symbol-query API is preserved).
- **`docs/GUIDE.md`** (the complete command guide) and **`docs/RELEASING.md`** (release runbook).
- **Repo automation** — `repo-settings.yml` (About/topics/Discussions as code) and `labels.yml` (label sync) workflows; a Codex plugin manifest and `cognitive-substrate` skill; the paper bundle under `docs/cognitive-substrate/`.

### Changed

- **Publish to public npm.** `@codewithjuber/forgekit` now publishes to npmjs with provenance, so `npm install -g @codewithjuber/forgekit` needs no token (replacing the GitHub Packages route, which required auth even for public installs). The release workflow was fixed to trigger on a tag, publish, and cut a GitHub Release with generated notes.
- **Substrate auto-runs in Claude Code** via a `UserPromptSubmit` hook — it surfaces only when something needs attention and never blocks — and `forge init` emits a "run substrate before risky work" rule into every other tool's config.
- **Docs overhaul** — README rewritten (problem → solution → how, npm-first, SEO-friendly); the install, honest-limits, frozen-model, and substrate blocks are single-sourced instead of copied across files; the supported-tool list is reconciled everywhere.

### Fixed

- **Security (research prototype):** removed the pickle-based cache in `impact_oracle/world_model.py` — an insecure-deserialization (RCE) vector on a caller-supplied `cache_dir`. Now JSON node-link only, with `cache_dir` contained inside `root`.
- **Smaller npm package** — stopped publishing the ~2 MB paper bundle and the redundant `*_src.zip` (source lives unzipped under `research/`).
- **Perf** — `substrateCheck` no longer recomputes the assumption assessment.

## [0.3.1] - 2026-07-05

### Changed

- **Publish to GitHub Packages** instead of npmjs. Package renamed to the scoped
  `@codewithjuber/forgekit`; `publishConfig.registry` → `https://npm.pkg.github.com`. The
  release workflow now authenticates with the built-in `GITHUB_TOKEN` (`packages: write`) — no
  external `NPM_TOKEN` secret. A committed `.npmrc` maps the scope to the registry and sets
  `min-release-age=7` (supply-chain cooldown). Note: GitHub Packages requires consumers to
  authenticate even for public installs, so the `bash install.sh` clone path stays the
  friction-free primary channel.

## [0.3.0] - 2026-07-05

### Added

- **Forge Preflight** — a deterministic, math-first layer that runs BEFORE tokens are spent,
  on the premise that an LLM is a fixed-capacity stochastic predictor: size the task to the
  model, fill the context, detect assumptions. All advisory, never blocks.
  - **Assumption detector** (`forge preflight`, UserPromptSubmit hook): scans a task for code
    identifiers/files the repo doesn't define — what the model would otherwise ASSUME — and
    surfaces the known-unknowns so it asks instead of confabulating. The research whitespace.
  - **Complexity routing** (`forge route`): recommends the cheapest CAPABLE model
    (Haiku → Sonnet → Opus → Fable) from code-task signals (files, fan-out, churn, past-mistake
    density, ambiguity). `forge route gateway` emits a LiteLLM config for real auto-routing.
  - **Decomposition** (`forge scope`): a zero-dep import graph → connected components →
    independent clusters (run as separate sessions) + the coupled files you didn't name.
  - **Design-quality**: emitted AI-UX rules (anti-slop, WCAG, functional empty states, specific
    errors, confidence/transparency, pattern selection) + `forge uicheck` (exact WCAG contrast
    math) + a calibrated frontend-verifier that ASSERTS only the deterministic and keeps
    hierarchy/taste ADVISORY (the fix for hallucinated UI audits).
  - Cross-tool via `preflight_check` / `route_task` / `scope_files` MCP tools.

## [0.2.0] - 2026-07-05

### Added

- **Forge Cortex** — self-correcting project memory. Detects a genuine recurring mistake
  on this repo (test-fail→fix, revert, symbol thrash, explicit human undo), distills a
  structured lesson, and re-confirms it against independent outcomes — with an
  anti-self-reinforcement lifecycle (`Beta` confidence + decay; injection never confirms;
  a green build always wins) so a wrong lesson decays out instead of ossifying.
  `forge cortex`, `forge cortex why <symbol>`.
- Ambient hooks (fail-safe, never block): capture signals during a session, distill at
  `Stop`, inject learned lessons at `SessionStart`, and a `PreToolUse` advisory before a
  risky edit.
- Local error predictor (heuristic + a tiny logistic model) gated by an AUC-PR kill-switch
  — it only ships if it measurably beats the heuristic; otherwise it falls back or disables.
- Cross-tool: lessons inlined into `AGENTS.md` + a zero-dependency MCP server
  (`forge cortex-mcp`, registered in `source/mcp.json`).
- Optional LLM lesson distiller (`ENABLE_CORTEX_DISTILL=1`) — replaces the deterministic
  template with a real distilled lesson via `claude -p`.
- `forge doctor` reports Cortex lesson state; `forge catalog` lists Cortex.

## [0.1.0] - 2026-07-05

### Added

- Cross-tool config emitter (`forge sync`) — one source → each tool's native format; three
  install channels (Claude plugin + marketplace, installer, npm); `forge doctor`; code-graph
  (`atlas`); `lean` discipline; guard/skill/crew layers.
- Verification layer: `forge verify` (tests + hallucinated-symbol catch + provenance),
  doom-loop breaker guard, bias-safe `independent-reviewer` agent.
- Security gate: `forge scan` (skill-gate), `secret-redact` guard, structured
  `permissionDecision` in `protect-paths`, `forge harden` (gitleaks + sandbox).
- Cross-tool MCP emit; portable memory (`forge brain` / `forge remember`); design-taste
  menu (`forge taste`); `forge spec` spec-lock + OpenSpec wiring; MCP ~6-server hygiene
  check; coverage + type-checking (`tsc --checkJs`); 2026 production-standard rules;
  OWASP-LLM / NIST SSDF / SLSA control mapping.

[Unreleased]: https://github.com/CodeWithJuber/forgekit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.32.1...v1.0.0
[0.32.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.27.4...v0.28.0
[0.27.4]: https://github.com/CodeWithJuber/forgekit/compare/v0.27.3...v0.27.4
[0.27.3]: https://github.com/CodeWithJuber/forgekit/compare/v0.27.2...v0.27.3
[0.27.2]: https://github.com/CodeWithJuber/forgekit/compare/v0.27.1...v0.27.2
[0.27.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.26.2...v0.27.0
[0.26.2]: https://github.com/CodeWithJuber/forgekit/compare/v0.26.1...v0.26.2
[0.26.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.23.2...v0.24.0
[0.23.2]: https://github.com/CodeWithJuber/forgekit/compare/v0.23.1...v0.23.2
[0.23.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.4...v0.13.0
[0.12.4]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.3...v0.12.4
[0.12.3]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CodeWithJuber/forgekit/releases/tag/v0.1.0
