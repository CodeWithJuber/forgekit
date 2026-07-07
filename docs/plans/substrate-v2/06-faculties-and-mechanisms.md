# 06 — Faculties & mechanisms: the algorithms for everything else

> Per-capability specs for the paper points not owned by docs 01–05: impact hardening,
> imagination, self-correction, M3 decomposition, M4 drift, M5 lean, M6 inline
> verification, M1 calibration, doom-loop diagnosis. Each names its algorithm, data
> structure, and the `src/` module it extends. Phase P5 (plus the atlas work in P1/P5).

## §1 Impact-awareness — harden the atlas, make the gate mandatory

**Today:** `src/atlas.js` builds a regex-approximate symbol graph (honest, conservative);
`impact()` traverses reverse edges with hop-decay; the gate only blocks under
`FORGE_ENFORCE=1`.

**Plan:**

- **Graph:** keep the incremental design (nodes keyed by file content hash — unchanged
  files never re-parsed, paper §8.1) and add an **AST tier** where a parser is cheap
  (TS/JS via the TypeScript compiler API — legal under ADR-0005; Python via `ast` as in
  the paper's prototype). Regex tier remains the universal fallback; each edge records
  its tier so confidence decay can discount regex edges (`w_edge`: ast 1.0, regex 0.7,
  verified-by-outcome 1.2 via `edge` claims — the ledger overlay).
- **Data structure:** adjacency + **reverse-edge index** (symbol → dependents) for O(deg)
  blast queries; per-file symbol table for incremental invalidation.
- **Mandatory gate:** the PreToolUse guard blocks file-mutating tool calls whose target
  symbols have no computed blast radius this session (ships enforcing by default in P5 —
  the paper's opp. #3 is "mandatory, hook-enforced", and ADR-0003 says guards, not
  prose). Escape hatch: `FORGE_GATE=advisory` env for opt-out, inverting today's opt-in.
- **Accuracy loop:** each predicted blast radius becomes a claim; post-change test/CI
  results confirm or contradict it (write-back band) — `forge eval` gets live
  precision/recall over time instead of fixture-only (extends `evalImpact()` in
  `src/eval.js`).

## §2 Imagination — the consequence simulator g (paper Eq. 4)

The paper: `ĉ = g(a, C)` predicting `{broken call sites, type errors, failing tests}` —
partly exact (static), partly cheap simulation (sandboxed tests). Atlas gives the static
half; P5 adds the simulation half:

1. **Impacted-test selection.** Build the bipartite cover relation `covers(test, symbol)`
   from atlas (`contains` edges of test files + call edges into `S ∪ blast(S)`). Choosing
   the cheapest test set covering the blast radius is **weighted set cover** (weight =
   measured test duration); greedy gives the classic `ln n`-approximation and is exact on
   the small instances that matter. Output: a minimal dry-run suite instead of "run
   everything" (minutes → seconds — what makes pre-action simulation affordable at all).
2. **Sandboxed dry-run.** Apply the proposed diff in an ephemeral worktree
   (`git worktree` — the same isolation the ecosystem already trusts for fan-out), run
   typecheck + the selected suite, discard. Result = a `prediction` outcome: the
   *imagined* consequence, now with evidence, attached to the plan before any real edit.
3. **Cost control:** dry-run only when the impact gate ranks the edit risky —
   `risk = Σ_{n∈blast} conf(n)·w(kind_n)` above threshold, or blast crosses a package
   boundary. Trivial edits skip simulation (M1's proportionality principle).

This is the paper's open build target ("no general, reusable such component exists", §3
Imagination) scoped to where code makes it tractable: exact structure + cheap oracle.

## §3 M3 — automatic decomposition boundaries

The paper marks M3 solved (subagents, worktrees) *except* "choosing the partition
boundary is still a human heuristic" (§5.3). The residue, formalized:

- Build the **task-dependency graph**: nodes = subtasks from `src/scope.js`
  decomposition, weighted edges = shared working-set mass `w(u,v) = Σ_{e∈R(u)∩R(v)}
  tokens(e)` (required-knowledge sets from [04](./04-context-assembly.md) — already
  computed).
- Partition to minimize cut weight subject to each part's working set fitting the window
  budget: `min Σ_cut w(u,v)` s.t. `tokens(⋃_{u∈Cᵢ} R(u)) ≤ B` — constrained graph
  partitioning. At session scale (≤ ~20 subtasks) **greedy modularity merging**
  (agglomerate while budget holds, never merge across a zero-density cut) is sufficient;
  no METIS needed.
- Output: `forge scope --plan` renders the partition — "fork these 2 subtasks (disjoint
  working sets); keep these 3 sequential (78 % shared context)" — consumable by
  subagent/worktree tooling. ForgeKit does **not** re-implement orchestration (paper §10:
  do not rebuild).

## §4 Self-correction — the external-oracle cascade

Formalizes `src/verify.js` + crew reviewers per the paper's honest negative (§3: intrinsic
self-correction unreliable, C12: self-preference):

- **Cascade, cost-ordered:** typecheck (seconds) → impacted tests (§2's selected suite) →
  independent reviewer (`global/crew/independent-reviewer.md`, *different model tier*
  than the generator, per C12) → human.
- **Verdict rule:** an action is *verified* only with ≥ 2 confirming signals from
  families external to fθ (type/test/human) — the same cross-family gate as
  `scoreMistake()`. A lone LLM reviewer approval is advisory, never sufficient.
- Each cascade stage emits `outcome` claims → the write-back band. Escalation to a
  costlier stage only on a *verified* failure of the cheaper one (M1's clause).

## §5 M4 goal-drift + doom-loop root cause (the two "am I still on track?" controls)

**M4 — CUSUM drift control** (extends `src/anchor.js`):

- Goal `g` is minted as a pinned claim at task start. Drift signal per checkpoint:
  `Dₜ = 1 − sim(g, rolling summary of recent actions)` — sim = MinHash Jaccard (embedding
  backend optional), summary from the trace of file targets + stated step intents.
- A raw threshold on `Dₜ` is noisy (single checkpoint can legitimately explore). Use a
  **one-sided CUSUM control chart**: `Cₜ = max(0, Cₜ₋₁ + Dₜ − k)`; alarm at `Cₜ > h`
  (defaults k = 0.35, h = 1.0 — calibrated in P8 fixtures). CUSUM detects *sustained*
  small drift with provably minimal detection delay for a given false-alarm rate
  (classical sequential analysis) — exactly the "decaying anchor" failure the paper
  documents, caught early.
- Alarm action: re-inject the goal claim, force context re-assembly with the goal pinned
  ([04](./04-context-assembly.md) §4), and require an explicit "resume / re-scope"
  decision. Never silent.

**Doom-loop diagnosis** (extends `global/guards/doom-loop.sh`, paper opp. #5):

- **Failure signature** `= sha256(error class ‖ normalized message ‖ file ‖ symbol)`
  (message normalized: strip line numbers, addresses, timestamps). Ring buffer of recent
  signatures in the session trace.
- Same signature `k = 3` times ⇒ **thrash**, not progress: halt the retry loop, mint a
  `diagnosis` claim (signature, attempted fixes so far, blast context), escalate one
  model tier *with the diagnosis as the prompt's head* — the escalation is
  diagnosis-carrying, not "try again but more expensive".
- Diagnosis claims are team-shared via the ledger: teammate hits the same signature next
  week, the diagnosis is retrieved at score-time (Eq. 3 rel on the signature). The doom
  loop becomes a one-per-team event instead of one-per-session.

## §6 M5 lean + M6 inline verification (the two "how much is enough?" controls)

**M5 — footprint metric** (extends `src/lean.js`, which already parses diff footprints):

- Define `φ(y) = (files touched, new exported abstractions, net LOC)` — measured by
  `parseDiffFootprint()`. Estimate the task-implied minimum `φ*(x)` from the reuse cache
  and ledger: the footprint distribution of *verified* artifacts for tasks in the same
  fingerprint neighborhood (median of near-matches). Flag when
  `φ(y) ≫ φ*(x)` component-wise (default: any component > 2× the neighborhood median
  and above `assessFootprint()`'s absolute floors).
- Tie-break rule, MDL-flavored: between candidate solutions that pass the same oracle,
  prefer minimal description length (fewest new abstractions, then fewest LOC). Advisory
  in P5; enforcing only for the UI gate ([07](./07-ui-quality-gate.md)) where the slop
  correlation is strongest.

**M6 — checkpoint scheduling** (extends `src/verify.js` + PostToolUse hooks):

- The question "when to check?" is optimal stopping: insert a checkpoint when the
  expected loss of continuing-while-wrong exceeds the check's cost:
  `p_err(t) · tokens_at_risk(t) · c_tok > c_check`. With hazard `p_err` per step
  estimated from ledger outcome history per tier (haiku ≫ opus), this yields a
  **deterministic cadence**: check every `n* = ⌈c_check / (p_err·c_tok·s̄)⌉` meaningful
  steps — smaller `n*` for cheaper tiers and riskier blast radii. No magic constants;
  every input is measured or priced.
- A "check" = the cheapest cascade stage that can falsify the current step (usually
  typecheck on touched files) surfacing a one-line human-checkable claim — the paper's
  interpretive checkpoint (§5.6), priced so it can afford to run *during* generation.

## §7 M1 — outcome-calibrated routing (closing the paper's own caveat)

Paper §9.3: "a production version would … likely learn the rubric weights rather than
hand-set them." With the ledger, the training signal exists:

- Every routing decision + external-verifier outcome is an `outcome` claim
  (`tier, rubric features, pass/fail/escalated`).
- Periodically fit logistic regression `P(pass | tier, features)` (pure-JS IRLS on a few
  hundred rows — no dependency needed) and choose the cheapest tier with
  `P(pass) ≥ 0.9`; hand-set rubric weights remain the cold-start prior and the
  explanation surface (the rubric stays additive and auditable — transparency is the
  feature, per §9.1).
- The auditable per-task surface ships regardless: `forge route --explain` prints every
  feature, its points, the tier, and the calibrated `P(pass)` — the "thin transparency
  layer" the paper says is the only thing left to build for M1 (§5.1).
