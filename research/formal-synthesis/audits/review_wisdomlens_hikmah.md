# Review — `wisdom-lens` plugin and `hikmah-stack` v3.0.0

**Reviewer:** Claude Science, on request. **Date:** 13 August 2026.
**Audited:** `wisdomlens.zip` (plugin v1.0.0, 15 files); `CodeWithJuber/hikmah-stack` at commit
`4827966f` (main, Rust kernel v3.0.0); the two source manuscripts *The New Lens* and
*The Wisdom Playbook*; and `CodeWithJuber/forgekit` (context).

**Method.** Every statistic was re-verified against a primary source that was actually fetched
(USENIX/arXiv PDFs, METR's own site, a *Science* DOI, PubMed, live trackers). The Rust kernel was
not merely read but **built and run** — `cargo build --release`, `cargo test --workspace` (4/4),
`cargo clippy -D warnings`, `cargo fmt --check` all pass — and exercised through the compiled
`hikmah` CLI. Where something could not be verified, it is marked as such. Where I earlier asserted
a number I had not retrieved, it is retracted below.

---

## 1. The headline: three artifacts, one law, arrived at four times

The plugin, the Rust stack, `forgekit`, and the formal theory are the same architecture in four
vocabularies. The theory's central result (Theorem D) says reliability is a **probabilistic
instruction layer** (`p<1`) multiplied by a **deterministic interception layer** (`c→1`), with
`P(silent miss) = (1-p)·∏(1-c_j)`. Every one of the four states that law in its own terms:

| Layer | Its statement of the law |
|---|---|
| Formal theory | Theorem D, with proof |
| `forgekit` | committed store + lifecycle hooks |
| `hikmah-stack` | *"The kernel is not a neural network... learned models are optional proposal engines"* |
| `wisdom-lens` | Ch. 14: *"Encode invariants in permissions and code, never in prompts alone"* |

That four independent efforts converged is the strongest available evidence that the law was
**discovered rather than invented**.

---

## 2. The most important finding: the law is violated inside the repo that states it

`hooks/codex.json` wires the Stop gate as `{"type":"command"}` → the deterministic
`truth_gate.sh`. `hooks/hooks.json` — the **Claude** adapter — wires `{"type":"prompt"}`, an
LLM-graded check. Meanwhile `truth_gate.sh:4` reads:

```sh
ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
```

The deterministic gate **already supports Claude Code** — I confirmed by execution that
`CLAUDE_PLUGIN_ROOT` behaves identically to `PLUGIN_ROOT`. So Claude users get only the soft
factor where a hard floor already exists in the repo.

**It is an oversight, and git proves it.** `hooks/hooks.json` has exactly one commit (`eb2b88dc`,
v2.0.0). `hooks/codex.json` has two — that one plus `2c72120d` (v3.0.0), which shipped the entire
Rust kernel, added `truth_gate.sh`, and rewired Codex to prefer the deterministic binary. That
commit touched **67 files; `hooks.json` was not among them.** One adapter was upgraded in the
migration; the other was missed.

**The fix** (`hooks_fixed.json`) runs both layers — deterministic floor first, then the existing
prompt gate preserved byte-identical. This is the literal composition the theorem prescribes, and
matches your instruction to keep the semantic check rather than replace it.

### The sharpest corollary
`hikmah validate` returns `"ok": true` on this exact asymmetry (I ran it). It checks that JSON
parses, names are unique, and versions match — **not** that a hook fires or that the two adapters
are behaviorally consistent. The repo's own CI structurally cannot catch a missing-`Π₂`
configuration. That is Theorem D applying to the tooling built to enforce Theorem D.

---

## 3. Evidence audit: 17 statistics, 0 unverifiable

**7 confirmed · 7 confirmed-with-caveat · 1 vendor-reported · 2 stale · 0 unverifiable.**

**The USENIX reconciliation.** The apparent conflict between the book's 19.7% and
`EVIDENCE.md`'s 5.2%/21.7% is **not a conflict** — it is one study (Spracklen et al., USENIX
Security '25) reported at two correct denominators. 5.2%/21.7% is the **code-sample** level
(576,000 samples). 19.7% is the **package-mention** level: those samples contained 2.23M package
recommendations, of which 440,445 were hallucinated. The 43%-recurrence figure is a third
sub-experiment (500 prompts × 10 reruns). Both documents should footnote their denominator.

**Two figures are stale:**
1. **19.7% package hallucination** — accurate for the Sept-2024 cohort tested, but a 2026
   replication on five frontier models (arXiv:2605.17062) finds **4.62%–6.10%**, an order-of-magnitude
   narrowing. That preprint is **single-author, non-peer-reviewed**, and its author flags an
   uncontrolled training-data-contamination confound — so it is a caution against the old number,
   not a settled replacement.
2. **1,598 court decisions** (Charlotin) — a **live tracker**; the direct fetch returned **1,870
   as of 13 Aug 2026**. Any hardcoded count is stale by construction; phrase it "as of \<date\>".

**METR's Feb 2026 follow-up SCOPES the original — it does not retract or confirm it.** METR calls
its own second experiment *"only very weak evidence"* because of self-documented selection effects
(developers refusing to work without AI even at $50/hr vs the original $150/hr; 30–50% withheld
tasks). Its raw estimates lean toward speedup but METR declines to stand behind them. **Citing the
follow-up as proof AI now speeds developers up would overclaim what METR itself says.**

**One correction to the plugin's framing:** the Lancet endoscopist de-skilling study is
**retrospective observational, not randomized**. Chapter 15's thesis leans on it, so the design
should be named.

---

## 4. Provenance loss in distillation — the plugin is weaker than its own source

Five of six statistics lost material provenance between manuscript and plugin. The source text is
**better sourced than the artifact built from it**:

| Statistic | Lost in distillation |
|---|---|
| Package hallucination | the 2.23M denominator, and the 43%-recurrence mechanism that makes slopsquatting *farmable* |
| Sycophancy | author attribution (Cheng et al.), model count (11), and the more damning 51%-vs-zero-consensus result |
| Duplication/reuse | the definition of "reuse" as move-refactor operations — which is what makes the number interpretable |
| Endoscopist de-skilling | operator experience (2,000+ procedures each) and the ~3-month onset window |
| Cost incidents | named checkable incidents replaced by a smaller anonymous one |
| Context degradation | *(survived intact)* |

This matters because the plugin's own Ch. 6 requires *"Tag every output: known, inferred, or
guessed"* and *"Open the source."* **The manuscript meets that bar; the plugin does not yet.**

Credit where due: the manuscript's *"A Word on Sources"* is methodologically stricter than our own
paper's caveat — it documents the Term Decoder universalization, states that *"no verse is offered
as a proof-text for the AI claim it neighbors,"* and applies its own Rule 1 to itself. One
universalization leftover survives in `new-lens/references/anchors.md`: *"the verse counts the
questions."*

---

## 5. What `hikmah-stack` adds beyond the theory

17 components mapped: **3 identities, 5 refinements, 4 extensions, 5 with no counterpart.** The
last group is the most valuable, because these are capabilities our formal theory does not have:

- **Branch Loom** (`planner.rs:33-94`) — a STRIPS-style BFS forward planner. Our A1–A7 are entirely
  about *impact analysis and handoff on an existing graph*; none plans a new action sequence toward
  a goal. Genuinely separate capability.
- **Prospective memory** (`TraceKind::Commitment`, `Trace.deadline_ms`, `prospective.rs:12-32`) —
  our entire model of "what must happen" is task-scoped and present-tense. Deadlines and
  commitments that outlive the task have no counterpart in our framework at all.
- **Privacy classes** (`PrivacyClass::{Public,Private,Sensitive}`, `ledger.rs:108-140`) — our `Π₁`
  is silent on what class of information is *safe* to persist. Hikmah refuses sensitive
  persistence by default. This is a real gap in our theory.
- **Append-only provenance** — and here there is a genuine **divergence**, not just an addition:
  hikmah replays the full ledger from genesis for perfect auditability, where our A4 deliberately
  bounds the snapshot (`|σ| ≤ B`) so loader cost stays `O(bounded)`. Both positions are defensible;
  they trade auditability against boot cost.

## 6. Correctness concerns found in the code

Each was found by reading or running the code, not inferred:

1. **Block-at-most-once has a single point of failure** — the kernel keeps no internal marker; it
   depends entirely on the host setting `stop_hook_active`. Repeated invocation with that flag
   false blocked every time.
2. **Deliberation Lanes are not independent** in the sense the docs imply — `council.rs`'s five
   lanes are pure functions of integers the *caller* passes on the command line. The
   `std::thread::scope` concurrency is real, but it parallelizes five arithmetic computations, not
   five independent judgments. Nothing prevents one upstream process computing all five with the
   same blind spot.
3. **`FocusCapsule.pinned` has no reader** — `pin()` sets a boolean; nothing in the crate ever
   checks it. The implied eviction protection is not wired up.
4. **CounterTrace's conflict detection is purely syntactic** — `normalize()` only lowercases and
   collapses whitespace, so `"us-east-1"` vs `"US East 1"` (same fact) is missed, while
   `"us-east-1"` vs `"us-east-1 (primary)"` (compatible) is falsely flagged.
5. **No ledger compaction** — full `.jsonl` replay on every start. To the authors' credit,
   `docs/EVALUATION.md` already lists "ledger replay time" as a metric they intend to measure, so
   this is a known open question rather than an unnoticed one.

## 7. What is well built

Not faint praise — these are things this programme should copy:

- **`docs/EVIDENCE.md` is better evidence discipline than our own paper's.** Per-document
  `Verified: <date>` stamp, a standing five-rule maintenance policy, and a "use carefully"
  limitation on every statistic. It had METR's Feb 2026 caveat on file **before this audit began**;
  our evidence map did not. We have adopted the practice.
- **The `ProposalEngine` trait is the strongest architectural expression of P2 (frozen weights) I
  have seen** — a swappable model behind a stable interface, so replacing the model does not delete
  the agent's commitments, provenance, or correction history.
- **Decision Forge applies hard constraints lexicographically, not as weights** — verified in
  `decision.rs:48-118`. A high score genuinely cannot average away a safety block. Doctrine rule 5
  is implemented, not just asserted.
- **`truth_gate.sh` is fail-open in all five ladder branches** (empirically exercised), satisfying
  the theory's T2 property.
- **Dropping GitClear was defensible** — the 4×-vs-8× internal inconsistency in their materials is
  real and reconfirmed. But it now reads as slightly over-cautious: the direction is corroborated
  by unrelated telemetry. Recommend re-including it with a vendor-conflict flag rather than silence.

## 8. Recommendations, in priority order

1. **Wire the deterministic gate into the Claude adapter** (`hooks_fixed.json`) — the one change
   with a proof behind it.
2. **Add a behavioral check to `hikmah validate`** that the Stop adapters are consistent, so CI can
   catch what it currently cannot.
3. **Re-date the two stale statistics**; add the 2026 preprint as a caution (flagged unreviewed).
4. **Add the METR Feb-2026 scoping** to the plugin's diagnostics reference.
5. **Restore the lost denominators and author attributions** to the plugin's statistics.
6. **Name the Lancet study's observational design** in Ch. 15.
7. **Give `FocusCapsule.pinned` a reader, or remove it.**
8. **Remove the leftover** *"the verse counts the questions"* line if universalization was intended.

---

## 9. Corrections to my own work

Two defects in my earlier output, both fixed and both disclosed on `forgekit` PR #52:

1. I told you a count-reconciliation commit had shipped to the PR. It had not — the file I wrote
   and the file I pushed were different paths, so the stale version shipped. Commit `7479ab18`
   ships the real one, and I verified the pushed bytes through the API this time instead of
   trusting a `200` on the ref update.
2. I stated the `440,445` count and the 4.62%–6.10% narrowing **as verified when I had not
   retrieved either.** I retracted both publicly. They now appear in this review only because the
   evidence pass actually fetched both PDFs. The distinction matters more than the numbers: an
   unverified number that later turns out to be right was still unverified when I said it.

*Applying the source text's own Rule 1 to this review: verify before acting. Every statistic above
is traceable to a fetched primary source; every code claim to a file and line I read or ran.*
