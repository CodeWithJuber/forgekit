# ADR 0006: Proof-Carrying Memory is the one store

- Status: accepted
- Date: 2026-07-07

## Context
The whitepaper's sharpest novelty is validity-anchored memory: stored knowledge scored by
whether external oracles later confirmed it (Eq. 3's `val` term), never by the model's
say-so. v0.4 approximates this in two parallel stores with different rules — cortex
lessons (α/β evidence, decay) and recall facts (plain files, no validity) — and the
planned subsystems (reuse cache, context summaries, design fingerprints, diagnoses,
team sharing) would each need their own persistence, trust, and merge story. Divergent
stores mean divergent trust semantics and no coherent team-sync path.

## Decision
All substrate persistence converges on one protocol: the **Proof-Carrying Memory (PCM)
claim ledger** (docs/plans/substrate-v2/01-pcm-protocol.md). Every stored unit is a
content-addressed claim carrying provenance and a grow-only evidence set; confidence is
a decayed Beta posterior over independent-oracle outcomes; retrieval implements the
paper's Eq. 3; team sharing is the ledger's CRDT set-union merge over git
(02-team-memory.md). Cortex lessons and recall facts become claim kinds behind their
existing CLIs; new subsystems (artifacts, edges, fingerprints, diagnoses, summaries,
decisions) mint claims from day one. The parametric learning channel (LoRA distillation,
paper §7.2) remains explicitly out of scope.

## Consequences
- (+) One trust model everywhere: anything the substrate believes can answer "why?"
  with machine-readable evidence, and anything contradicted by outcomes demotes itself —
  including cached code and context summaries, not just lessons.
- (+) Team memory falls out of the storage choice (semilattice merge ⇒ conflict-free by
  construction) instead of being a bolted-on sync feature.
- (+) The write-back band (Eq. 2) has one place to write, so outcome-validated learning
  covers every subsystem at once.
- (−) A migration: lessons/recall move onto adapters; their tests must pass unchanged
  (the P1 acceptance gate) and the old on-disk stores need a one-shot import.
- (−) The ledger becomes load-bearing infrastructure — its canonicalization and merge
  invariants require property-level tests, a higher bar than the stores it replaces.
- (−) Repo history carries the ledger; bounded by canonical-JSON compactness, sharding,
  and the attic-prune policy.
