# ADR 0003: Enforce invariants as guards; keep prose thin

- Status: accepted
- Date: 2026-07-05

## Context
The most-cited pain with AI coding tools is a rules file being acknowledged then ignored —
worse after context compaction. Prose cannot enforce.

## Decision
Enforceable invariants (secret-file writes, diff size, cost, thrash) become deterministic
hooks ("guards") the model cannot drift from. Prose rules stay thin and single-sourced.

## Consequences
- (+) The #1 pain is materially reduced for anything expressible as a hook.
- (−) Semantic rules ("prefer functional") remain prose and can still be missed — stated honestly.
