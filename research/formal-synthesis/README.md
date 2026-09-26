# Formal Synthesis — A Theory of the Cognitive Substrate for Coding Agents

> **Corrected 2026-09-21.** An external deep review found that Theorem D was circular as
> stated, that its composition law (Eq. 5) assumed an independence the design contradicts,
> that several definitions and proofs were wrong, and that this README still reported two
> prototype results the refutation had already overturned. `substrate_synthesis.html` is
> corrected in place and ends with a dated **Corrections** section that quotes each original
> statement. **`substrate_synthesis.pdf` predates these corrections** (it was built with
> WeasyPrint, which was not available to rebuild it); read the HTML. The numbers are
> recomputed by [`../recompute_corrections.py`](../recompute_corrections.py).
>
> **Corrected again 2026-09-26.** A second review found that the corrected range statement still
> combined two maxima that need not be attainable together, `(1 − p_max)(1 − q_max)`; that the equality condition
> for `1 − (1 − ε)ⁿ` was misstated; that a caught miss was being read as a completed task; that the
> frozen-map premise was broader than the guarantees it removes; and that prior art and the shared
> authorship of the "three bodies of work" needed stating. The HTML's **Corrections (2026-09-26)**
> section lists each with its original wording, and
> `python3 ../recompute_corrections.py --theorem-checks` asserts the numeric counterexample, the
> equality condition and the 400× correction with no data.

This directory contains a formal, mathematical unification of three separately
developed bodies of work that all describe the **same architecture** for making a
frozen language model reliable at coding:

1. **The Cognitive Substrate** — five faculties a frozen model structurally lacks
   (memory, learning, imagination, self-correction, impact-awareness) and six
   operating mechanisms M1–M6, with two runnable prototypes.
2. **The End-to-End Agent Reliability Framework** (`FRAMEWORK.md`) — failure modes
   F1 (partial work) and F2 (session amnesia), the change-closure fixpoint Δ\*,
   invariants I1–I4, algorithms A1–A7, and correctness theorems T1–T6.
3. **forgekit / claude-e2e-kit** — the deployed implementation: committed-file
   memory, deterministic lifecycle hooks, and auto-invoked skills.

The synthesis argues these are **one object in three vocabularies**. They are not
independent — claude-e2e-kit is forgekit's precursor, and forgekit was built as a binding of
the theory — so their agreement shows consistency, not independent confirmation. (The
synthesis's §14 "four independent arrivals" — the theory, forgekit, hikmah-stack and
wisdom-lens — are likewise one author's work.)

## The central result

> **Silent-miss residual = (1 − p) × P(no deterministic check fires | miss).**
> Where instructions cannot push `p` near 1 and decidable checks cannot catch the misses
> that matter, both layers are needed to reach a small residual.

Instructions (`CLAUDE.md`, rules, skills) _raise_ the probability `p < 1` that the
model behaves correctly. A deterministic layer (hooks that execute regardless of the
model's choice) multiplies the residual `1 − p` by the probability that no check fires on
a miss. The paper states this as **Theorem D**, restated on 2026-09-21 as a bound: the
residual is at most `ε` on an explicit region of `(p, q)`, where `q` is the chance that at
least one check fires on a miss, and over `n` tasks `P(≥1 miss) ≤ n·ε` whatever the
dependence between tasks.

What the corrections changed, briefly:

- **The two maxima need not be jointly attainable (2026-09-26).** The attainable residual is
  `r* = min over (p, q) ∈ F of (1 − p)(1 − q)`, with `F = {(p(π), q(π)) : admissible policies π}`.
  Instructions change which misses remain, and `q` is a catch rate on that changed population, so
  `(1 − p_max)(1 − q_max)` is a *lower bound* on `r*` unless compatibility is established. Policy A
  with `(p, q) = (0.5, 0.9)` leaves 0.05 and policy B with `(0.9, 0.1)` leaves 0.09; the separate
  maxima suggest 0.01, which neither attains.
- **Equality needs equal residuals (2026-09-26).** With per-task residuals `rᵢ ≤ ε` and independent
  tasks, `P(≥1 miss) = 1 − ∏(1 − rᵢ) ≤ 1 − (1 − ε)ⁿ`, with equality only when every `rᵢ = ε`;
  independence alone does not give equality. The union bound `nε` needs neither.
- **Catching is not completing (2026-09-26).** A lower silent-miss probability is not automatically a
  higher completed-correct-task rate: a caught mistake can end in an abort, repeated blocking or a
  failed repair. Measure the true catch rate, false-block rate, repaired success conditional on a
  catch, abandonment, latency and recovery cost.

- **It is a bound, not an impossibility proof.** The old criterion, `P(≥1 miss) → 1`,
  also condemns the composed system (0.993 over 1,000 tasks at a residual of 0.005), and
  raising `p` bends the curve too (30-task `P(≥1 miss)` is 0.958 at `p = 0.9` and 0.260 at
  `p = 0.99`).
- **Checks do not multiply unless they are independent.** The old Eq. 5,
  `(1 − p)·∏(1 − cⱼ)`, assumed the checks fire independently given a miss. The same
  classifier at the Stop hook, pre-commit and CI fires together, so the residual is
  `(1 − p)(1 − c_max)`: 0.015, not the product's 3.75 × 10⁻⁵, in the paper's own example.
  Three lifecycle copies of one classifier widen the opportunities to run it; they are not three
  independent semantic detectors. The 400× figure is recomputed (§2) and asserted (§3b) by the
  recomputation script.
- **`cⱼ` belongs to the agent as well as the gate.** The gate detects its proxy exactly,
  not the miss; an agent that touches `STATE.md` passes it. At a STATE-touch rate of 0.9
  the residual is 0.27, not 0.015.
- **Rice's theorem is a worst case over all programs**, not a probability bound, so the
  claim that `cⱼ < 1` on semantic misses is an empirical premise.
- **Priority is conceded.** The law is standard layer-of-protection algebra, and two
  concurrent preprints derived a more general Bayesian form first (see the refutation
  paper's related work). The paper no longer says it "proves" the result.
- **The same care for the rest of the framing (2026-09-26).** A frozen model lacks specific
  guarantees — durable state across independent invocations, context beyond the window, automatic
  parameter update, reliable self-verification without external evidence — not the ability to adapt
  inside a context (Brown et al., 2020, [arXiv:2005.14165](https://arxiv.org/abs/2005.14165)).
  CoALA ([arXiv:2309.02427](https://arxiv.org/abs/2309.02427)) and Reflexion
  ([arXiv:2303.11366](https://arxiv.org/abs/2303.11366)) are prior art for the broad architecture;
  the defensible claim is *a portable implementation of evidence-weighted coding-agent memory and
  checks, with empirical evaluation of trust failure modes*, and the five faculties are a
  decomposition, not a proof of necessity.

It is the formal content of the practitioner's rule: _never trust the output of a
probability engine; earn trust with an external check._

## Three anchor identities (two of them weaker than first claimed)

| Substrate                  | Framework                                                        | Relationship                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impact-Oracle blast-radius | change-closure `Δ* = lfp(X ↦ Δ₀ ∪ N(X))`                         | **approximation**, not identity — the oracle is thresholded, depth-10 reachability over the AST relation; its real-repository recall was 0.022            |
| M2 assumption gate         | amnesia equation `assumption ≈ argmax P(convention \| training)` | **identical** — the gate supplies missing context or halts, never guesses (argmax is greedy decoding's special case of sampling)                           |
| substrate's two layers     | design law "Π₃ probabilistic, Π₂ deterministic"                  | **Theorem D**, as a bound over `(p, q)` with its dependence assumptions stated                                                                            |

Earlier versions wrote `Δ*` as the least fixpoint of `X ↦ X ∪ N(X)`, which is the empty
set, and said reverse reachability run to fixpoint implied perfect recall.

## Contents

| File                                | What it is                                                                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `substrate_synthesis.pdf`           | The formal synthesis paper (42 pp): definitions, Theorem D + proof, the unified A1–A7 TASK loop, invariants I1–I4, theorems T1–T6 with proofs, the 16-row crosswalk, the full 14-mapping Qur'anic epistemology, both prototypes. **Historical, pre-correction edition** (git blob `2e17362`; predates the 2026-09-21 and 2026-09-26 corrections — see [`../HISTORICAL_EDITIONS.md`](../HISTORICAL_EDITIONS.md)). |
| `substrate_synthesis.html`          | Same paper, self-contained HTML, **with the 2026-09-21 and 2026-09-26 corrections** and a Corrections section for each. The corrected source.                                                                                                        |
| `crosswalk.json` / `crosswalk.md`   | The three-way term-by-term correspondence (substrate ↔ framework ↔ forgekit), with the P1/P2/P3 → Π₁/Π₂/Π₃ notation reconciliation.                                                                                                                  |
| `graded_reference_set.json` / `.md` | The 15 new sources independently verified and graded (9 confirmed, 6 traceable, 0 unverifiable), including the disambiguation of the two future-dated arXiv IDs. These are bibliographic grades (the source exists and is correctly attributed); claim support, study design, replication and transfer scope are separate and not assessed. |
| `merged_references.json`            | Full 47-entry bibliography (32 original + 15 new, deduped).                                                                                                                                                                                          |
| `figures/schematic_duality.png`     | The two-layer duality architecture.                                                                                                                                                                                                                  |
| `figures/schematic_taskloop.png`    | The unified 7-stage TASK loop (each stage bound to faculty · algorithm · Qur'anic anchor).                                                                                                                                                           |

The **two runnable prototypes** referenced throughout the paper already live in this
repo and are not duplicated here:

- `../python-prototypes/impact_oracle/` — Prototype I, the impact oracle (approximates
  A1 / Δ\*). Runnable; the in-tree package is the repaired v2 (49 tests: 36 demo-package + 13
  repair; corrected 2026-09-26 from "36 tests"). Recall 1.00 on five mutations of its own demo package;
  **refuted on real repositories: recall 0.022** on 759 files in nine repositories, where
  grep scored F1 0.437 against the oracle's 0.042 (see
  [`../empirical-refutation/`](../empirical-refutation/)).
- `../python-prototypes/router_gate/` — Prototype II, complexity-router +
  assumption-gate (A7 + A6 / M1 + M2). Runnable, 23 tests in-tree (the version archived as
  evaluated has 19; corrected 2026-09-26). 62.1% cost saved on the 30
  tasks its thresholds were tuned on; **refuted on 80 held-out tasks: total spend was
  20.2% higher** than always-premium. Per judge-accepted output (a model judge that is also the
  mid-tier executor; no output was test-verified), it cost $1.06 against always-premium's $1.76,
  but only 6 and 3 of 64 outputs were accepted.

## Honesty commitments (carried from the source work)

- **The prototypes are demonstrations, not benchmarks** — and when they were
  benchmarked, both headline results failed. The router/gate's perfect accuracy was on a
  30-task hand-labelled set whose thresholds were tuned against it; on 80 held-out tasks
  gate F1 was 0.37. Its cost figures were exact arithmetic on real measured token counts,
  but on held-out tasks almost no output at any tier was judged correct, so escalation paid
  for every tier and routing cost more than always-premium.
- **The impact oracle does not win on F1**, and its "perfect recall" was a property of its
  demo package, not a guarantee: a closure is complete only relative to the relation it
  walks, and on real repositories that relation missed 97.8% of the co-changed file pairs.
- **Every future-dated / recent citation was verified by direct fetch, not inferred.**
  Both 2026 arXiv IDs resolve to real preprints; one (`2601.05111`) is a _different_
  paper from the founding Agent-as-a-Judge work (`2410.10934`), and both are recorded.
- **The Qur'anic lens is framing, never technical authority.** It supplies the
  vocabulary of epistemic obligation — _lā taqfu_, _tabayyun_, _al-amāna_ — that names
  _why_ each safeguard is mandatory; the engineering stands on its own merits.

## Relationship to forgekit

`forgekit` is one binding of this theory (and `claude-e2e-kit` is its Claude-specific
reference realization). The paper's §11 gives the exact object-by-object mapping:
`Π₁` = the committed `docs/*.md` store, `Π₂` = the `cortex.sh` hook chain
(`src/cortex_hook_main.js` dispatching `src/gate.js` stopGate, `src/session.js`
rehydrationBlock, and `src/intent.js` intent routing; kit: `session-context` /
`docs-guard` / `intent-router`), `Π₃` = `CLAUDE.md` + `.claude/rules/`. The two prototypes here
are the mechanical cores of the `/impact` skill and the effort-router.
