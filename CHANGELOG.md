# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Opt-in enforcing gate (`FORGE_ENFORCE=1`).** The substrate's assumption gate can now be a real
  *halt* (the paper's Eq 5 / M2 "block on insufficient input"), not just advice. On the Claude Code
  ambient path it blocks a prompt with **no concrete anchor at all** ("fix it", "make it better") —
  or an action into a very large predicted blast radius — and returns the clarifying questions.
  Deliberately low-false-positive: a specified task is never blocked, and it's **off by default**
  (`enforceDecision()` in `src/substrate.js`).
- **M5 anti-over-engineering is now measured, not guessed (`forge lean`).** The paper's
  `φ(y) − φ*(x)` check replaces the old three-keyword stub: `src/lean.js` reads the working diff
  and flags the footprint beyond what the task asked for — new abstractions the task never named,
  a large diff for a short ask, files touched beyond the stated scope. Folded into
  `forge substrate` (a `minimality.footprint` field) and available standalone as `forge lean "<task>"`.
- **Doom-loop breaker (self-correction).** Complements the shell guard (which catches the *same
  action* repeated) by catching the subtler loop the paper names — *different edits that keep
  producing the same test failure*. `cortex_hook` now captures a normalized signature of failing
  test output; `detectDoomLoop` fires when one signature recurs past a threshold, and the
  pre-edit hook surfaces a "stop and find the root cause" advisory with the diagnosis.
- **Consequence simulation — failing-tests class (Eq 4).** `forge substrate` now predicts the
  tests likely to break *before* an edit (`impact.predictedTests`): the impacted files that are
  tests, plus each impacted source file's sibling test — surfaced so you run the narrowest
  affected tests first, not after the fact.

### Changed

- **`forge sync` now adopts an existing project `CLAUDE.md` instead of skipping it.** Previously a
  repo with its own `CLAUDE.md` was left untouched — which meant Forge's shared rules never
  reached Claude Code there. Sync now prepends the one-line `@AGENTS.md` import (idempotent,
  every original line preserved) and reports `adopted`. `AGENTS.md` keeps its back-up-then-write
  behaviour; your skills and other tool files are untouched.

### Fixed

- **The Cortex capture/learn loop now works in the dotfile install too.** `global/settings.template.json`
  wired only `cortex.sh preflight` (1 of 6 modes), so dotfile users got the substrate advisory but
  **never captured events or distilled lessons** — the learning loop was dead for them while plugin
  users had it. The template now wires all six modes (`session-start`, `prompt`, `preflight`,
  `pre-edit`, `capture`, `stop`), matching `hooks/hooks.json`.
- **`forge verify` can't hang.** `runTests` now bounds the test run with a timeout
  (`FORGE_VERIFY_TIMEOUT_MS`, default 10 min); a timeout is reported honestly as "did not complete",
  never as a pass.
- **Secret-refusal no longer guts auth-related work.** `SECRET_RE` matched the bare words
  `secret`/`password`/`api key`, so any task or lesson merely mentioning them was silently
  refused — disabling the LLM proposer (`adjudicate`) and blocking memory persistence
  (`recall`/`lessons`) for exactly the high-risk code you most want help on. The word arm now
  requires a value-shaped assignment (`password = "…"`, `SECRET_KEY: …`); credential *formats*
  (`sk-…`, `ghp_…`, JWTs, …) are still refused.
- **One malformed file no longer takes down memory.** `lessons_store.load`/`readEpisodes` and
  `cortex_hook.readSession` now skip a corrupt lesson file / JSONL line instead of throwing
  (which previously broke retrieval, routing, and the pre-edit advisory everywhere `load` is used).
- **`recordMistake` reports `refused` (not `created`) when a save is rejected**, so the Stop hook
  never tries to distill a phantom lesson; `applyDistillation`/`recordContradiction` surface the
  real write result too.
- **Atlas emits `inherits` edges** (`class X extends Y`; Python `class X(Base)`) — the weight was
  defined but never produced, so base-class changes were invisible to blast-radius.
- **Atlas is incremental + staleness-aware.** `build()` reuses per-file extraction by content
  hash (a sidecar cache) instead of re-parsing the whole repo; `isStale()` lets `verify` rebuild
  when the cached graph is out of date (post-edit hallucination detection was running on a stale
  atlas). A capped graph now degrades to "uncertain" rather than raising false "unknown symbol".
- **Performance:** `resolveEdges` is O(E) (was O(E·N) — a full node scan per edge); `impact()`
  reuses one memoized reverse-adjacency map across the up-to-8 calls per `substrate` run.
- **`substrate` no longer recomputes preflight twice** (or fires a redundant assumption model
  call): the gap is computed once and threaded into routing.

### Added

- **Opt-in LLM adjudication for the substrate (`FORGE_LLM=1`)** — one shared, fail-safe `claude -p` proposer (`src/adjudicate.js`) wired thinly into the assumption gate (M2), model routing (M1), impact/blast-radius, and goal-drift (M4). The model only *proposes*; every proposal is verified against the deterministic rubric, the code graph, or a grep before it can move a verdict. Off by default — behaviour is unchanged unless enabled — never blocks, and the ambient Claude Code hook stays deterministic unless `FORGE_LLM_AMBIENT=1`. `forge substrate --json` carries an `llm.provenance` map per faculty for auditability.
- **Bidirectional verified reconcile (default on when `FORGE_LLM=1`; `llm.bidirectional` in `source/substrate.json` to disable).** A verified reading may now *reduce* caution as well as add it — clear a false "ASK FIRST" (`llm-cleared`) and route a task *down* a tier (`llm-lowered`) — but only within `band` and never past the hard floors: the gate can't clear a task with no concrete anchor or one naming symbols/files the repo lacks, and routing can't drop below a strong-signal (algorithmic/architectural) floor. Set `llm.bidirectional: false` for the conservative tighten-/raise-only mode. Impact edges stay graph-+-grep-verified; goal-drift stays off→on with a goal-referencing reason.
- **Explicit memory `val` term** — lesson retrieval now decomposes into the white paper's `relevance × freshness × validity × scope`, with `validity()` (a ground-truth Beta posterior over confirmed vs. contradicted outcomes) exported and ranked so outcome-confirmed lessons outrank merely-recent ones.

### Changed

- **Unified the model-call path** — the Cortex distiller now shares the `adjudicate` runner instead of its own `claude` shell-out.

## [0.4.0] - 2026-07-06

### Added

- **Forge Cognitive Substrate** — one pre-action command (`forge substrate`) plus an MCP surface (`substrate_check`, `predict_impact`, `assumption_gate`, `route_task`, `scope_files`): assumption gate, transparent model routing, impact/blast-radius, scope decomposition, Cortex lessons, minimality, and a verification checklist.
- **M4 goal-anchoring (`forge anchor`)** — a deterministic goal-drift check that flags changed files off the stated goal. All 11 white-paper capabilities now ship a real mechanism.
- **Atlas v2 graph** — dependency nodes/edges + reverse-dependency impact traversal (the symbol-query API is preserved).
- **`docs/GUIDE.md`** (the complete command guide) and **`docs/RELEASING.md`** (release runbook).
- **Repo automation** — `repo-settings.yml` (About/topics/Discussions as code) and `labels.yml` (label sync) workflows; a Codex plugin manifest and `cognitive-substrate` skill; the paper bundle under `docs/cognitive-substrate/`.

### Changed

- **Publish to public npm.** `@codewithjuber/forgekit` now publishes to npmjs with provenance, so `npm install -g @codewithjuber/forgekit` needs no token (replacing the GitHub Packages route, which required auth even for public installs). The release workflow was fixed to trigger on a tag, publish, and cut a GitHub Release with generated notes.
- **Substrate auto-runs in Claude Code** via a `UserPromptSubmit` hook — it surfaces only when something needs attention and never blocks — and `forge init` emits a "run substrate before risky work" rule into every other tool's config.
- **Docs overhaul** — README rewritten (problem → solution → how, npm-first, SEO-friendly); the install, honest-limits, frozen-model, and substrate blocks are single-sourced instead of copied across files; the supported-tool list is reconciled everywhere.

### Fixed

- **Security (research prototype):** removed the pickle-based cache in `impact_oracle/world_model.py` — an insecure-deserialization (RCE) vector on a caller-supplied `cache_dir`. Now JSON node-link only, with `cache_dir` contained inside `root`.
- **Smaller npm package** — stopped publishing the ~2 MB paper bundle and the redundant `*_src.zip` (source lives unzipped under `research/`).
- **Perf** — `substrateCheck` no longer recomputes the assumption assessment.

## [0.3.1] - 2026-07-05

### Changed

- **Publish to GitHub Packages** instead of npmjs. Package renamed to the scoped
  `@codewithjuber/forgekit`; `publishConfig.registry` → `https://npm.pkg.github.com`. The
  release workflow now authenticates with the built-in `GITHUB_TOKEN` (`packages: write`) — no
  external `NPM_TOKEN` secret. A committed `.npmrc` maps the scope to the registry and sets
  `min-release-age=7` (supply-chain cooldown). Note: GitHub Packages requires consumers to
  authenticate even for public installs, so the `bash install.sh` clone path stays the
  friction-free primary channel.

## [0.3.0] - 2026-07-05

### Added

- **Forge Preflight** — a deterministic, math-first layer that runs BEFORE tokens are spent,
  on the premise that an LLM is a fixed-capacity stochastic predictor: size the task to the
  model, fill the context, detect assumptions. All advisory, never blocks.
  - **Assumption detector** (`forge preflight`, UserPromptSubmit hook): scans a task for code
    identifiers/files the repo doesn't define — what the model would otherwise ASSUME — and
    surfaces the known-unknowns so it asks instead of confabulating. The research whitespace.
  - **Complexity routing** (`forge route`): recommends the cheapest CAPABLE model
    (Haiku → Sonnet → Opus → Fable) from code-task signals (files, fan-out, churn, past-mistake
    density, ambiguity). `forge route gateway` emits a LiteLLM config for real auto-routing.
  - **Decomposition** (`forge scope`): a zero-dep import graph → connected components →
    independent clusters (run as separate sessions) + the coupled files you didn't name.
  - **Design-quality**: emitted AI-UX rules (anti-slop, WCAG, functional empty states, specific
    errors, confidence/transparency, pattern selection) + `forge uicheck` (exact WCAG contrast
    math) + a calibrated frontend-verifier that ASSERTS only the deterministic and keeps
    hierarchy/taste ADVISORY (the fix for hallucinated UI audits).
  - Cross-tool via `preflight_check` / `route_task` / `scope_files` MCP tools.

## [0.2.0] - 2026-07-05

### Added

- **Forge Cortex** — self-correcting project memory. Detects a genuine recurring mistake
  on this repo (test-fail→fix, revert, symbol thrash, explicit human undo), distills a
  structured lesson, and re-confirms it against independent outcomes — with an
  anti-self-reinforcement lifecycle (`Beta` confidence + decay; injection never confirms;
  a green build always wins) so a wrong lesson decays out instead of ossifying.
  `forge cortex`, `forge cortex why <symbol>`.
- Ambient hooks (fail-safe, never block): capture signals during a session, distill at
  `Stop`, inject learned lessons at `SessionStart`, and a `PreToolUse` advisory before a
  risky edit.
- Local error predictor (heuristic + a tiny logistic model) gated by an AUC-PR kill-switch
  — it only ships if it measurably beats the heuristic; otherwise it falls back or disables.
- Cross-tool: lessons inlined into `AGENTS.md` + a zero-dependency MCP server
  (`forge cortex-mcp`, registered in `source/mcp.json`).
- Optional LLM lesson distiller (`ENABLE_CORTEX_DISTILL=1`) — replaces the deterministic
  template with a real distilled lesson via `claude -p`.
- `forge doctor` reports Cortex lesson state; `forge catalog` lists Cortex.

## [0.1.0] - 2026-07-05

### Added

- Cross-tool config emitter (`forge sync`) — one source → each tool's native format; three
  install channels (Claude plugin + marketplace, installer, npm); `forge doctor`; code-graph
  (`atlas`); `lean` discipline; guard/skill/crew layers.
- Verification layer: `forge verify` (tests + hallucinated-symbol catch + provenance),
  doom-loop breaker guard, bias-safe `independent-reviewer` agent.
- Security gate: `forge scan` (skill-gate), `secret-redact` guard, structured
  `permissionDecision` in `protect-paths`, `forge harden` (gitleaks + sandbox).
- Cross-tool MCP emit; portable memory (`forge brain` / `forge remember`); design-taste
  menu (`forge taste`); `forge spec` spec-lock + OpenSpec wiring; MCP ~6-server hygiene
  check; coverage + type-checking (`tsc --checkJs`); 2026 production-standard rules;
  OWASP-LLM / NIST SSDF / SLSA control mapping.

[Unreleased]: https://github.com/CodeWithJuber/forgekit/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CodeWithJuber/forgekit/releases/tag/v0.1.0
