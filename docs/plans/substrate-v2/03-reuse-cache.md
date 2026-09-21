# 03 — The proof-carrying reuse cache

> "Reuse already-generated code" as a deterministic system, not a skill exhortation.
> Turns `global/tools/reuse-first/` from prose into the advisory layer over a real cache.
> Addresses the duplication trend the paper cites (C4 — direction confirmed, multiplier
> disputed) and is the largest single lever in the cost model
> ([05](./05-cost-model.md)). Phase P3.

## 0. The idea

Every artifact the agent generates and *verifies* (tests passed, human accepted) becomes
an `artifact` claim in the ledger — code that travels with its proof. Before generating
anything, the substrate asks the cache: *have we, or any teammate, already built this?*
A hit returns the artifact **with its evidence attached** and skips generation entirely;
via the team ledger ([02](./02-team-memory.md)), one teammate's verified work is
everyone's cache hit.

Why this beats naive LLM response caching: responses are keyed to prompts (brittle,
provider-side, trustless). PCM artifacts are keyed to *normalized task specs + codebase
context*, survive rewording (near-match), and are only served while their proof still
holds (revalidation + `val` floor). A stale or discredited artifact silently stops being
served — the cache prunes itself by ground truth.

## 1. Artifact claim body

```
artifact.body := {
  key:        IDENTITY-normalized task text (case/whitespace/punctuation only),
  spec:       SHAPE-normalized task specification text,
  sketch:     MinHash sketch of spec (for near-match),
  slice:      sha256 of the atlas graph slice the artifact touches,   // context key
  interface:  [ exported symbols + signatures the artifact declares ],
  deps:       [ symbols the artifact requires from the codebase ],
  code:       { path, commit } | { inline },       // committed code by ref, snippets inline
  lang, kind: "function" | "module" | "component" | "config" | "test",
}
```

## 2. Fingerprinting

**Normalization comes in two forms**, because "the same task" and "the same
neighbourhood" are different questions:

- **identity** (`key`): Unicode-aware tokens, lowercased, edge punctuation dropped,
  whitespace collapsed — and NOTHING else. Identifiers, paths and numbers stay verbatim.
- **shape** (`spec`): identity plus typed placeholders for identifiers, paths, numbers and
  string literals (`⟨ident⟩`, `⟨path⟩`, `⟨num⟩`, `⟨str⟩`).

The shape form alone once keyed the exact tier, which made "add pagination to listOrders"
an EXACT hit on the listUsers artifact (similarity 1), and — because the tokenizer was
ASCII-only — made any two non-ASCII specs identical. Identity keys the tiers that serve
code as-is; shape only keys the adapt tier, which asks for the delta.

**Keys per artifact:**

- `exact = sha256(identity key ‖ slice)` — O(1) lookup for the literal repeat.
- `keySketch = MinHash_k(shingles₄(identity key))`, k = 128 — the NEAR bar (τ = 0.8).
  `E[|sketch match|/k] = Jaccard(A,B)`, an unbiased Jaccard estimator with standard error
  `≈ √(J(1−J)/k)` ≤ 0.045.
- `sketch = MinHash_k(shingles₄(shape))` — the ADAPT bar (τ = 0.6) and the LSH prefilter.
  Banding is 32 bands × 4 rows: collision probability `1−(1−J⁴)³²` ≈ 1.00 at J = 0.8,
  0.99 at J = 0.6 (the adapt bar), 0.56 at J = 0.4, 0.23 at J = 0.3. (The previous 16×8
  banding was documented as ≈0.96 at J = 0.8 / ≈0.17 at J = 0.5; the true figures were
  0.95 and 0.06, and recall at the adapt bar was 0.24 — the prefilter dropped three of
  every four adapt candidates.)

## 3. The lookup ladder

```
reuse(x):
  1. exact hit  (same identity key, same slice)       → serve, cost ≈ 0
  2. near hit   (identity Jaccard ≥ 0.8)              → REVALIDATE, then serve-with-diff
  3. adapt hit  (identity or shape Jaccard ≥ 0.6)     → inject artifact as context ("start
                                                        from this verified code"), generate
                                                        the delta only — cheaper prompt,
                                                        strong anchor against re-invention
  4. miss                                             → generate; on verification, mint
                                                        the artifact claim (cache fill)
```

**Serving conditions (all three, always):**

1. `val(artifact) ≥ 0.6` — the proof-carrying floor; contradicted artifacts stop serving
   automatically via the write-back band.
2. **Revalidation against the current atlas:** every symbol in `deps` still resolves
   (`atlas.has()`), and nothing in the current graph shadows `interface`. A cache serving
   code whose dependencies vanished is worse than a miss. Structural revalidation emits a
   `graph.reval` outcome (w = 0.5) — so even serving keeps evidence fresh.
3. Secret scan on serve (paranoia; artifacts were already scanned at mint).

**After serving:** the reuse event enters `informed(action)` — if the reused code is then
reverted, the artifact's `val` drops (write-back band, [01](./01-pcm-protocol.md) §6).
The cache is thus self-correcting end-to-end: filled by verification, served by proof,
demoted by outcomes, evicted by decay.

**Eviction** = the ledger's standard policy (dormant < 0.35, attic after 2·T) — no
separate LRU machinery.

## 4. Where it hooks in

- `substrateCheck()` (`src/substrate.js`) gains a reuse stage between preflight and
  route: a hit short-circuits generation; an adapt-hit rewrites the prompt.
- `forge reuse query|stats|mint` CLI for inspection and manual seeding.
- The `reuse-first` skill is rewritten to *call* the cache and explain its answer —
  advisory prose backed by a deterministic lookup (guard-over-prose, ADR-0003).
- Metrics per lookup (`hit_exact | hit_near | hit_adapt | miss`, tokens saved estimate)
  → `.forge/metrics.jsonl` → [05-cost-model.md](./05-cost-model.md) and `forge dash`.

## 5. Honest limits

- Near-match on MinHash is lexical: "sort users by signup date" vs "order accounts by
  registration time" may score < 0.8 and fall to adapt-tier or miss. The optional
  embedding backend (ADR-0005) raises near-hit recall; MinHash stays the offline floor.
- The `slice` key makes hits context-sensitive: a utility generated for one dependency
  neighborhood won't exact-hit in a different one (by design — that's how stale context
  is excluded), which caps the hit rate on fast-moving code. Adapt-tier exists precisely
  to salvage value there.
- Cache hit *rate* is workload-dependent; the 90 % cost story only cites what P8
  measures.
