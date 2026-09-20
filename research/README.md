# Research

The full research programme behind forgekit: a theory of what a frozen language model
structurally lacks, an architecture that supplies it, two runnable prototypes, and — most
importantly — a pre-registered empirical evaluation that **refuted the prototypes' headline
claims**.

Read in this order. The later work corrects the earlier work, and the corrections are the
most useful part.

## Start here: what is actually true

| | Claimed (self-built demos) | Measured (real data) |
|---|---|---|
| Impact oracle recall | 1.00 | **0.022** — `grep` with no graph beats it ~10× on F1 |
| Router/gate F1 | 1.00 | **0.37** on 80 real GitHub issues/PRs |
| Cost saving | +62.1% | **−20.2%** — routing costs *more* than always-premium |

After diagnosing and repairing two defects, with parameters frozen before the held-out
repositories were touched: recall **0.653**, F1 **0.416**, beating `grep` (0.371) for the
first time — a real but narrow win.

The general lesson, demonstrated on our own work: **a self-built demonstration can overstate
field performance by more than an order of magnitude, and careful caveating does not convert
a demonstration into evidence.**

## The four layers

### 1. [`cognitive-substrate/`](cognitive-substrate/) — the theory
The originating argument: an LLM is a frozen map `y = f_θ(x)` with three properties —
statelessness, frozen parameters, bounded context — which structurally deny it five faculties
(memory, learning, imagination, self-correction, impact-awareness). The remedy is an external
stateful architecture, not better prompting.

- `cognitive_substrate_whitepaper.pdf` — the *Theory → Evidence → Build-Map* edition (48pp)
- `EXECUTIVE_SUMMARY.md` — one-page entry point, **carries a status banner: its prototype numbers are refuted**
- `literature/` — the gap map and 32 graded references behind each faculty claim
- `evidence/` — twelve load-bearing industry statistics independently re-grounded and graded
  `confirmed` / `vendor-reported` / `unverifiable`, plus an ecosystem map of what the 2026
  Claude-Code stack already solves. Three widely-repeated statistics were caught as
  misattributed and dropped.
- `quranic-lens/` — the fourteen-mapping ethical-epistemic reading used as a *design lens*:
  it names which safeguards are obligatory rather than optional. It is framing, never
  technical authority; no verse is offered as proof of an engineering claim.
- `sources/` — the primary documents the evidence layer was graded against
- `figures/` — the architecture schematics and prototype evaluations

### 2. [`formal-synthesis/`](formal-synthesis/) — the mathematics
Unifies the substrate theory, the end-to-end reliability framework (F1/F2, Δ*, I1–I4, A1–A7,
T1–T6), and the forgekit implementation, proving they are one object in three vocabularies.
Central result is a two-layer duality: reliability = a probabilistic instruction layer × a
deterministic interception layer, neither alone sufficient.

**Priority note:** prior-art review found this composition law is standard protection-layer
algebra, and two concurrent preprints derive a strictly more general Bayesian form weeks
earlier. Priority is conceded in the paper. What survives is that both are simulation-only.

### 3. [`empirical-refutation/`](empirical-refutation/) — the measurement
The pre-registered evaluation that overturned the claims above, the diagnosis of *why*, and
the repair. Includes a replication package with the frozen pre-registration, mined ground
truth, held-out task set, every result with bootstrap confidence intervals, both prototype
versions, and **our own adversarial review listing four numbers we had stated incorrectly
before correction**.

Also corrects a theoretical claim: perfect recall was inferred from a completeness theorem,
but such a theorem guarantees completeness only *relative to the relation* the closure runs
over — it says nothing about whether that relation contains the edges that matter.

### 4. [`python-prototypes/`](python-prototypes/) — the code
`impact_oracle/` and `router_gate/`, runnable with their own test suites. The **repaired**
oracle ships inside the refutation's replication package rather than replacing the version
here, so swapping it in stays a deliberate decision.

## How this programme tries to stay honest

- Protocols and parameter freezes are declared *before* the data is seen, and amendments are
  append-only.
- Every load-bearing statistic is graded by what can actually be traced to a primary source.
- Negative results are reported as findings, not tuned away.
- Reviews of our own work ship alongside it, including the parts that found us wrong.

Where this falls short is stated too: the pre-registration and parameter freezes were
self-administered with no external timestamping authority, so a reader can verify internal
consistency and the amendment trail but must take the ordering on trust.
