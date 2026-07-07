# 02 — Team & shared memory: a git-native CRDT ledger

> How teammates share one substrate memory with zero sync infrastructure and zero merge
> conflicts. Implements the paper's Memory faculty residual gap — "no standard,
> tool-agnostic, durable memory layer that persists project knowledge … across sessions,
> tools, and **teammates**" (ecosystem map, Memory row). Phase P2.

## 0. Why git, why CRDT

Teams already share exactly one replicated, offline-capable, access-controlled store: the
repository. Any bespoke memory server re-solves auth, backup, and offline for worse
adoption. So the ledger lives *in the repo*, and the only hard problem left is merging —
which we make impossible to get wrong by choosing state that merges as **set union**.

**The math.** Let a ledger state be `S = (C, E, D)`: the set of claims, the set of
evidence records, the set of tombstones — all grow-only, all content-addressed. Define
merge `S₁ ⊔ S₂ = (C₁∪C₂, E₁∪E₂, D₁∪D₂)`. Since `(P(X), ∪)` is a join-semilattice and a
product of semilattices is a semilattice, `⊔` is **commutative, associative, and
idempotent**. Therefore any two replicas that have seen the same updates converge to the
same state regardless of merge order or repetition — the standard state-based CRDT
(CvRDT) convergence argument. Derived values (`val`, retrieval scores) are pure functions
of `S`, so they converge too. There is nothing to resolve, ever.

What makes this legal is a PCM protocol rule ([01](./01-pcm-protocol.md)): claims are
**immutable by id** and every mutable thing (evidence, tombstones, consolidation
pointers) is an add-only record. "Update" = append; "delete" = tombstone.

## 1. On-disk layout

```
.forge/ledger/
  claims/<id-prefix-2>/<id>.json     # canonical claim body+provenance, immutable
  evidence/<claim-id>.log            # one canonical-JSON outcome per line, append-only
  attic/                             # pruned claims (audit trail, not retrieved)
  LEDGER.md                          # generated human index (like recall's MEMORY.md)
```

- One **file per claim**: two teammates minting different claims touch different paths —
  git merges trivially.
- Same claim independently minted by both (same content ⇒ same id ⇒ same path, byte-equal
  canonical file): identical content merges clean.
- **Evidence logs** are the only files two people append to concurrently. Git's default
  line-merge already unions non-overlapping appends; we declare it explicitly:

```
# .gitattributes (emitted by forge init)
.forge/ledger/evidence/*.log merge=union
```

  Line order may differ between replicas — harmless, because `val` is order-independent
  (a sum) and lines are deduplicated by content hash on read. `forge ledger verify`
  re-canonicalizes: sorts by `(t, hash)`, drops duplicate lines, checks every line parses
  and every ref format is valid. Run as a pre-commit guard (`global/guards/`) so the
  committed state is always normal-form.

## 2. CLI surface (P2)

| command | does |
|---|---|
| `forge ledger merge` | semilattice merge of two ledger trees (used as a git merge driver for pathological cases, and for importing a ledger from another repo/branch) |
| `forge ledger verify` | normal-form check + schema + secret scan; CI-friendly exit code |
| `forge ledger blame <id>` | provenance + evidence history of a claim — who learned it, what confirmed it |
| `forge ledger stats` | counts by kind/layer, val distribution, decay report |

## 3. Trust, attribution, and scope

- `provenance.author` (git identity) rides on every claim and every evidence record.
- **Per-author trust weight** `u(author) ∈ [0.5, 1]` multiplies evidence weight `w`.
  It is itself computed from the ledger: the historical confirm rate of that author's
  claims (Beta posterior again — authors whose claims keep being contradicted contribute
  less). Bootstrap value 1.0; floor 0.5 so no teammate is silenced.
- Sharing boundary: `.forge/ledger/` is repo-scoped and travels with the repo. The
  existing global store (`~/.forge`) remains personal; `forge brain` continues to inline
  a *curated* subset into AGENTS.md for agents that read nothing else. Promotion from
  personal → repo ledger is an explicit `forge remember --share` act, never automatic.
- **Secrets:** `SECRET_RE` refusal (now in `ledger.js`) applies at mint *and*
  `forge ledger verify` re-scans on commit — defense in depth matching
  `secret-redact.sh`.

## 4. Retraction and disputes

- Retraction = tombstone claim (grow-only set `D`): the claim stops being retrieved
  everywhere after sync, but history remains auditable in the attic.
- Disagreement between teammates is *not* a merge conflict — it is two evidence streams
  on one claim. If Alice's tests confirm what Bob's revert contradicts, `val` settles
  near the weighted evidence balance and the claim shows as **contested** in
  `forge dash` (val ∈ [0.4, 0.6] with ≥ 1 contradiction), prompting a human `decision`
  claim — the stewardship boundary, not an algorithmic override.

## 5. Failure modes considered

| risk | mitigation |
|---|---|
| Ledger bloat in git history | claims are small canonical JSON; evidence logs compact; attic prunable via `git rm` without breaking ids (content-addressed, no positional refs) |
| Two authors, same lesson, different wording | MinHash consolidation ([01](./01-pcm-protocol.md) §5) clusters them; union evidence |
| Malicious/poisoned claim from a fork | evidence requires verifiable refs; `val` starts at 0.5 and only local oracles raise it; `forge scan`-style provenance gating for imported ledgers |
| Monorepo scale | id-prefix sharding (256 dirs); optional SQLite read index (ADR-0005) |

## 6. Explicit non-goals (P2)

No sync server, no real-time channel, no cross-repo global team memory — git push/pull
*is* the sync. If a later phase wants real-time, the CRDT property means a dumb
last-writer-wins file relay suffices; nothing in this design would change.
