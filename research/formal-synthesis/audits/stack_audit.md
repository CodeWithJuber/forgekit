# Stack Audit: hikmah-stack v3.0.0 vs. the formal cognitive-substrate / reliability-framework theory

**Repo audited:** [`CodeWithJuber/hikmah-stack`](https://github.com/CodeWithJuber/hikmah-stack), default branch `main`, commit `4827966f` (2026-08-09T19:15:16Z) — the kernel logic itself was last changed in `2c72120d` ("Release Hikmah Stack v3.0.0 cognitive kernel", 2026-08-09T17:04:48Z). MIT license, single-maintainer repo (1 star, 0 forks, 0 open issues at audit time — this is a young, single-author project, not an established or widely-reviewed one; every claim below should be read with that base rate in mind).

**Method.** Every doc (`docs/*.md`), all six `skills/*/SKILL.md`, all three `lenses/*.md`, all three `playbooks/*.md`, the Claude orchestrator agent, and the full Rust crate (`runtime/hikmah-kernel/src/*.rs`, 15 modules + 2 test files) were read in full. The crate was then **built and run**, not just read: `cargo build --release`, `cargo test --workspace` (4/4 tests pass), `cargo clippy --workspace --all-targets -- -D warnings` (clean), and `cargo fmt --check` (clean) all succeeded on a fresh checkout. The compiled `hikmah` binary was then exercised directly — `remember`, `recall`, `decide`, `deliberate`, `consolidate`, `plan`, `hook`, `verify-ledger` — to empirically confirm or refute specific behavioral claims (lexicographic hard-blocks, contradiction detection, hash-chain tamper detection, the Stop-hook block/allow logic, the fallback ladder, sensitive-persistence refusal) rather than trusting documentation or code comments alone. Git history for the two hook files was pulled via the GitHub commits API to establish when each was last touched.

---

## 1. Architecture summary

Hikmah Stack self-describes as a **"deterministic Rust co-model runtime"** sitting beside — not inside — a language model. The repo has four layers (`docs/ARCHITECTURE.md`):

1. **Portable doctrine** — `skills/`, `playbooks/`, `lenses/`: markdown instruction bundles, host-agnostic, consumed as context by whatever LLM is driving the session.
2. **The Hikmah Cognitive Kernel** — `runtime/hikmah-kernel/`, a Rust crate (`hikmah-kernel` lib + `hikmah` binary) with **zero machine-learning dependencies** (`Cargo.toml` lists only `blake3`, `clap`, `serde`, `serde_json`, `thiserror` — confirmed by reading the manifest and the successful offline-of-ML build).
3. **Proposal engines** — an optional, swappable model layer behind a two-method trait (`ProposalEngine`), with exactly one shipped implementation: a null object that returns no proposals.
4. **Host adapters** — `.claude-plugin/`, `.codex-plugin/`, `kimi.plugin.json` — thin per-host packaging.

The Rust kernel is organized into six subsystems the docs name **TraceWeave** (memory), **Amanah Ledger** (hash-chained provenance), **CounterTrace** (contradiction detection), **Decision Forge** (multi-criteria scoring), **Deliberation Lanes** (parallel challenge), and **Branch Loom** (symbolic planning), plus a **Truth Gate** completion hook and a **Model Port** (`ProposalEngine`) boundary. It is worth stating plainly: **these are documentation/brand names, not Rust identifiers.** `grep -rn "TraceWeave\|Amanah\|Branch Loom" runtime/` returns nothing inside the crate — the actual module names are the plain `trace.rs`, `ledger.rs`, `claims.rs`, `decision.rs`, `council.rs`, `planner.rs`, `hook.rs`, `model_port.rs`, `focus.rs`, `prospective.rs`, `consolidation.rs`, `policy.rs`, `validate.rs`, `error.rs`. This is not a defect — it just means the crosswalk below maps the theory onto the CODE, and separately notes what the docs call each piece.

The crate is small and readable in full: **17 `.rs` files (15 modules declared in `lib.rs` + `main.rs` + `lib.rs` itself), 1,711 lines of source** (excluding the 2 integration-test files), zero `unsafe` blocks, one dependency on cryptographic hashing (`blake3`) and none on any ML framework, tensor library, or network client — confirmed directly from `Cargo.toml`'s five-line `[dependencies]` block (`blake3`, `clap`, `serde`, `serde_json`, `thiserror`). This is a genuinely different design point from most "agent memory" projects, which tend to wrap a vector database; Hikmah's memory is a flat, hash-chained JSON-lines file walked with token-overlap scoring.

---

## 2. The crosswalk

Full row-by-row detail — including every quoted line of code and every notes field — is in [`stack_crosswalk.json`](stack_crosswalk.json) (17 rows). Condensed here:

| # | Component | Relation to our theory | One-line verdict |
|---|---|---|---|
| 1 | TraceWeave `Trace` struct | refinement | Typed 9-kind record with salience/confidence/privacy/deadline as struct fields — richer than our Π₁, but confidence is not auto-revised on correction |
| 2 | Amanah Ledger (hash chain) | extension | Blake3-chained, sequence-numbered append log; tamper detection **empirically confirmed** by flipping a byte and re-verifying |
| 3 | Resonance recall (`recall.rs`) | refinement | Explicit 7-channel weighted formula (`0.42·lexical + 0.10·tag + 0.10·recency + 0.11·salience + 0.10·confidence + 0.10·provenance + 0.07·prospective`), pure token-Jaccard, no embeddings; redundancy suppression **empirically confirmed** |
| 4 | CounterTrace (`claims.rs`) | identity | Matches our I1 "contradictions remain visible" almost exactly; **empirically confirmed** both conflicting traces stay active, neither is auto-resolved |
| 5 | Decision Forge (`decision.rs`) | identity (block mechanism) | Hard blocks are a **lexicographic sort key**, not folded into the score — **empirically confirmed**: a 1.0-scoring blocked option ranks below a 0.1-scoring unblocked one |
| 6 | Deliberation Lanes (`council.rs`) | extension | 5 independently-vetoing lanes over `std::thread::scope`; **but** each lane is arithmetic on caller-supplied integers, not an independent model call — "AI-verifying-AI" framing is aspirational, not demonstrated |
| 7 | Truth Gate / `hikmah hook` | refinement | Deterministic string-pattern gate for one narrow signal (completion word + unfinished marker); **empirically confirmed** block/allow/fail-open behavior; **also found**: the kernel has no internal block-once memory — relies entirely on the host's `stop_hook_active` flag |
| 8 | `hooks.json` vs `codex.json` asymmetry | no-counterpart (a finding) | **CONFIRMED**: Claude adapter uses a probabilistic `type:"prompt"` Stop hook; Codex adapter uses the deterministic `truth_gate.sh` ladder. Git history shows `hooks.json` untouched since v2.0.0 while `codex.json` was rewritten in the v3.0.0 commit |
| 9 | `ProposalEngine` trait | extension | Real, compilable, 2-method trait boundary for f_θ; **but** the only implementation is a no-op, and nothing in the CLI calls `.propose()` |
| 10 | Ten design-doctrine rules | refinement | 5 of 10 map to our I1–I4/Theorem D; rules 8–10 (unknown-as-valid-state, baseline-beats-novelty, no-perfect-engine) have no counterpart in our vocabulary at all |
| 11 | `ConsolidationProposal` (`consolidation.rs`) | extension | Partial, working answer to our own v2 paper's unbuilt gap #4 ("outcome-validated learning") — but validates multi-source **claim convergence**, not actual outcome-vs-prediction comparison |
| 12 | Branch Loom planner (`planner.rs`) | no-counterpart | STRIPS-style BFS planner; our A1–A7 never plan a new action sequence at all — this is a different capability class entirely |
| 13 | Prospective memory / commitments | no-counterpart | Deadlines actively re-weight *unrelated* recall queries — a mechanism our task-scoped Δ\* framework has no analogue for |
| 14 | Privacy scoping / sensitive-persistence refusal | no-counterpart | Refuse-by-default `PrivacyClass::Sensitive`, **empirically confirmed**; our theory's Π₁ never asks what class of data a persistent store should refuse |
| 15 | Append-only-everywhere ledger design | no-counterpart (contrast) | Unlike our A4 (bounded rewritten STATE.md + separate append-only DECISIONS.md), Hikmah has **no bounded/compacted layer at all** — full ledger replay on every open |
| 16 | Focus Capsule (`focus.rs`) | refinement | Thinner than the name implies: `.take(capacity)` truncation plus an unused `pinned` flag (no reader anywhere in the crate) |
| 17 | Six portable skills | identity | Pure Π₃ instruction content; `validate.rs` checks packaging only, never behavior — exactly the layer Theorem D says cannot stand alone |

---

## 3. The hook finding — confirmed, with quoted code and git evidence

**The claim to check:** that `hooks/codex.json` wires a deterministic command hook while `hooks/hooks.json` (Claude) wires a probabilistic prompt hook, and that `truth_gate.sh` explicitly supports Claude despite `hooks.json` never calling it.

**`hooks/hooks.json`** (the Claude adapter), in full:
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "timeout": 20,
            "prompt": "You are Truth Gate, a narrow final quality check for Hikmah Stack. Review the user request and last assistant response in $ARGUMENTS. Return {\"ok\": true} unless there is a material failure..."
          }
        ]
      }
    ]
  }
}
```

**`hooks/codex.json`** (the Codex adapter), in full:
```json
{
  "description": "Hikmah Stack completion hygiene gate. Prefers the Rust kernel, with a zero-install compatibility fallback.",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh ${PLUGIN_ROOT}/hooks/truth_gate.sh",
            "timeout": 8,
            "statusMessage": "Running Hikmah Truth Gate"
          }
        ]
      }
    ]
  }
}
```

**`hooks/truth_gate.sh`, line 4:**
```sh
ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
```

This confirms every element of the finding exactly as stated: `codex.json` invokes a `"type": "command"` hook (deterministic — a shell process with a fixed exit path), `hooks.json` invokes a `"type": "prompt"` hook (an LLM reads the prompt text and decides — probabilistic by construction, exactly our Π₃ instruction channel, not Π₂ interception). And `truth_gate.sh` was written with an explicit `CLAUDE_PLUGIN_ROOT` fallback — i.e., its author anticipated it being invoked from a Claude Code environment — yet `hooks.json`, the file that actually wires up Claude's `Stop` event, never calls it.

**Is it deliberate or an oversight?** The git history settles this. `hooks/hooks.json` has exactly one commit in its history, `eb2b88dc` ("Release Hikmah Stack v2.0.0", 2026-08-09T16:03:33Z). `hooks/codex.json` has two: the same `eb2b88dc`, and then `2c72120d` ("Release Hikmah Stack v3.0.0 cognitive kernel", 2026-08-09T17:04:48Z) — the commit that shipped the entire Rust kernel, added `hooks/truth_gate.sh`, and rewired `codex.json` to prefer it. That commit touched **67 files**; `hooks/hooks.json` is not one of them. The evidence points to an **oversight during the v3.0.0 migration**, not a considered per-host design choice: the author upgraded one adapter's Stop hook to the new deterministic gate and did not upgrade the other in the same pass. `SECURITY.md` documents the resulting asymmetry as a fact ("The Claude completion hook is prompt-based") but gives no rationale for it — consistent with an unaddressed gap rather than an intentional tradeoff, since prompt hooks are a legitimate, officially-documented Claude Code feature in general (they are commonly recommended specifically for `Stop`/`SubagentStop` completion checks), which means the choice of hook *type* isn't inherently wrong — what's missing is that the newer, stronger option that was built for the *other* adapter was never carried over.

One caution on external reliability, found via web search rather than the repo itself and **not independently reproduced by us**: a Claude Code GitHub issue from 2026 reports that `"type": "prompt"` hooks can silently fail to fire under some invocation modes (e.g., `claude -p` non-interactive calls), which — if it also affects the interactive Stop-hook path this repo relies on — would make the gap worse than "probabilistic": not merely lower-confidence, but sometimes not evaluated at all. We flag this as an external risk to be aware of, graded **unverified**, since confirming it requires a live Claude Code session, which is outside what a static repo audit can check.

**This is Theorem D made concrete.** Our theorem states reliability requires both a probabilistic instruction layer (raising `p<1`) and a deterministic interception layer (guaranteeing a floor `c→1`); neither alone suffices, and `P(silent miss) = (1-p)·∏ⱼ(1-cⱼ)`. Hikmah Stack's own two adapters instantiate both sides of that equation for the *same* conceptual gate — one host got only the Π₃ term, the other got Π₃ **and** Π₂. It is a genuinely rare thing to find a real repository where the theorem's predicted failure mode is not hypothetical but sitting in two JSON files five minutes apart in git history.

### A second, related correctness finding (ours, not the user's hypothesis, found during empirical testing)

The fallback ladder in `truth_gate.sh` was traced and tested end-to-end:
```sh
if command -v hikmah >/dev/null 2>&1; then exec hikmah hook; fi
if [ -n "$ROOT" ] && [ -x "$ROOT/bin/hikmah" ]; then exec "$ROOT/bin/hikmah" hook; fi
if [ -n "$ROOT" ] && command -v cargo >/dev/null 2>&1 && [ -f "$ROOT/runtime/hikmah-kernel/Cargo.toml" ]; then
  exec cargo run --quiet --manifest-path "$ROOT/runtime/hikmah-kernel/Cargo.toml" -- hook
fi
if [ -n "$ROOT" ] && command -v python3 >/dev/null 2>&1 && [ -f "$ROOT/hooks/truth_gate.py" ]; then
  exec python3 "$ROOT/hooks/truth_gate.py"
fi
printf '{}\n'
```
All five branches were exercised directly (installed binary on `PATH`; `$ROOT/bin/hikmah`; `cargo run` fallback; `python3` fallback; nothing available). **Every branch is fail-open**, matching our Theorem T2: if nothing is installed, the script prints `{}` (allow) rather than blocking or erroring — confirmed. This is the right default for a completion gate (never brick a session), and it is implemented correctly.

However, our **T1** ("any stop sequence terminates in ≤2 attempts; block-at-most-once") does **not** hold as an internal guarantee of the Rust kernel the way it holds for our own framework's `docs-guard.sh`. Our T1's proof relies on **two independent guards**: a monotone on-disk marker file the gate itself writes (so even if the host's re-entry flag is buggy, the marker still stops a second block), *and* the host's `stop_hook_active` flag. Reading `hook.rs` in full shows Hikmah's kernel implements only the second guard — `fn run_stop_hook` checks `payload.get("stop_hook_active")` and nothing else; there is no marker file, no session-scoped state, no on-disk record of "already blocked once." This was verified empirically: invoking `hikmah hook` three times in a row with `stop_hook_active: false` each time blocks all three times, identically. In production this is very likely harmless, because both Claude Code and Codex are documented to set `stop_hook_active: true` on the continuation turn they trigger after a block — but it means Hikmah's block-at-most-once behavior has a **single point of failure** (correct host behavior) where our own framework's proof was deliberately structured to survive a bug in that exact flag. This is a real, if narrow, difference worth the maintainer's attention, not a hypothetical one — we did not just read the code and assume; we ran it.

---

## 4. What the stack adds beyond our theory (the genuinely valuable findings)

Ranked by how cleanly the addition falls outside our theory's vocabulary:

1. **Prospective memory as an active recall channel, not just a gate check.** Our Δ\*/Done framework is entirely task-scoped: a commitment either gets checked at one Stop event or it doesn't exist in the model at all. Hikmah's `prospective` recall channel (`recall.rs:93-101`) means an *unrelated* query can surface an approaching deadline purely because of its urgency — commitments actively compete for attention in ordinary retrieval, not only at a dedicated "check my commitments" call. We have no operator for this.
2. **Privacy classification with a refuse-by-default hard stop.** `PrivacyClass::Sensitive` traces are rejected by `MemoryStore::remember()` unless policy explicitly allows them — confirmed by direct testing (`exit 1`, explicit error message pointing at the right fix: "use an encrypted vault adapter"). Our Π₁ primitive has never had an opinion about what class of data it's acceptable to persist.
3. **Hash-chained tamper evidence on the memory ledger.** Confirmed empirically: a single flipped byte in an already-written record is caught on the next open. Our Π₁ is satisfied by ordinary git-tracked files with no integrity mechanism beyond what git itself provides (which protects against tampering with the *repo*, not against a compromised *process* silently corrupting a file before it's committed).
4. **A symbolic STRIPS-style planner as an explicit non-generative baseline.** Branch Loom exists for a purpose our theory never had a slot for: giving future learned planners something falsifiable to beat. This is a different capability axis (plan *synthesis*) from our framework's impact *analysis* on an existing graph.
5. **An explicit trait boundary for the frozen model**, not just an architectural principle. `ProposalEngine` makes "the model proposes, the kernel decides" a compile-time-checked interface rather than a design intention — the strongest literal encoding of "swap `f_θ` without deleting durable state" in anything we have reviewed, even though (see §5) only a null implementation ships today.
6. **An "unknown is a valid serialized state" rule**, matched by concrete `Option<T>` fields and a `missing_criteria` list surfaced explicitly in decision output — rather than our theory's treatment of missingness purely as a probability/confidence effect.

---

## 5. Correctness concerns actually found in the code (not hypothetical)

- **Block-at-most-once has a single point of failure** (§3, second finding): the kernel has no internal marker/state to prevent re-blocking; it depends entirely on the calling host setting `stop_hook_active: true` correctly. Empirically confirmed by direct repeated invocation.
- **Deliberation Lanes are not independent in the sense the docs imply.** `council.rs`'s five "lanes" are pure functions of integers the *caller* supplies on the command line (`--unverified-claims`, `--memory-conflicts`, etc.) — there is no mechanism inside the crate that derives these counts from independent sources. The `std::thread::scope` concurrency is real, but it parallelizes five arithmetic computations, not five independent judgments. The docs' framing ("AI-verifying-AI is weak... parallel challenge beats one model grading itself") is aspirationally correct but not demonstrated by what ships — nothing here stops one upstream process from computing all five numbers with the same blind spot.
- **`FocusCapsule.pinned` has no reader.** `fn pin()` sets a boolean; grep across the whole crate shows nothing else ever checks it. The "bounded working set that protects pinned items from eviction" implied by the name is not wired up — it's a struct field with a writer and no consumer.
- **The Amanah Ledger has no compaction/bounded layer.** `MemoryStore::open()` replays the entire `.jsonl` from `GENESIS` on every process start, unconditionally. For a long-lived agent this violates the spirit of our own A4's "loader cost stays `O(bounded)` forever" design goal — though, to the authors' credit, `docs/EVALUATION.md` already lists "ledger replay time" as a metric they intend to measure, meaning this is a known open question, not an unnoticed one.
- **CounterTrace's conflict detector is purely syntactic.** `normalize()` only lowercases and collapses whitespace (`claims.rs:42-47`) — `"us-east-1"` vs `"US East 1"` (same fact) would not be recognized as equivalent, and `"us-east-1"` vs `"us-east-1 (primary)"` (compatible, not contradictory) would be incorrectly flagged as a conflict. This is a reasonable, explicitly-scoped design choice for a deterministic, non-neural kernel, but it means "contradiction visibility" is guaranteed only for exact-value-after-normalization mismatches, a narrower guarantee than the docs' plain-language description might suggest to a reader who hasn't opened the file.
- **`hikmah validate` checks packaging, not behavior.** It confirms JSON parses, skill names are unique, and version numbers match across manifests — it does **not** check that a skill's prose is followed, that a hook actually fires, or that the two Stop-hook adapters are behaviorally consistent with each other. The asymmetry in §3 would pass `cargo run -p hikmah-kernel -- validate --root .` today (confirmed: we ran it, `"ok": true`), which is itself a small, tangible illustration of why the repo's own CI cannot catch the very gap this audit was asked to check.

## 6. What is well built (credit due)

The Rust kernel is small, readable, and does what it says: 4/4 tests pass, `clippy -D warnings` is clean, `fmt --check` is clean, and every behavioral claim we tried to falsify empirically (lexicographic hard-blocks, contradiction coexistence, hash-chain tamper detection, fail-open hook ladder, sensitive-persistence refusal, resonance-recall redundancy suppression) held up exactly as documented. The decision to keep the kernel free of any ML/tensor dependency is followed through consistently — there is no vestigial embedding code, no half-wired vector index, nothing that contradicts the "non-neural by construction" claim. The documentation is unusually candid about its own limits: `RESEARCH.md` explicitly separates "design lesson" from "claim of reproducing human cognition" for every cited neuroscience paper, `docs/EVIDENCE.md` grades its own cited statistics by verification status and updates them with dated corrections, and `README.md`'s safety section states outright that an append-only ledger is the wrong structure for deletion-sensitive data rather than glossing over it. That candor is exactly the discipline our own project's governing rule asks for, and it is applied here by an independent author who arrived at some of the same conclusions from a different direction.
