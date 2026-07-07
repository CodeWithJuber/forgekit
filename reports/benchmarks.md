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
- **reuse / lookup**: the memoized `_sketch` cache is stripped before every timed run, so
  each run behaves like a fresh CLI process. The *exact* tier returns before any pool
  sketching (normalized-string compare); the *near* tier pays MinHash-sketching the whole
  candidate pool plus LSH banding — that difference is the point of reporting both.
- **context / assemble()**: warm atlas, empty ledger (the repo copy has no `.forge`),
  includes the real file reads for pinned items. Task: a three-symbol, one-file edit spec.
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
file with a **direct, hand-verified reference** (an `import { X }` with a use, or a call
site) — each one listed, per file, in the fixture's comments, checkable with grep.
Transitive dependents are *not* labeled, so the oracle's transitive predictions count
against precision — the same over-approximation penalty the paper's mutation-derived
scoring applied. The set deliberately includes one case (`contentHash`) with a reference
the regex atlas is **known to miss** (`src/atlas.js` binds it to an alias without calling
it: `const hash = contentHash;` — no call parentheses, and the JS import regex captures
module paths, not named bindings), so recall is measured against a documented false
negative rather than a curated-to-be-perfect set.

What these numbers do **not** mean: n = 6 cases, one JavaScript repo, symbols chosen to be
uniquely named (the atlas resolves ambiguous names to nothing — a separate, known
limitation). They are not comparable to the paper's numbers, which came from mutation
testing a Python codebase against a real test suite. The two appear side by side below,
labeled, and are never blended.

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
  "commit": "eb68ea97dbbf226580fd9a03cef26806c15bc2e9",
  "date": "2026-07-07T19:36:54.342Z"
}
```

### Measured results

| suite     | benchmark                                   | median  | p95     | runs | notes                                  |
|-----------|---------------------------------------------|---------|---------|------|----------------------------------------|
| atlas     | full build (this repo)                      | 131 ms  | 140 ms  | 5    | 145 files, 2777 symbols, 7892 edges    |
| atlas     | incremental rebuild (unchanged)             | 55.7 ms | 75.9 ms | 5    | per-file hash cache hit                |
| atlas     | impact("claimText") (warm adjacency)        | 0.43 ms | 0.51 ms | 30   | 5 files impacted                       |
| ledger    | mint+put 1000 claims                        | 834 ms  | 994 ms  | 5    | 1,199/s                                |
| ledger    | loadClaims at 1000 claims                   | 55.8 ms | 56.1 ms | 5    | full state from disk                   |
| ledger    | mergeDirs 2×500-claim replicas (250 shared) | 158 ms  | 188 ms  | 3    | +250 claims, +313 records              |
| ledger    | val() over 1000 claims                      | 0.28 ms | 0.42 ms | 20   | 3,547,798/s (mean val 0.53)            |
| reuse     | fingerprint 2000 specs                      | 142 ms  | 152 ms  | 5    | 14,043/s                               |
| reuse     | lookup exact @ 100 artifacts                | 0.12 ms | 0.16 ms | 10   | tier=exact                             |
| reuse     | lookup near (LSH) @ 100 artifacts           | 9.96 ms | 13.5 ms | 5    | tier=near, j=0.98                      |
| reuse     | lookup exact @ 1000 artifacts               | 0.43 ms | 0.76 ms | 10   | tier=exact                             |
| reuse     | lookup near (LSH) @ 1000 artifacts          | 107 ms  | 110 ms  | 5    | tier=near, j=0.95                      |
| context   | assemble() (this repo, 3-symbol task)       | 3.80 ms | 8.94 ms | 10   | 2617/6000 tokens, 9 required, complete |
| substrate | substrateCheck (allowBuild, llm off)        | 118 ms  | 120 ms  | 3    | 18 impacted files, route simple        |

### Impact-oracle quality (hand-labeled cases, this repo)

| case (target) | precision | recall | F1   | predicted | truth |
|---------------|-----------|--------|------|-----------|-------|
| normalizeSpec | 1.00      | 1.00   | 1.00 | 2         | 2     |
| evalImpact    | 1.00      | 1.00   | 1.00 | 2         | 2     |
| isStale       | 1.00      | 1.00   | 1.00 | 4         | 4     |
| mergeStates   | 1.00      | 1.00   | 1.00 | 3         | 3     |
| claimText     | 1.00      | 1.00   | 1.00 | 5         | 5     |
| contentHash   | 0.38      | 0.83   | 0.53 | 13        | 6     |
| mean of 6     | 0.90      | 0.97   | 0.92 |           |       |

Edited-file-only baseline recall over the same cases: **0.33**.

Two methodologies, side by side — different codebases, different ground-truth
derivations, so the rows are comparable in spirit only and are never blended:

| series                                     | precision | recall | F1   | ground truth                                  |
|--------------------------------------------|-----------|--------|------|-----------------------------------------------|
| paper prototype (Python, mutation-derived) | 0.63      | 1.00   | 0.75 | mutation testing against a real suite         |
| this repo (regex atlas, hand-labeled)      | 0.90      | 0.97   | 0.92 | 6 hand-labeled cases (bench/impact_cases.mjs) |

<!-- BENCH:RESULTS:END -->

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
| **what the note stores have that forgekit doesn't** | — | hosted sync, web UI, embedding-based semantic search, LLM summarization pipelines; forgekit's ledger is files-in-git with MinHash similarity only |

### Transparent routing rubric vs LLM gateways (LiteLLM, OpenRouter, Portkey)

| structural property | forgekit `forge route` | LLM gateways |
|---|---|---|
| routing decision visible *before* dispatch | yes — returns band, signals, and per-signal reasons the user can read and override (`src/route.js`) | decision is made inside the proxy at request time |
| rubric versioned in the repo | yes — deterministic scoring over `src/model_tiers.json`, diffable in PRs | routing/cost logic lives in gateway config or the provider's service |
| same input ⇒ same route | yes — regex rubric is deterministic; LLM adjudication is opt-in and clamped inside band rails (a proposal can never jump past them) | depends on gateway load/cost/failover state |
| **what the gateways have that forgekit doesn't** | — | they actually *move traffic*: proxying, failover, quotas, key management. `forge route` is advisory and at most **emits** a LiteLLM config exposing its tiers as aliases (`src/route.js`) — it is a transparency layer over gateways, not a replacement |

### Proof-carrying reuse vs plain RAG retrieval

| structural property | forgekit reuse cache | plain RAG |
|---|---|---|
| serving gated on verification evidence | yes — `SERVE_FLOOR = 0.6` (`src/reuse.js`); a fresh, unverified mint sits at the 0.5 prior and is **not** served, whatever its similarity | serves on similarity alone |
| retrieved code revalidated against the current code graph | yes — `revalidate()` checks every declared dep still resolves in the atlas before a hit is served | no dependency contract on retrieved chunks |
| cache demotes itself on ground truth | yes — a failed revalidation appends `graph.reval` *contradict* evidence to the ledger (`reuseQuery`), and the demotion reaches teammates through the merge | index reflects content until re-embedded; retrieval outcomes don't feed back |
| explicit hit tiers with committed thresholds | yes — exact / near (J ≥ 0.8) / adapt (J ≥ 0.6) ladder with LSH banding (`NEAR_J`, `ADAPT_J`, `bandKeys`) | top-k cosine; thresholds are informal per deployment |
| **what RAG has that forgekit doesn't** | — | dense embeddings catch paraphrase and cross-language semantics that token-level MinHash misses; RAG works over any corpus with zero curation — the reuse cache only holds artifacts someone minted *with proof* |

## Reproduce

```sh
npm run bench   # ≈10 s; prints the tables and rewrites the generated section above
npm test        # includes a smoke test of the harness's pure helpers (test/bench.test.js)
```
