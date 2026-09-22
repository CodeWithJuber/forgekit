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

Per output a judge accepted, the router cost $1.06 against always-premium's $1.76, but
only 6 and 3 of 64 outputs were accepted, so that comparison is not stable; 58 of the 64
tasks failed at every tier, which is why escalation made routing cost more overall.

After diagnosing and repairing two defects, with numeric parameters frozen before the
held-out repositories were touched: recall **0.653**, F1 **0.416**, a point estimate above
`grep`'s 0.371 for the first time. That the repaired oracle *beats* grep is **not
established**: the three held-out repositories all favour it, but three out of three is a
one-sided sign-test p of 0.125, pytest supplies 71% of the held-out pairs, the file-level
intervals overlap, and the choice of which relations to add was made on all nine
repositories. (Corrected 2026-09-21; earlier versions called it "a real but narrow win".)

The general lesson, demonstrated on our own work: **a self-built demonstration can overstate
field performance by more than an order of magnitude, and careful caveating does not convert
a demonstration into evidence.**

## The four layers

### 1. [`cognitive-substrate/`](cognitive-substrate/) — the theory
The originating argument: an LLM is a frozen map `y = f_θ(x)` with three properties —
statelessness, frozen parameters, bounded context — which structurally deny it five faculties
(memory, learning, imagination, self-correction, impact-awareness). The remedy is an external
stateful architecture, not better prompting.

- `cognitive_substrate_whitepaper.pdf` — the *Theory → Evidence → Build-Map* edition (48pp);
  the `.html` edition carries the 2026-09-21 corrections, the PDF predates them
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
T1–T6), and the forgekit implementation, arguing they are one object in three vocabularies
(not independently: forgekit was built as a binding of the other two). Central result is a
two-layer duality: the silent-miss residual is
`(1 − p) × P(no deterministic check fires | miss)`, so where each factor is bounded away from
zero, neither layer alone reaches a small residual. Since the 2026-09-21
corrections this is stated as a bound over an explicit `(p, q)` region, not as a proof that
neither layer suffices, and the checks multiply only if they fire independently.

**Priority note:** prior-art review found this composition law is standard protection-layer
algebra, and two concurrent preprints derive a strictly more general Bayesian form weeks
earlier. Priority is conceded in the refutation paper's related work and, since the
2026-09-21 corrections, in the synthesis and the extended preprint as well (before that they
still said "this paper proves"). What survives is that both preprints are simulation-only.

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

## Corrections (2026-09-21)

An external deep review of this repository (2026-09-21) recomputed the research statistics
from the replication package and checked the mathematics against its own definitions. The
refutation's counts reproduced exactly; several inferences and several theorems did not hold as
written. Each paper is corrected in place and ends with a dated Corrections section that quotes
the original wording:

- **Formal synthesis and extended preprint** — Theorem D restated as a bound; Eq. 5's
  independence assumption removed (identical checks at Stop, pre-commit and CI gave a 400×
  understatement); `cⱼ` shown to depend on agent behaviour; the `lfp` definition, the oracle-vs-Δ*
  identity, T4, T5, T6, A1, A3 and the use of Rice's theorem corrected; the faculty table
  reconciled with the whitepaper; priority conceded; the "independent" convergence shown not to
  be independent (the "four arrivals" are one author's work).
- **Refutation paper** (LaTeX source) — repository-cluster bootstrap intervals, the repaired
  oracle's comparison with grep softened, the labels identified as one model's, cost per accepted
  output added, the 96.8% ceiling qualified, the calibration statement fixed, 801 vs 759 explained.
- **Whitepaper** — status banner, refuted prototype claims marked, M1's worst-case cost, Eq. 1 vs
  M2, and a misquoted statistic ("31.3% *more* PRs merged with no review").

Every corrected number can be re-derived with the standard-library script
[`recompute_corrections.py`](recompute_corrections.py):

```bash
mkdir rp && tar -xzf research/empirical-refutation/replication_package.tar.gz -C rp
python research/recompute_corrections.py rp/repro
```

**Stale PDFs.** These PDFs predate the corrections and could not be rebuilt here (the HTML
editions were rendered with WeasyPrint, the paper with a TeX Live toolchain; neither was
available): `formal-synthesis/substrate_synthesis.pdf`,
`empirical-refutation/extended_preprint.pdf`, `empirical-refutation/paper.pdf`,
`cognitive-substrate/cognitive_substrate_whitepaper.pdf`, and the copy in
`docs/cognitive-substrate/`. The copies of `paper/main.tex` and `paper.pdf` inside
`replication_package.tar.gz` are left as published. Read the HTML and LaTeX sources.
