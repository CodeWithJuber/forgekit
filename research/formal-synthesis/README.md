# Formal Synthesis — A Theory of the Cognitive Substrate for Coding Agents

This directory contains a formal, mathematical unification of three independently
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

The synthesis proves these are **one object in three vocabularies**.

## The central result

> **Reliability = a probabilistic instruction layer × a deterministic interception
> layer. Neither layer alone suffices.**

Instructions (`CLAUDE.md`, rules, skills) _raise_ the probability `p < 1` that the
model behaves correctly, but can never reach `p = 1` — so the residual silent-miss
rate over `n` tasks is `1 − pⁿ → 1`. A deterministic layer (hooks that execute
regardless of the model's choice) multiplies that residual down by a factor
`(1 − cⱼ)` per check — but cannot catch the _semantic_ class (undecidable, by Rice's
theorem), so it needs the soft layer to shrink what reaches it. The paper states this
as **Theorem D** and proves it. It is the formal content of the practitioner's rule:
_never trust the output of a probability engine; earn trust with an external check._

## Three anchor identities (not analogies — the same mathematics)

| Substrate                  | Framework                                                        | Relationship                                                              |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Impact-Oracle blast-radius | change-closure `Δ*` (least fixpoint of `X ↦ X ∪ N(X)`)           | **identical** — reverse reachability, run to fixpoint ⇒ perfect recall    |
| M2 assumption gate         | amnesia equation `assumption ≈ argmax P(convention \| training)` | **identical** — the gate supplies missing context or halts, never guesses |
| substrate's two layers     | design law "Π₃ probabilistic, Π₂ deterministic"                  | **identical** — Theorem D                                                 |

## Contents

| File                                | What it is                                                                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `substrate_synthesis.pdf`           | The formal synthesis paper (42 pp): definitions, Theorem D + proof, the unified A1–A7 TASK loop, invariants I1–I4, theorems T1–T6 with proofs, the 16-row crosswalk, the full 14-mapping Qur'anic epistemology, both prototypes with honest metrics. |
| `substrate_synthesis.html`          | Same paper, self-contained HTML.                                                                                                                                                                                                                     |
| `crosswalk.json` / `crosswalk.md`   | The three-way term-by-term correspondence (substrate ↔ framework ↔ forgekit), with the P1/P2/P3 → Π₁/Π₂/Π₃ notation reconciliation.                                                                                                                  |
| `graded_reference_set.json` / `.md` | The 15 new sources independently verified and graded (9 confirmed, 6 traceable, 0 unverifiable), including the disambiguation of the two future-dated arXiv IDs.                                                                                     |
| `merged_references.json`            | Full 47-entry bibliography (32 original + 15 new, deduped).                                                                                                                                                                                          |
| `figures/schematic_duality.png`     | The two-layer duality architecture.                                                                                                                                                                                                                  |
| `figures/schematic_taskloop.png`    | The unified 7-stage TASK loop (each stage bound to faculty · algorithm · Qur'anic anchor).                                                                                                                                                           |

The **two runnable prototypes** referenced throughout the paper already live in this
repo and are not duplicated here:

- `../python-prototypes/impact_oracle/` — Prototype I, the impact oracle (A1 / Δ\*).
  Runnable, 36 tests. Perfect recall on impacted files.
- `../python-prototypes/router_gate/` — Prototype II, complexity-router +
  assumption-gate (A7 + A6 / M1 + M2). Runnable, 19 tests. 62.1% real cost saved,
  live-measured.

## Honesty commitments (carried from the source work)

- **The prototypes are demonstrations, not benchmarks.** The router/gate's perfect
  accuracy is on a 30-task hand-labelled set whose thresholds were tuned against it —
  it shows the rubric _can separate_ the cases. The cost figures, by contrast, are
  exact arithmetic on **real measured token counts** from live model calls, and the
  correctness sub-experiment actually executed the cheaper models' code against tests.
- **The impact oracle does not win on F1** (0.75 vs grep's 0.79). Its property is
  **perfect recall** — the safety guarantee for "what will my edit break?".
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
