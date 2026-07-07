# 01 — The Proof-Carrying Memory (PCM) protocol

> Normative spec for the claim ledger every substrate-v2 subsystem stores its state in.
> Extends the paper's Eq. 3 `val` term ("validity-anchored memory", §7.1, §11) into a full
> storage / trust / merge protocol. Implemented in P1 as `src/ledger.js`.

## 0. Design axioms

1. **Confidence is earned, never asserted.** Only *independent oracles* — test runs,
   typecheck, CI, a human accept or revert — may move a claim's confidence. The model's
   self-assessment never does (paper C12: LLM evaluators favor their own generations;
   §7.2's write-back rule). This is already cortex's invariant in `src/lessons.js`
   ("a lesson is trusted because it keeps being RE-CONFIRMED"); PCM generalizes it to
   every stored thing.
2. **Every claim carries its proof.** A claim is inseparable from its evidence set —
   provenance, oracle outcomes, artifact references (commit SHA, test-run id). A consumer
   can always ask *why should I believe this?* and get a machine-readable answer. (The
   name is a deliberate riff on proof-carrying code: the artifact travels with the reason
   to trust it.)
3. **Merge must be conflict-free by construction.** Team memory dies the day two
   teammates' stores need manual conflict resolution. All mutable state is therefore
   modeled as grow-only sets whose merge is set union — a join-semilattice
   (see [02-team-memory.md](./02-team-memory.md)).
4. **Forgetting is a formula.** The paper's ḥifẓ/murājaʿa policy (§7.2) — retention
   through review, decay without it — is implemented as time-decayed evidence weight,
   not a cron job that deletes old files.

## 1. The claim

```
claim := {
  v:          1,                          // protocol version
  id:         sha256(canonical(kind, body, scope)),
  kind:       "lesson" | "fact" | "artifact" | "edge" | "fingerprint"
            | "diagnosis" | "decision" | "summary" | "outcome",
  body:       <kind-specific JSON>,       // the content itself
  scope:      { repo?, dir?, symbol? },   // where it applies (mirrors SCOPE_WEIGHT in lessons.js)
  provenance: { author, agent?, model?, tier?, task? , t },
  evidence:   [ outcome... ],             // grow-only, see §3
  tombstone?: { author, reason, t },      // retraction marker (grow-only too)
}
```

- `id` is content-addressed over `(kind, body, scope)` **only** — not provenance, not
  evidence — so two teammates who independently learn the same lesson produce the *same
  claim id* and their evidence merges instead of duplicating.
- **Canonicalization:** JSON with lexicographically sorted keys, no insignificant
  whitespace, NFC-normalized strings, numbers in shortest round-trip form. The canonical
  bytes are what is hashed and what is stored. (Stability of `id` under re-serialization
  is a P1 property test.)
- `body` schemas per kind are versioned in `source/pcm-kinds.json`; unknown kinds are
  preserved verbatim (forward compatibility) but never retrieved.

### Claim kinds and what they replace

| kind | body (essentials) | Replaces / powers |
|---|---|---|
| `lesson` | rule text, trigger context | cortex lessons (`src/lessons.js`) |
| `fact` | name, text | recall facts (`src/recall.js`) |
| `artifact` | spec fingerprint, code ref (path@commit or inline), declared interface | reuse cache ([03](./03-reuse-cache.md)) |
| `edge` | from-symbol, to-symbol, relation | atlas graph overlay — verified edges outrank regex guesses |
| `fingerprint` | design-token vector | UI quality gate ([07](./07-ui-quality-gate.md)) |
| `diagnosis` | failure signature, root-cause note, tried-fixes | doom-loop ([06](./06-faculties-and-mechanisms.md) §5) |
| `decision` | choice, alternatives, rationale | ADR-style team decisions, speclock |
| `summary` | source range, compressed text, coverage set | context assembly ([04](./04-context-assembly.md)) |
| `outcome` | oracle, result, refs | the write-back band itself (§6) |

## 2. The oracle taxonomy

An oracle is a source of confirm/contradict signals *external to fθ*. Each has a base
weight `w ∈ (0,1]` — its prior reliability — extending the signal table already shipped
in `src/lessons.js` (`SIGNALS` S1–S7):

| oracle | example | w | family |
|---|---|---|---|
| `human.revert` | git revert / checkout of the change (S6) | 1.0 | human |
| `human.accept` | PR merged, explicit approval | 0.9 | human |
| `test.run` | impacted test suite pass/fail (S1) | 0.8 | outcome |
| `ci.run` | pipeline result | 0.8 | outcome |
| `typecheck` | tsc/compiler on affected files (S7) | 0.6 | outcome |
| `graph.reval` | artifact interface still resolves in atlas | 0.5 | structural |
| `behavioral` | re-edit/thrash signals (S2, S3) | 0.3 | behavioral |

Rules inherited from cortex, now protocol law: **injection/retrieval is never
confirmation**; a `behavioral` signal can never move confidence alone (needs a second
family — the noisy-OR cross-family gate of `scoreMistake()`).

## 3. Evidence and confidence

```
outcome := { oracle, result: "confirm" | "contradict", w, ref, author, t }
```

`ref` points at a verifiable artifact (commit SHA, test-run id, CI URL) — evidence
without a ref is rejected at append time. Evidence records are immutable and
content-hashed; the evidence *set* is grow-only.

**Confidence** is a Beta posterior with exponential time decay. With prior `Beta(1,1)`,
half-life `T` (default 45 days), `λ = ½`, and `Δt` the age of each outcome:

```
val(c) = (1 + Σ_confirms wᵢ·λ^(Δtᵢ/T)) / (2 + Σ_all wⱼ·λ^(Δtⱼ/T))
```

Properties (each a P1 unit test):

- A fresh claim has `val = 0.5` — exactly `newLesson()`'s starting confidence today.
- Unreviewed claims decay **toward 0.5** (the prior), not toward 0: an old, once-confirmed
  claim becomes *uncertain*, not *false*. This is murājaʿa — review restores weight.
- Contradictions weigh in the denominator only, so wrong claims die faster than right
  ones grow (the asymmetry `src/lessons.js` already encodes).
- `val` is a pure function of the evidence set ⇒ identical after any merge order (needed
  for CRDT convergence in [02](./02-team-memory.md)).

**Pruning:** a claim is *dormant* below `val < 0.35` (never retrieved, kept for audit)
and *pruned* (moved to `ledger/attic/`) when dormant for > 2·T with no new evidence, or
when tombstoned. Nothing is silently deleted — the attic is the audit trail (paper §5,
17:36: "you will be questioned about all these").

## 4. Retrieval — paper Eq. 3, implemented

```
score(x, c) = σ( a·rel(x,c) + b·rec(c) + g·val(c) )        // paper §7.1 Eq. 3
```

- `rel(x,c)` — cheap path: Jaccard similarity of MinHash sketches (k = 128 hashes,
  4-token shingles over normalized text; sketches stored on the claim, so comparison is
  O(k)). Optional dep path (ADR-0005): pluggable embedding backend behind the same
  interface; falls back to MinHash offline.
- `rec(c) = λ^(Δt/T)` — same decay clock as confidence.
- `val(c)` — §3 above. **This term is the paper's load-bearing addition** — memories
  pruned by ground truth, not by the model's say-so.
- Default weights `a = 0.55, b = 0.15, g = 0.30`; stored in `source/substrate.json`,
  calibrated in P8 by logistic regression on retrieval-outcome pairs (did an injected
  claim get confirmed or contradicted downstream?).
- Scope multiplier: reuse `SCOPE_WEIGHT` (symbol 1.0 > dir 0.8 > repo 0.6 > global 0.4).

## 5. The three layers (ʿilm → fahm → ḥikma, paper §5 & §7.2)

A flat store collapses fact and understanding; the paper demands layers. In PCM the
layers are **claim kinds plus a promotion rule**, not separate databases:

| layer | claims | produced by |
|---|---|---|
| **ʿilm** (raw knowledge) | `outcome`, `fact`, `edge`, episode-grade `lesson` | hooks, oracles, direct capture |
| **fahm** (patterns) | consolidated `lesson`, `artifact`, `fingerprint`, `summary` | **consolidation** (below) |
| **ḥikma** (decision support) | `decision`, `diagnosis`, calibrated rubric weights | promotion + human ratification |

**Consolidation (the murājaʿa job, runs at session end — extends
`src/cortex_distill.js`):**

1. Cluster ʿilm-layer claims by near-duplicate similarity: union-find over pairs with
   Jaccard(sketch) ≥ τ_c (default 0.7). Union-find gives O(n α(n)) clustering without a
   pairwise matrix blowup because candidate pairs come from MinHash banding (LSH).
2. Each cluster with ≥ 3 members and mean `val` ≥ 0.6 is distilled into one fahm-layer
   claim whose evidence set is the **union** of members' evidence (id changes because the
   body changed; member claims get a `consolidated-into` pointer and go dormant).
3. Fahm claims that survive ≥ 2·T with `val` ≥ 0.8 and a human `decision` reference are
   eligible for ḥikma promotion — surfaced in `forge dash` for one-click ratification,
   never auto-promoted (stewardship boundary, 33:72).

## 6. The write-back band (paper Eq. 2, §7.2) — learning without touching θ

The substrate becomes `(y_t, M_{t+1}) = F(x_t, M_t; fθ)` only if outcomes actually flow
back into `M`. Protocol:

1. **Attribution at injection:** whenever the substrate injects claims into context
   (retrieval, cache hit, context assembly), it records the set `informed(action) =
   {claim ids}` in the session trace (`.forge/trace/`).
2. **Outcome capture:** existing guards (`session-learner.sh`, `cortex_hook.js`) plus new
   CI/test adapters emit `outcome` claims with refs.
3. **Propagation:** each outcome appends evidence to every claim in `informed(action)` —
   confirm on success signals, contradict on revert/fail — weighted by the oracle table.
   *This is the missing loop:* today a revert teaches the lesson store; after P5 it also
   demotes the cached artifact that was reused, the summary that hid the relevant detail,
   and the edge that mispredicted impact.
4. **Parametric channel** (paper §7.2 channel 2 — LoRA distillation) stays **out of
   scope**: deliberate, offline, and not needed for any P1–P8 gate. Recorded here so the
   omission is a decision, not a gap.

## 7. Module plan (P1)

- `src/ledger.js` — pure core: canonicalize, hash, append-evidence, `val()`, `score()`,
  MinHash sketch, consolidation clustering. No fs. (Mirrors the `lessons.js` /
  `lessons_store.js` purity split.)
- `src/ledger_store.js` — file layout + atomic writes ([02](./02-team-memory.md) owns the
  on-disk format).
- Migration: `lessons` and `recall` become thin adapters minting `lesson`/`fact` claims;
  their public CLI (`forge cortex`, `forge remember`, `forge recall`) is unchanged; their
  existing tests must pass unmodified against the adapter (the P1 acceptance gate).
  `SECRET_RE` refusal moves down into `ledger.js` so *no* claim kind can store a secret.
- Optional index (ADR-0005): SQLite mirror for O(log n) retrieval on big ledgers;
  JSON-file scan remains the reference implementation and offline fallback.
