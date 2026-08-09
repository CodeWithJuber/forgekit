# MergeField: change consequence calculus

Status: experimental research prototype.

`forge impact` currently answers a useful but narrower question: which graph dependents are
reachable from a symbol or file? MergeField asks a different question:

> Given the exact kind of change we are making, which consequences and verification
> obligations can propagate before this change is merged?

The distinction matters. A one-line public API or schema edit can be more consequential than
a 50-file formatter sweep. A Markdown change can be runtime-neutral but still invalidate a
published doc surface. A test is usually a verification obligation, not a runtime dependent.

## Model

A change is represented as a semantic vector over seven dimensions:

`runtime, contract, verification, docs, config, delivery, merge`

A formatting edit starts close to zero. A public API edit starts high in contract,
verification, runtime, and docs. Callers can override every dimension, so the built-in
profiles are priors rather than truth.

A typed relationship is not assigned one scalar edge weight. It has a sparse transfer matrix.
For example:

- `imports` mostly transports runtime and contract consequence;
- `verified_by` transforms runtime/contract/config consequence into a test obligation;
- `documented_by` transforms contract/runtime/config consequence into documentation drift;
- `generates` transforms generator behavior/config consequence into generated-doc and delivery
  consequence;
- `workflow_uses` transports consequence into verification and delivery risk.

This is why MergeField is not simply another code graph walk. A graph can store the
relationships, but the calculation is a typed consequence field over those relationships.

## Mathematics

For changed atom `i`, let its semantic signal be a vector:

`S_i in [0,1]^7`

For a typed relation `e: u -> v`, let `M_e` be its 7 x 7 transfer matrix, `q_e` its evidence
confidence, and `d` a decay term.

For one changed atom, propagation keeps only the strongest supported path per artifact and
dimension:

`P_i(v) = max_path(S_i * M_path * product(q_e * d))`

This max-path rule deliberately prevents a cycle from counting the same original change over
and over.

Different changed atoms are independent causes. Their contributions combine with noisy-OR:

`P(v,k) = 1 - product_i(1 - P_i(v,k))`

So two weak independent edits can create a meaningful combined consequence without pretending
two correlated paths from the same edit are independent evidence.

The merge summary separates:

- peak consequence;
- breadth of secondary impact;
- uncertainty from severe changes with weak or missing relationship coverage;
- verification gap for consequential artifacts that have no known test relation.

The engine returns the full dimension vector for every impacted artifact rather than hiding
all semantics behind one number.

## Real ForgeKit probes

The first benchmark cases are tied to real ForgeKit history.

### `98ce7ece` formatting-only test edit

The commit only reformatted one `readFileSync` call in `test/cortex_mcp.test.js`.
MergeField classifies it as low risk and does not invent documentation or runtime impact.

### `d0f11aa` docs renderer/check change

The commit widened Markdown handling to MDX and changed Mermaid normalization. The real commit
also updated generated Mintlify surfaces and `test/docs_render.test.js`.

With `src/docs_render.js` and `src/docs_check.js` as changed roots, typed `generates`,
`documented_by`, and `verified_by` relationships propagate into the MDX surfaces and the
regression test. This is a class of consequence a scalar import-only graph cannot express
cleanly.

### One-line public API probe

A synthetic one-line public API change on the real `src/atlas.js` surface propagates into
`src/substrate.js`, `src/imagine.js`, `test/atlas.test.js`, `docs/GUIDE.md`, and `README.md`
when those real relationships are supplied. Test impact is high on the verification dimension;
doc impact is high on the docs dimension and remains zero on runtime.

## Automatic evidence adapter

`src/merge_impact_adapter.js` turns repository evidence into MergeField inputs instead of asking
a caller to label everything by hand.

For each diff file it extracts added/removed lines and classifies the semantic seed as formatting,
test, docs, CI, dependency, schema, public API, config, generated output, or executable logic.
Security-sensitive and deletion-heavy deltas add independent consequence signals rather than
replacing the primary class. Classification returns both confidence and human-readable reasons.

Formatting detection is deliberately semantic enough to survive normal formatter behavior. The
real ForgeKit `98ce7ece` patch adds a legal trailing comma while reflowing a call, so the adapter
normalizes whitespace and trailing commas adjacent to closing delimiters before deciding that
the token sequence is unchanged.

Atlas supplies topology, not meaning. Its dependency edges point from consumer to dependency, so
the adapter reverses them into consequence direction. The consuming artifact determines how the
relation is interpreted: test consumers become `verified_by`, documentation becomes
`documented_by`, workflows become `workflow_uses`, and ordinary source dependencies preserve
`imports`, `calls`, or `inherits`. Generated registries can add explicit `generates` relations.

This separation is intentional:

- the diff answers **what kind of change happened**;
- Atlas and other evidence answer **where that consequence can travel**;
- transfer matrices answer **how the consequence changes meaning while travelling**;
- MergeField answers **what must be inspected, tested, regenerated, or blocked before merge**.

## What is not solved yet

Automatic diff and Atlas adaptation now exists, but relation coverage is not yet universal.
Repository-specific generators, schemas, runtime reflection, external services, deployment
contracts, database semantics, and hidden operational dependencies may require additional evidence
providers. Missing coverage therefore increases uncertainty instead of being interpreted as safety.

The next experiment is historical calibration across merged ForgeKit changes. We should measure
false-safe rate first, then impacted-file precision/recall, recall@k, test-obligation recall,
documentation-obligation recall, and risk calibration by bucket. Only measured performance should
decide whether MergeField replaces or augments the current `forge impact` path.
