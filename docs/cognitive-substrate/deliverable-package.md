# A Cognitive Substrate for Coding Agents — Deliverable Package

### Theory → Evidence → Build-Map edition (v2)

**One-line thesis:** The faculties a coding agent lacks — memory, learning, imagination, self-correction, impact-awareness — are not gaps in the model's _knowledge_ but structural consequences of what a frozen transformer _is_ (a stateless map `y = f_θ(x)`, fixed weights, bounded window). They cannot be prompted or tooled away; they can only be supplied by **re-wrapping the input→process→output loop** into a closed, stateful cycle around the frozen model.

**What v2 adds.** The first edition argued the five faculties from first principles and prototyped the one that is buildable today. This edition (1) **grounds the argument in the field's own evidence** — twelve load-bearing pain-point statistics independently re-grounded from primary sources and graded _confirmed / vendor-reported / unverifiable_; (2) adds **six metacognitive mechanisms** the frozen loop also lacks (routing, assumption gate, decomposition, goal-anchoring, anti-over-engineering, inline verification); (3) **maps all eleven capabilities against the real 2026 Claude-Code stack**, marking each solved / partial / residual-gap so we say clearly _what not to build_; and (4) ships a **second runnable prototype** — a complexity-aware router + assumption gate, evaluated live on real models.

> **Governing discipline (the user's, adopted throughout):** _AI output is mathematically-calculated probability — non-deterministic, and never blindly trusted._ Every claim in this package is graded by how well it is sourced; every prototype decision is a transparent, attributable rule rather than another opaque model call; and trust is always earned by an **external** check, never asserted by the model.

---

## What's in this package

### 1. The white paper (core deliverable) — 48 pp

- **`cognitive_substrate_whitepaper.pdf`** / **`cognitive_substrate_whitepaper.html`** — the full study, 13 sections + 3 appendices, 7 figures.
  - **§1–3** the root cause and the five faculties (from v1): _why_ each faculty is structurally absent (P1 statelessness, P2 frozen weights, P3 bounded context), each grounded in the real literature.
  - **§4 Evidence** _(new)_ — the twelve statistics, re-grounded. 5 confirmed, 5 vendor-reported, 2 unverifiable.
  - **§5** the Qur'anic epistemic lens — design framing/ethics, never technical authority.
  - **§6 Six mechanisms** _(new)_ — M1 routing, M2 assumption gate, M3 decomposition, M4 goal-anchoring, M5 anti-over-engineering, M6 inline verification — each formalized, with ecosystem status and a Qur'anic anchor.
  - **§7** the cognitive substrate, now with the six-mechanism metacognitive control layer (Figure 3).
  - **§8 Prototype I** the impact oracle (from v1). **§9 Prototype II** _(new)_ the router + gate. **§10 Build-map** _(new)_ the ranked opportunity list.
  - **§11** new-vs-reinvented. **§12** limitations. **§13** conclusion.

### 2. Prototype I — Codebase World-Model + Impact Oracle

- [`research/python-prototypes/impact_oracle/`](../../research/python-prototypes/impact_oracle/) — parses a codebase (AST) into a **persistent dependency graph**, predicts the **blast radius** of a proposed edit via reverse-dependency traversal with confidence decay. `python demo.py` runs end-to-end; `pytest` → **36 tests pass** with zero setup. Builds opportunity #3. (Shipped in production as `forge impact` / `forge atlas`.)

### 3. Prototype II — Complexity-aware router + Assumption gate _(new)_

- [`research/python-prototypes/router_gate/`](../../research/python-prototypes/router_gate/) — the two mechanisms at the top of the build-map, composed as `gate → route → execute → verify → escalate`. Both are **transparent additive rubrics**, not opaque LLM calls; escalation is driven by an external check. `python demo.py`, `pytest` → **19 tests pass**, `python evaluate.py --live` reproduces the live numbers. (Shipped in production as `forge route` / `forge preflight`.)
- **`eval_results.json`** — the live evaluation record (real measured tokens).

### 4. Evidence & ecosystem maps

- [`evidence_map.md`](./evidence_map.md) — every load-bearing statistic, its primary source, and its status (5 confirmed, 5 vendor-reported, 2 dropped).
- [`ecosystem_map.md`](./ecosystem_map.md) — every faculty & mechanism vs. the real 2026 stack, with the residual gap and the proposed contribution.

### 5. Figures & appendices

The seven figures (the frozen loop; the substrate; the six-mechanism control layer; an impact blast-radius graph; the precision/recall evaluation; the router loop; the live router evaluation), the 32-source reference list, and the Qur'anic-lens table are all in the white paper itself ([PDF](./cognitive_substrate_whitepaper.pdf) · [HTML](./cognitive_substrate_whitepaper.html)).

---

## The honest headline results

### Prototype I — Impact Oracle (against mutation-derived ground truth, 5 real edits)

| Method                               | Precision | Recall   | F1       |
| ------------------------------------ | --------- | -------- | -------- |
| **Graph Oracle** (ours)              | 0.63      | **1.00** | 0.75     |
| Grep baseline (what agents do today) | 0.73      | 0.94     | **0.79** |
| Edited-file-only                     | 1.00      | 0.53     | 0.65     |

The oracle does **not** dominate F1 — grep edges it at the default threshold, and we say so. What the oracle uniquely provides is **guaranteed recall**: for "show me everything my edit could break," a silent miss costs far more than an extra file to check, and only the structural oracle drives false negatives to zero (precision tunable, best F1 = 0.79 at threshold 0.4).

### Prototype II — Router + Gate (live, on real models: haiku / sonnet / opus)

| Metric                                  | Result                                         |
| --------------------------------------- | ---------------------------------------------- |
| Gate accuracy (should-ask)              | 30/30 · precision 1.00 · recall 1.00           |
| Routing accuracy (well-specified tasks) | 21/21 exact tier                               |
| **Real cost saved vs always-premium**   | **62.1%** (same measured tokens)               |
| Execution-verified sub-experiment       | 3/3 routed-down outputs passed real test cases |

**Honest caveat (both prototypes):** these are **demonstrations, not benchmarks**. The router's 30-task set is hand-labeled and the rubric thresholds were tuned against it, so perfect separation shows the rubric _can_ distinguish these cases — not field accuracy. The oracle's evaluation is 5 mutations + 2 stdlib scale checks. We apply the "retired SWE-bench Verified" caution (§4, confirmed) to our own numbers.

## What the evidence re-grounding caught

The independent re-grounding **changed our claims** — three widely-repeated numbers did not survive and are _not_ used as fact in this paper:

- **"2.74× more vulnerabilities"** is not traceable to Veracode's own report (only their 45% OWASP figure is); likely conflated with a separate study.
- **"17% lower comprehension / 400K sessions"** merges two different studies — the session study contains no comprehension finding.
- **GitClear 4× vs 8×** internal inconsistency and **JetBrains 77%** could not be located in primary form.

That a re-grounding pass corrected the paper is the point, not an embarrassment: it is the same discipline the architecture makes structural — _a stored fact is provisional until an external check confirms it._

## The build-opportunity map (what to build, what to skip)

**Already solved — do not rebuild:** M1 routing (model tiering + gateways like LiteLLM/OpenRouter) and M3 decomposition (subagents, Agent-Teams). The router prototype's honest contribution is only the _transparency layer_, and we say so.

**The genuine whitespace, ranked:** (1) **assumption/uncertainty gate** — the project's named root failure and the field's named gap; nothing supplies calibrated known-unknowns. (2) **validity-anchored memory** — backends store notes, none tracks invalidation-by-correction. (3) **mandatory pre-action impact gate** — indexers retrieve, none is a deterministic blast-radius check. (4) outcome-validated learning. (5) doom-loop / root-cause correction. (6) scope-minimality. This paper prototypes #1 and #3 — the two where a single session can produce checkable ground truth.

## What is genuinely new vs. reinvented

Most components are borrowed (external memory, fast/slow learning, code graphs, model tiering — all exist). The contribution is **the composition and the framing**: the closed-loop shape; **validity-anchored memory** (prune by whether a past prediction was confirmed by an _external_ oracle, not by the model's own judgment); wiring exact impact analysis into a **mandatory pre-action gate**; a **transparent** router/gate that explains every decision; and deriving _which_ safeguards are non-negotiable from a coherent epistemology. That turns scattered literatures and named-but-unsolved gaps into one buildable architecture aimed squarely at coding agents.

## Scope & limitations (stated honestly)

Two faculties/mechanisms are prototyped, not eleven. The impact oracle's static analysis is single-language (Python) and conservative on dynamic dispatch. The router/gate rubrics are keyword heuristics tuned on a small hand-labeled set. Memory validity, outcome learning, and doom-loop diagnosis remain _specified but unbuilt_ — the harder research gaps, marked as such rather than gestured at with a demo. The lens is framing: reject it and you lose the organizing vocabulary but none of the technical content.
