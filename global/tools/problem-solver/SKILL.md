---
name: problem-solver
description: Universal problem-solving engine that fuses proven frameworks (ASQ 4-step cycle, DMAIC/PDCA, 5 Whys, Fishbone, First Principles, TRIZ, Cynefin, Design Thinking, weighted decision matrix) into one staged loop. Use when the user asks to solve, analyze, or break down a problem, find root causes, choose between options, innovate, make a hard decision, handle a crisis, or wants structured/step-by-step problem solving.
---

# Problem Solver

This skill solves any problem — technical, business, personal, or complex — through a
staged loop. Each analytical stage carries a discipline that keeps the analysis honest
(e.g. verify facts before diagnosing root cause). Match depth to the problem: a trivial
problem gets two sentences of method, not all six stages.

## Core Workflow: The Problem-Solving Cycle

Run these 6 stages in order. Loop back when a stage fails its exit check. Always state
which stage you are in.

```
[Problem] --> 1. CLARIFY        -> Define + verify facts
          --> 2. CLASSIFY       -> Pick the right mode of attack (Cynefin)
          --> 3. DIAGNOSE       -> Root cause, not symptoms
          --> 4. GENERATE       -> Multiple options, wide consultation
          --> 5. DECIDE         -> Weighted choice + ethics screen
          --> 6. ACT & SUSTAIN  -> Plan, pilot, review, persist
```

### Stage 1 — CLARIFY

- Separate **fact from opinion**: verify information before acting on it.
- Answer 5W2H: What happened? Where? When? How much/many? Who detected it? Why is it a
  problem? (Who is for detection only, never blame — blame corrupts the data.)
- Write a one-sentence problem statement. Exit check: a neutral third party would agree
  the statement is factual, not a symptom or a guess.

### Stage 2 — CLASSIFY (Cynefin)

Classify the problem's context to choose the strategy:

- **Clear/Obvious** -> apply best practice directly; skip to Stage 6.
- **Complicated** -> expert analysis needed; go to Stage 3 with analytical tools (5 Whys,
  Fishbone, First Principles).
- **Complex** -> cause-and-effect only visible in retrospect; probe with small
  safe-to-fail experiments (PDCA loops) instead of one big plan.
- **Chaotic** -> act first to stabilize (stop the bleeding), then reclassify.
- **Disorder** -> gather more information; return to Clarify.
  Never apply linear fixes to complex systems.

### Stage 3 — DIAGNOSE (root cause)

- Use **5 Whys** for linear chains, **Fishbone (6M)** for multi-cause problems, **First
  Principles** to strip assumptions to unarguable truths, **TRIZ** when the problem is a
  contradiction ("improving X worsens Y").
- Reflect deeply: reconcile apparent contradictions before concluding; reject
  surface-level answers.
- Exit check: fixing this cause prevents recurrence. If the "root cause" is a person, dig
  one level deeper — it's usually a system or process.

### Stage 4 — GENERATE (options + consultation)

- Generate **at least 3** genuinely different options before evaluating. Never run with
  the first idea.
- Consult diverse perspectives deliberately — frontline people, skeptics, domain experts,
  and those affected. Ask the user who should be consulted.
- Use brainstorming, working backward, Nine Windows (past/present/future ×
  sub/system/supersystem), or analogy from other domains. If stuck, recommend "sleep on
  it" — incubation is a legitimate step, not delay.

### Stage 5 — DECIDE (weighted matrix + ethics screen)

- Build a **weighted decision matrix**: effectiveness, feasibility, cost, risk,
  reversibility, alignment with goals — plus a mandatory **ethics column** (does it harm
  anyone? is it honest? does it betray a trust?).
- Screen out any option that fails the ethical screen regardless of score: the ends never
  justify unjust means, and no option may be built on deceit or wrongful gain.
- After due diligence, commit with calm and stay unattached to the ego's preferred option.
  Document the decision and its rationale.

### Stage 6 — ACT & SUSTAIN

- Plan with who/what/when; run a **small pilot** first when stakes are high (PDCA:
  Plan-Do-Check-Act).
- Do everything within your power, then stay calm about the outcome — this kills both
  paralysis and recklessness.
- Monitor with leading indicators and feedback channels. If targets are missed: bad
  execution -> redo Stage 6; poor solution -> redo Stages 4-5; wrong cause -> redo Stage 3.
- Persist through slow results; do not abandon a sound plan at the first setback.
- Standardize and document the fix so the problem cannot recur; extract lessons learned.

## Reference Files

Load only when needed:

- **references/frameworks.md** — Detailed tool guide: 5 Whys, Fishbone, First Principles,
  TRIZ (40 principles + contradiction method), Cynefin, DMAIC, PDCA, 8D, A3, Design
  Thinking, Nine Windows, decision matrix, potential problem analysis. Read when a stage
  needs a specific tool's full procedure.
- **references/principles.md** — The disciplines behind each stage (verify, reflect,
  consult, screen ethics, effort-then-acceptance, persist) with application prompts and
  boundaries. Read when a problem is ethical, personal, or high-stakes.
- **assets/problem-solving-canvas.md** — Fill-in canvas template covering all 6 stages.
  Offer to fill it for substantial problems.

## Behavior Rules

- Match depth to problem size: a trivial problem gets 2 sentences of method, not 6 stages.
- Be generic: the same cycle serves code bugs, business strategy, relationship conflict,
  or research blockers — only the tools per stage change.
- Prefer evidence over assertion at every stage; a confident guess is still a guess.
