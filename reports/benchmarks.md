# Benchmarks — measured numbers only

> Discipline ([05-cost-model.md](../docs/plans/substrate-v2/05-cost-model.md), whitepaper C6):
> **a number is an assumption until measured.** Every figure in the generated section below
> came from an actual run of `npm run bench` on the machine recorded in the environment
> block — no projections, no targets, no numbers copied forward from a different machine.
> Re-run `npm run bench` (≈10 s, node stdlib only) and the generated section is rewritten
> in place with your machine's numbers.

## Methodology

- **Median of N runs after warmup.** Each row states its own `runs`; warmup runs (1–3 per
  row) are executed and discarded so JIT compilation and cold module state don't pollute
  the samples. p95 is nearest-rank — with fewer than 20 samples that is simply the max,
  reported as such rather than smoothed.
- **Timing** is `performance.now()` around the call, single process, no concurrency.
- **Repo-scale benchmarks** (atlas, context, substrate, impact quality) run against a copy
  of this repo in `os.tmpdir`, excluding `bench/` (so the harness's own imports don't
  perturb the impact-quality eval) and dot-directories (`.git`, `.forge` — the copy starts
  cold). The copy is deleted afterwards.
- **Synthetic fixtures** (ledger, reuse) are generated with a seeded PRNG (mulberry32,
  fixed seeds) — byte-identical fixtures on every run and machine — built in `os.tmpdir`
  and cleaned up.

### What each number does — and does not — mean

- **atlas / full build**: directory walk + read + regex extraction + edge resolution +
  writing `.forge/atlas.json` and the per-file cache, on this repo's file count (recorded
  in the row's notes). Repo-shape-specific; not comparable across repos.
- **atlas / incremental rebuild (unchanged)**: by design the incremental path still reads
  and re-hashes every tracked file — the saving over a full build is the skipped regex
  extraction only. This row is that claim, measured.
- **atlas / impact query**: marginal per-query latency with the memoized reverse-adjacency
  index already built (it is built once per atlas and cached — `ADJ_CACHE` in
  `src/atlas.js`). The first query on a fresh atlas additionally pays that index build.
- **ledger / mint+put**: `mintClaim` + `putClaim` per claim (synchronous file write each),
  with one evidence append every 4th claim. Disk-bound; the throughput figure is
  claims/sec at the row's median. This is the noisiest row in the file: on a shared or
  virtualized disk, back-to-back invocations of the whole bench have produced medians
  from ~150 ms to ~830 ms for this row (4–6×) while the CPU-bound rows moved by percents
  — read it as "thousands of claims/sec, I/O-dominated", not as a stable constant of the
  code.
- **ledger / mergeDirs**: replica directories are pre-copied *outside* the timing; the
  number is `loadState` of both sides + semilattice union + idempotent re-puts + reindex.
- **ledger / val()**: pure in-memory scoring; the fixture gives most claims 0–1 evidence
  records, and val() cost scales with evidence count — a heavily-evidenced ledger will be
  slower per claim.
- **reuse / lookup**: every row is VALIDATED before it is timed — the fixture's artifacts
  cite a real, resolvable git object as their test evidence, and the harness aborts unless
  the lookup returns the tier the row is labeled with (review F14, 2026-09-26: the previous
  fixture cited untyped `bench:artifact:<i>` refs, which val() caps below the serving floor,
  so every "exact"/"near" row had actually measured a MISS; those older numbers are
  invalid). "cold" rows strip every memoized sketch the lookup path caches (`_sketch`,
  `_terms`, `_specSketch`, `_keySketch` — the old harness stripped only `_sketch`, which the
  reuse ladder never reads), so each run behaves like a fresh CLI process; "warm" rows keep
  them, like a long-lived process. The *exact* tier returns before any pool sketching
  (identity-key compare); *near* and *miss* pay MinHash-sketching the candidate pool plus
  LSH banding — that difference is the point of reporting them separately.
- **context / assemble()**: warm atlas, empty ledger (the repo copy has no `.forge`),
  includes the real file reads for pinned items. Task: a three-symbol, one-file edit spec.
  "complete"/"incomplete" is the assembler's own honest verdict: an item that could only
  be delivered as a pointer or partial span is a pending read, so a large named file makes
  this task's context incomplete at the default budget (review F02/F03).
- **substrate / substrateCheck**: the whole deterministic gate — preflight grounding,
  routing rubric, up to 8 impact queries, reuse lookup, context assembly, scope
  decomposition, lessons, minimality, goal anchor — with `llm: false`. **No model latency
  is included anywhere in this file**; with LLM adjudication enabled, wall time is
  dominated by the model call, which is exactly why it ships opt-in.

Micro-medians below ~1 ms are subject to GC/JIT jitter even after warmup; treat them as
order-of-magnitude, not three-significant-digit truths.

### Impact-oracle quality: how the labels were made

Cases live in [`bench/impact_cases.mjs`](../bench/impact_cases.mjs), scored by
`evalImpact()` (`src/eval.js`). Labeling rule: `expected` = the defining file plus every
file with a **direct reference** (an `import { X }` — static, dynamic or aliased — with a
use, or a call site) — each one listed, per file and per line, in the fixture's comments.
The labels are **ground truth, not the graph's own output**: every one is re-derived with
`git grep -n -w -F -e <symbol> -- 'src/*' 'test/*'` and confirmed by reading each hit, and a
name that appears only in a comment or inside a string (an assertion message, a doc line) is
not a reference and is not labeled — the omissions are listed too, so a re-check can tell
"deliberate" from "missed".

Transitive dependents are *not* labeled, so the oracle's transitive predictions count
against precision — the same over-approximation penalty the paper's mutation-derived
scoring applied. **That penalty is now most of the number.** `impact()` walks reverse
dependencies transitively by default (`maxHops: 6`), so for `contentHash` it returns 89
files where 10 are directly labeled. Restricted to one hop it returns exactly the 10
labeled files plus one documentation edge — i.e. the precision figure below measures the
gap between "everything downstream" and "the direct referencers", not a graph that is
wrong about who calls what. Read precision here as *how much wider than the direct set the
default answer is*, and recall as *does it ever miss a direct referencer* (it does not).

`contentHash` used to carry a genuine false negative — `src/atlas.js` binds it to an alias,
`const hash = contentHash;`, with no call parentheses, and the old import regex captured
module paths rather than named bindings, so nothing reached `atlas.js`. Import specifiers
now resolve to the exact symbol (`src/atlas.js:17 imports → src/util.js:contentHash:65`) and
`atlas.js` is predicted at one hop; the case is kept for its fan-out, not for the miss.

What these numbers do **not** mean: n = 6 cases, one JavaScript repo, symbols chosen to be
uniquely named (the atlas resolves ambiguous names to nothing — a separate, known
limitation). They are not comparable to the paper prototype's numbers: its 0.63 / 1.00 /
0.75 came from mutation testing on the authors' own fixture — a self-built demo that the
pre-registered field study REFUTED (pooled precision 0.40, recall 0.022, F1 0.042 over 759
files' mined co-change in nine repositories; see `research/empirical-refutation/`). The
regex atlas here is a different, Node graph — not the evaluated Python oracle. All three
appear side by side below, labeled, and are never blended.

> **History of this row.** The precision 0.90 / F1 0.92 this file carried until 2026-09-21 came
> from a much smaller atlas (145 files) and a reverse walk that stopped at the direct
> referencers. Two things changed since: `impact()` now walks reverse dependencies
> transitively by default, and four of the six label sets had gone stale against the source.
> Re-labelling every case from `git grep` and re-running `npm run bench` gives the generated
> table below — precision **0.17**, recall **1.00**, F1 **0.29** (edited-file-only baseline
> recall 0.27), where the precision loss is the transitive closure being scored against
> direct-only labels, not a graph that is wrong about who calls what (at one hop the six cases
> return their labeled sets). Neither figure is field evidence: on nine real Python
> repositories the paper's prototype oracle reached recall **0.022**
> ([research/empirical-refutation/](../research/empirical-refutation/)), and its "recall 1.00"
> row below comes from five mutations of its own demo package. The generated block is rewritten
> only by `npm run bench`.

<!-- BENCH:RESULTS:BEGIN (generated by bench/bench.mjs — do not edit) -->

### Environment (machine section)

```json
{
  "node": "v22.22.2",
  "cpu": "Intel(R) Xeon(R) Processor @ 2.80GHz",
  "cores": 4,
  "memGB": 16,
  "platform": "linux",
  "arch": "x64",
  "fsType": "ext2/ext3",
  "commit": "d2abfa69fb77531199ffc67c5c076b524af69040 + uncommitted changes",
  "date": "2026-09-26T20:14:48.438Z"
}
```

### Measured results

| suite     | benchmark                                    | median  | p95     | runs | notes                                                        |
|-----------|----------------------------------------------|---------|---------|------|--------------------------------------------------------------|
| atlas     | full build (this repo)                       | 794 ms  | 970 ms  | 5    | 496 files, 13278 symbols, 36899 edges, cap 20000 not reached |
| atlas     | incremental rebuild (unchanged)              | 385 ms  | 550 ms  | 5    | per-file hash cache hit                                      |
| atlas     | impact("claimText") (warm adjacency)         | 1.10 ms | 1.56 ms | 30   | 57 files impacted                                            |
| ledger    | mint+put 1000 claims                         | 266 ms  | 332 ms  | 5    | 3,762/s                                                      |
| ledger    | loadClaims at 1000 claims                    | 15.1 ms | 15.7 ms | 5    | full state from disk                                         |
| ledger    | mergeDirs 2×500-claim replicas (250 shared)  | 229 ms  | 241 ms  | 3    | +250 claims, +313 records                                    |
| ledger    | val() over 1000 claims                       | 0.59 ms | 1.93 ms | 20   | 1,687,379/s (mean val 0.51)                                  |
| reuse     | fingerprint 2000 specs                       | 233 ms  | 315 ms  | 5    | 8,585/s                                                      |
| reuse     | lookup exact hit, cold @ 100 artifacts       | 1.15 ms | 10.6 ms | 10   | tier=exact                                                   |
| reuse     | lookup exact hit, warm @ 100 artifacts       | 0.51 ms | 4.98 ms | 10   | tier=exact                                                   |
| reuse     | lookup near hit (LSH), cold @ 100 artifacts  | 10.9 ms | 17.2 ms | 5    | tier=near, j=0.98                                            |
| reuse     | lookup miss, cold @ 100 artifacts            | 10.6 ms | 15.6 ms | 5    | tier=miss                                                    |
| reuse     | lookup exact hit, cold @ 1000 artifacts      | 3.74 ms | 5.02 ms | 10   | tier=exact                                                   |
| reuse     | lookup exact hit, warm @ 1000 artifacts      | 3.32 ms | 4.08 ms | 10   | tier=exact                                                   |
| reuse     | lookup near hit (LSH), cold @ 1000 artifacts | 122 ms  | 138 ms  | 5    | tier=near, j=0.95                                            |
| reuse     | lookup miss, cold @ 1000 artifacts           | 131 ms  | 141 ms  | 5    | tier=miss                                                    |
| context   | assemble() (this repo, 3-symbol task)        | 17.4 ms | 19.7 ms | 10   | 4174/6000 tokens, 9 required, incomplete                     |
| substrate | substrateCheck (allowBuild, llm off)         | 880 ms  | 962 ms  | 3    | 136 impacted files, route simple                             |

### Impact-oracle quality (hand-labeled cases, this repo)

| case (target) | precision | recall | F1   | predicted | truth |
|---------------|-----------|--------|------|-----------|-------|
| normalizeSpec | 0.11      | 1.00   | 0.20 | 18        | 2     |
| evalImpact    | 0.29      | 1.00   | 0.44 | 7         | 2     |
| isStale       | 0.19      | 1.00   | 0.32 | 37        | 7     |
| mergeStates   | 0.15      | 1.00   | 0.27 | 26        | 4     |
| claimText     | 0.18      | 1.00   | 0.30 | 57        | 10    |
| contentHash   | 0.11      | 1.00   | 0.20 | 100       | 11    |
| mean of 6     | 0.17      | 1.00   | 0.29 |           |       |

Edited-file-only baseline recall over the same cases: **0.26**.

Different methodologies, side by side — different codebases, different ground-truth
derivations, so the rows are comparable in spirit only and are never blended:

| series                                         | precision | recall | F1   | ground truth                                               |
|------------------------------------------------|-----------|--------|------|------------------------------------------------------------|
| paper prototype, self-built demo (REFUTED)     | 0.63      | 1.00   | 0.75 | mutation testing on the authors' own fixture               |
| paper prototype, field study (pooled, 9 repos) | 0.40      | 0.02   | 0.04 | 759 files' mined co-change (research/empirical-refutation) |
| this repo (regex atlas, hand-labeled)          | 0.17      | 1.00   | 0.29 | 6 hand-labeled cases (bench/impact_cases.mjs)              |

<!-- BENCH:RESULTS:END -->

> **Snapshot boundary.** The measured results above were generated at commit `eb68ea9` and
> do not benchmark the optional embedding adapter now implemented in `src/embed.js` and
> exercised with a deterministic fake provider in `test/embed.test.js`. MinHash remains the
> zero-dependency default and failure fallback. The structural comparisons below describe the
> current source; they do not imply that Forgekit bundles an embedding model or vector database.

## Uniqueness — structural contrasts with adjacent tools

Adjacent tools per [ecosystem_map.md](../docs/cognitive-substrate/ecosystem_map.md). Every
row is a **structural** claim checkable from the named spec/source — no adjectives, no
multipliers. The last row of each table points the other way: what the adjacent tools do
that forgekit structurally does not.

### Validity-anchored claims vs note stores (Mem0, claude-mem, Auto Memory)

| structural property | forgekit PCM ledger | note stores |
|---|---|---|
| confidence moved only by independent oracles | yes — the `ORACLES` table in `src/ledger.js` is the closed set of who may move confidence; evidence without a verifiable ref is rejected (`outcomeRecord`) | no — notes are stored as written; no oracle taxonomy exists |
| stored evidence weight distrusted | yes — `val()` re-reads weight from the `ORACLES` table, never the stored record; `verify()` flags a recorded weight that disagrees with the table | n/a — there are no evidence records to forge |
| retrieval ranks by verified validity | yes — Eq. 3 score includes a `g·val` term (`EQ3_WEIGHTS`, `score()` in `src/ledger.js`) | no — similarity and/or recency only |
| unreviewed knowledge decays toward *uncertainty*, not deletion | yes — time-decayed Beta posterior pulls val back to the 0.5 prior; below 0.35 a claim goes dormant but is kept for audit (`DORMANT_VAL`) | no — a note persists unchanged until manually deleted or compacted |
| conflict-free team merge | yes — claim bytes are a pure function of (kind, body, scope); logs are hash-deduped unions; merge is a join-semilattice (`mergeStates`, property-tested), with a `merge=union` gitattributes rule | no — per-machine SQLite or a hosted store; no CRDT merge contract |
| self-confirmation cannot buy trust | yes — `authorTrust()` excludes an author's own evidence on their own claims | no equivalent mechanism |
| secrets refused at write time | yes — `SECRET_RE` enforced at both `mintClaim` and `putClaim` | not a protocol invariant |
| **what the note stores have that forgekit doesn't** | — | hosted sync, web UI, a bundled embedding/index service, and LLM summarization pipelines; forgekit stores its ledger as files in git and can call an optional user-supplied embedding provider, with MinHash as the default and fallback |

### Transparent routing rubric vs LLM gateways (LiteLLM, OpenRouter, Portkey)

| structural property | forgekit `forge route` | LLM gateways |
|---|---|---|
| routing decision visible *before* dispatch | yes — returns band, signals, and per-signal reasons the user can read and override (`src/route.js`) | decision is made inside the proxy at request time |
| rubric versioned in the repo | yes — deterministic scoring over `src/model_tiers.json`, diffable in PRs | routing/cost logic lives in gateway config or the provider's service |
| same input ⇒ same route | yes — the exemplar k-NN rubric is deterministic (same text, same neighbors, same score); LLM adjudication is opt-in and clamped inside band rails (a proposal can never jump past them) | depends on gateway load/cost/failover state |
| **what the gateways have that forgekit doesn't** | — | they actually *move traffic*: proxying, failover, quotas, key management. `forge route` is advisory and at most **emits** a LiteLLM config exposing its tiers as aliases (`src/route.js`) — it is a transparency layer over gateways, not a replacement |

### Proof-carrying reuse vs plain RAG retrieval

| structural property | forgekit reuse cache | plain RAG |
|---|---|---|
| serving gated on verification evidence | yes — `SERVE_FLOOR = 0.6` (`src/reuse.js`); a fresh, unverified mint sits at the 0.5 prior and is **not** served, whatever its similarity | serves on similarity alone |
| retrieved code revalidated against the current code graph | yes — `revalidate()` checks every declared dep still resolves in the atlas before a hit is served | no dependency contract on retrieved chunks |
| cache demotes itself on ground truth | yes — a failed revalidation appends `graph.reval` *contradict* evidence to the ledger (`reuseQuery`), and the demotion reaches teammates through the merge | index reflects content until re-embedded; retrieval outcomes don't feed back |
| explicit hit tiers with committed thresholds | yes — exact / near (J ≥ 0.8) / adapt (J ≥ 0.6) ladder with LSH banding (`NEAR_J`, `ADAPT_J`, `bandKeys`) | top-k cosine; thresholds are informal per deployment |
| **what RAG has that forgekit doesn't** | — | document ingestion and chunking, a managed or persistent vector index, citation assembly, arbitrary-corpus retrieval, and hosted scaling; Forgekit's optional embedding adapter improves similarity for its curated claims and artifacts, but it does not provide those RAG pipeline components |

## Reproduce

```sh
npm run bench   # ≈10 s; prints the tables and rewrites the generated section above
npm test        # includes a smoke test of the harness's pure helpers (test/bench.test.js)
```
