# Research

The full research programme behind forgekit: an account of what a language model with frozen
weights does not guarantee on its own, an architecture that supplies it, two runnable
prototypes, and — most importantly — a pre-registered empirical evaluation that **refuted the
prototypes' headline claims**.

Read in this order. The later work corrects the earlier work, and the corrections are the
most useful part. Every load-bearing headline below also has a row, with its status and the
evidence behind it, in the machine-readable claim registry
[`docs/status/claims.json`](../docs/status/claims.json), rendered as a table in
[`docs/status/README.md`](../docs/status/README.md).

## Start here: what is actually true

| | Claimed (self-built demos) | Measured (real data) |
|---|---|---|
| Impact oracle recall | 1.00 | **0.022** — `grep` with no graph beats it ~10× on F1 |
| Router/gate: gate F1 (should-ask) | 1.00 | **0.37** on 80 real GitHub issues/PRs |
| Router/gate: cost saving vs always-premium | +62.1% | **−20.2%** — routing costs *more* than always-premium |

Success in the router rows means **judge-accepted**: a model judge accepted the output. No
held-out task admitted execution-based verification, so `tests_passed`, `human_accepted` and
`deployed_without_revert` were never measured. Per judge-accepted output the router cost $1.06
against always-premium's $1.76, but only 6 and 3 of the 64 non-halted tasks were judge-accepted,
so that ratio is not stable; 58 of the 64 tasks failed at every tier, which is why escalation made
routing cost more overall ($6.3582 against $5.2893, 20.21% more). The judge was also the mid-tier
executor, and the "second labelling pass" is the same model with a reworded prompt (n = 30: halt
κ 0.5161, tier κ 0.8919), so κ measures self-consistency, not agreement with a human.
(Corrected 2026-09-26: the first sentence read "Per output a judge accepted, …" and named neither
what the judge's acceptance is not nor who the judge was; the row was labelled "Router/gate F1".)

After diagnosing and repairing two defects, with numeric parameters frozen before the held-out
repositories were touched: at the pre-registered canonical threshold 0.02, recall **0.653** and
F1 **0.416**, a point estimate above `grep`'s 0.371 for the first time (paired ΔF1 about +0.044).
That the repaired oracle *beats* grep is **not established**. Per-repository counts exist only at
threshold 0.10, where the pooled ΔF1 is +0.0565 and all three held-out repositories favour the
oracle, but three out of three is a one-sided sign-test p of 0.125; pytest supplies 71.3% of the
held-out pairs; the file-level intervals overlap; and the choice of which relations to add was made
after diagnosing all nine repositories — an architecture-selection channel into the nominal test
set, which limits the unseen-repository claim without erasing the measured gain. Numbers at 0.02
and 0.10 are never mixed in one comparison. (Corrected 2026-09-21; earlier versions called it "a
real but narrow win". Thresholds separated 2026-09-26.)

The general lesson, demonstrated on our own work: **a self-built demonstration can overstate
field performance by more than an order of magnitude, and careful caveating does not convert
a demonstration into evidence.**

## What the impact study measured — and what it did not

*(Added 2026-09-26, after a second external review recomputed the archived results.)*

The archived counts reproduce: 801 labelled files, 759 evaluated after the pre-registered cap of
200 files per repository, nine repositories, 20,144 mirrored labelled pairs. The original oracle's
pooled precision / recall / F1 is **0.3982 / 0.0220 / 0.0416**; grep's is **0.3535 / 0.5732 /
0.4373**. A repository-cluster bootstrap (20,000 draws, seed 1234) gives oracle F1 **[0.0010,
0.0927]**, grep **[0.3807, 0.5394]**, and grep minus oracle **[0.3422, 0.5174]** — figures
recomputed by the 2026-09-26 external review and reproduced by
[`recompute_corrections.py`](recompute_corrections.py) §5, which also prints the repository-level
view: macro F1 0.0220 for the oracle against 0.4947 for grep, with grep ahead in 9 of 9
repositories. The negative result is well supported within this archived corpus.

What it is a result *about* needs stating as carefully as the numbers:

- **Co-change is a proxy.** Two files that changed in the same commit are *historically related
  edits*, not proof of semantic necessity or of test breakage; conversely a dependency graph is not
  a full co-change graph. The study measured one task: (a) predicting co-edited files. The other
  task an impact tool is used for — (b) selecting the tests that detect a behaviour regression —
  was not measured, and results for the two should always be reported separately.
- **Pairs are not independent.** Every ground-truth pair is mirrored (counted from both ends) and
  files share repositories, so file- or pair-level resampling overstates precision. Uncertainty is
  reported at the repository level, and macro results sit beside pooled ones.
- **The Node graph is not the evaluated oracle.** The shipped `forge impact` / `src/atlas.js` is a
  regex-derived, multi-language code graph that ports the two repairs; it is not the Python AST
  oracle the study evaluated, and the study's numbers are not its numbers. Its own measurement is a
  six-case, self-labelled fixture in [`reports/benchmarks.md`](../reports/benchmarks.md).

### Next study (pre-declared shape)

The nine-repository archive is a reproducibility starter, not a fresh holdout. The next impact
study freezes the parser and relation design **before** acquiring a new repository set or time
split; includes runtime coupling, configuration changes, dynamic imports and languages other than
Python; predeclares relation budgets so that widening predictions cannot win merely by returning
most files; and reports review-cost metrics — files reviewed per true affected file, and the
missed-regression rate — beside F1, for co-edited-file prediction and regression-test selection
separately.

## The four layers

### 1. [`cognitive-substrate/`](cognitive-substrate/) — the theory
The originating argument: an LLM is a map `y = f_θ(x)` with frozen parameters, no state between
calls and a bounded context, and a coding agent built on it lacks five faculties (memory,
learning, imagination, self-correction, impact-awareness) unless something outside supplies them.
Stated precisely, what is missing is a set of guarantees — no durable state across independent
invocations, a bounded context, no automatic parameter update, and unreliable self-verification
without external evidence. Prompting does change behaviour inside a context (in-context adaptation;
Brown et al., 2020, [arXiv:2005.14165](https://arxiv.org/abs/2005.14165)); the substrate is a tested
way of supplying persistence and verification, not the only logically possible architecture.
(Corrected 2026-09-26: this paragraph said the three properties "structurally deny it five
faculties" and that "the remedy is an external stateful architecture, not better prompting".)

- `cognitive_substrate_whitepaper.pdf` — the *Theory → Evidence → Build-Map* edition (48pp).
  **Historical, pre-correction edition** (git blob `44ce7bb`); the `.html` edition is the corrected
  source and carries the 2026-09-21 and 2026-09-26 corrections.
- `EXECUTIVE_SUMMARY.md` — one-page entry point, **carries a status banner: its prototype numbers are refuted**
- `literature/` — the gap map and 32 graded references behind each faculty claim
- `evidence/` — twelve load-bearing industry statistics independently re-grounded and graded
  `confirmed` / `vendor-reported` / `unverifiable`, plus an ecosystem map of what the 2026
  Claude-Code stack already solves. Three widely-repeated statistics were caught as
  misattributed and dropped. Since 2026-09-26 the evidence map also grades claim support, study
  design, independent replication and transfer scope separately; the original grades mainly
  confirm that a source exists and says what is quoted.
- `quranic-lens/` — the fourteen-mapping ethical-epistemic reading used as a *design lens*:
  it names which safeguards are obligatory rather than optional. It is framing, never
  technical authority; no verse is offered as proof of an engineering claim. The Arabic source
  text, the translation, tafsir and the author's design analogy are labelled separately, and the
  lens's operational content is the discipline *do not assert without evidence* — the claim
  registry, verifier events and visible uncertainty — not any algorithm's correctness, catch rate
  or uniqueness.
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
neither layer suffices, and the checks multiply only if they fire independently. Since the
2026-09-26 corrections the reachable residual is a minimum over the *jointly* feasible `(p, q)`
pairs — separately maximal `p` and `q` need not be attainable under one policy, so
`(1 − p_max)(1 − q_max)` is only a lower bound — and a caught miss is no longer read as a
completed task.

**Priority note:** prior-art review found this composition law is standard protection-layer
algebra, and two concurrent preprints derive a strictly more general Bayesian form weeks
earlier. Priority is conceded in the refutation paper's related work and, since the
2026-09-21 corrections, in the synthesis and the extended preprint as well (before that they
still said "this paper proves"). What survives is that both preprints are simulation-only.

- `substrate_synthesis.pdf` — **historical, pre-correction edition** (git blob `2e17362`); the
  corrected source is `substrate_synthesis.html`.

### 3. [`empirical-refutation/`](empirical-refutation/) — the measurement
The pre-registered evaluation that overturned the claims above, the diagnosis of *why*, and
the repair. Includes a replication package with the frozen pre-registration, mined ground
truth, held-out task set, every result with bootstrap confidence intervals, both prototype
versions, and **our own adversarial review listing four numbers we had stated incorrectly
before correction**.

Also corrects a theoretical claim: perfect recall was inferred from a completeness theorem,
but such a theorem guarantees completeness only *relative to the relation* the closure runs
over — it says nothing about whether that relation contains the edges that matter.

- `replication_package.tar.gz` — the archive **exactly as published** (git blob `50bd453`); its
  copies of `paper/main.tex` and `paper.pdf` predate the corrections. Corrected summary: the
  README's Corrections sections; every corrected number is recomputed from it by
  `recompute_corrections.py`.
- `paper.pdf` and `extended_preprint.pdf` — **historical, pre-correction editions** (git blobs
  `f94a727`, `74f74ae`); the corrected sources are `paper/main.tex` and `extended_preprint.html`.

### 4. [`python-prototypes/`](python-prototypes/) — the code
`impact_oracle/` and `router_gate/`, runnable with their own test suites. The in-tree
`impact_oracle/` **is the repaired (v2) oracle**: both repairs are in its source, with their
frozen parameters as module defaults, and its suite is 49 tests (36 demo-package tests plus 13
regression tests for the two repairs). `ImpactOracle(wm, sibling_enabled=False,
forward_enabled=False)` reproduces the refuted reverse-only traversal, and the untouched as-shipped
v1 package is archived in the replication tarball. (Corrected 2026-09-26: this paragraph said the
repaired oracle "ships inside the refutation's replication package rather than replacing the
version here, so swapping it in stays a deliberate decision"; the swap had already been made.)

## Prior art, and what is (and is not) claimed

*(Added 2026-09-26.)* External memory, feedback-driven improvement and structured agent control
all have clear prior art. **CoALA** (Sumers et al., 2023,
[arXiv:2309.02427](https://arxiv.org/abs/2309.02427)) organises language agents into modular
memory, action and decision procedures; **Reflexion** (Shinn et al., 2023,
[arXiv:2303.11366](https://arxiv.org/abs/2303.11366)) improves agents through linguistic feedback
and an episodic memory buffer, with no weight updates; GPT-3's few-shot evaluation
([arXiv:2005.14165](https://arxiv.org/abs/2005.14165)) already measured adaptation through text
alone. That prior art does not make forgekit unoriginal as a product, but it limits what the broad
architecture can claim. The defensible framing is:

> **a portable implementation of evidence-weighted coding-agent memory and checks, with
> empirical evaluation of trust failure modes.**

Novelty is claimed only for a specific protocol, invariant, evaluation result or integration that
survives an explicit comparison with that prior art. The "five faculties" are a useful
decomposition, not a proof that these five are necessary or that an external stateful architecture
is the only way to supply them; and the "convergence" of the theory, forgekit and its sibling
projects is consistency within one author's work, not independent confirmation — the same care the
programme already applied when it conceded priority for the protection-layer equation.

## How this programme tries to stay honest

- Protocols and parameter freezes are declared *before* the data is seen, and amendments are
  append-only.
- Every load-bearing statistic is graded by what can actually be traced to a primary source.
- Negative results are reported as findings, not tuned away.
- Reviews of our own work ship alongside it, including the parts that found us wrong.

Where this falls short is stated too: the pre-registration and parameter freezes were
self-administered with no external timestamping authority, so a reader can verify internal
consistency and the amendment trail but must take the ordering on trust.

### Four kinds of reproducibility, kept apart

| Kind | Status |
|---|---|
| **Source availability** | The papers' corrected sources (HTML, LaTeX), both Python prototypes, the replication archive and the recomputation script are all in this directory. |
| **Calculation reproducibility** | Available. [`recompute_corrections.py`](recompute_corrections.py) (standard library only) recomputes every corrected statistic from the archived results, and asserts the Theorem D sanity checks with no data at all (`--theorem-checks`); CI runs both, and both prototypes' test suites, since `aedddf5`. The universal router's shipped prior also refits exactly from pinned public data with `bench/universal-router/reproduce.sh` (2026-09-26, the project's own run). |
| **Pipeline reproducibility** | **Not available.** The historical mining pipeline (cloning, commit filtering, labelling, model calls) is not shipped as an entry point here, so new histories cannot be mined with one command; and the universal router's run-4 held-out benchmark ran in an external harness (harness-bench) that is not shipped either — see [`docs/UNIVERSAL_ROUTING.md`](../docs/UNIVERSAL_ROUTING.md). |
| **Independent external replication** | None of the research results has been replicated by an independent team. The 2026-09-21 and 2026-09-26 reviews recomputed archived numbers; they did not re-mine repositories or re-run model calls. |

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

## Corrections (2026-09-26)

A second external deep review (2026-09-26, pinned at commit
`d2abfa69fb77531199ffc67c5c076b524af69040`) recomputed the archived results again and read the
papers' framing against the code. The counts reproduced exactly again. Changes, each marked in
place in its paper with `[corrected 2026-09-26]` and listed there with the original wording:

- **Formal synthesis and extended preprint** — the range statement of Theorem D no longer combines
  separately maximal `p` and `q` (counterexample: policies `(0.5, 0.9)` and `(0.9, 0.1)` leave 0.05
  and 0.09, while the separate maxima suggest 0.01); the equality condition for
  `1 − (1 − ε)ⁿ` is every `rᵢ = ε`, not independence alone; a new §5.4 separates silent-miss
  probability from completed-task rate and lists what to measure; the frozen-map premise is stated
  as the guarantees it removes; prior art (CoALA, Reflexion) is named and the byline no longer
  calls the three bodies of work "independently-developed". The counterexample, the equality
  condition and the 400× correction are asserted by `python3 research/recompute_corrections.py
  --theorem-checks`.
- **Whitepaper** — the "cannot learn / imagine / self-correct" framing marked as broader than the
  missing guarantees; prior art added to §11; the Qur'anic lens's text, translation, tafsir and
  design analogy labelled separately, with its operational scope stated; METR's 19% slowdown
  scoped to its 16 developers, 246 tasks and early-2025 tools, with METR's
  [February 2026 update](https://metr.org/blog/2026-02-24-uplift-update/).
- **This README and the prototype READMEs** — the repaired oracle's location, the 0.02 / 0.10
  thresholds, judge-accepted versus executed success, the unit of the impact study, and the
  reproducibility table above.

**Stale PDFs — historical, pre-correction editions.** `formal-synthesis/substrate_synthesis.pdf`,
`empirical-refutation/extended_preprint.pdf`, `empirical-refutation/paper.pdf`,
`cognitive-substrate/cognitive_substrate_whitepaper.pdf` and its byte-identical copy in
`docs/cognitive-substrate/` predate both sets of corrections. Read the HTML and LaTeX sources,
which carry them. A re-render was attempted on 2026-09-26 and **not** committed: the HTML sources
reference their figures through `{{artifact:…}}` placeholders that a browser cannot resolve, all
three HTML papers carry Qur'anic Arabic whose typesetting could not be checked by eye in that
environment, and a PDF whose figures or sacred text cannot be verified is not published as the new
edition. The paper PDF needs a TeX toolchain that was not available. Each edition's git blob, the
pinned commit where it stays retrievable, and a faithful render recipe (including the
figure-placeholder map) are in [`HISTORICAL_EDITIONS.md`](HISTORICAL_EDITIONS.md). The copies of
`paper/main.tex` and `paper.pdf` inside `replication_package.tar.gz` are left as published.
