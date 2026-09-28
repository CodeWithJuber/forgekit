# Forgekit Product Strategy — September 2026

> From beta to production: what we are, what hurts out there, and what to build next.
> Companion to [ROADMAP.md](./ROADMAP.md) (what ships, in what order) and
> [research/cognitive-substrate/sources/painpoints_report.md](../research/cognitive-substrate/sources/painpoints_report.md)
> (the mid-2026 field report). This document is the *why*.

Status: **proposal** — open a Discussion to argue with it.

## 1. Where we stand (v1.7.4)

An honest inventory, from a full review of the repo (799 files, 136 test files,
Node 20/22 + Windows/Git-Bash CI matrix, CodeQL, Scorecard, semver releases):

**Strengths**
- **Zero runtime dependencies.** Only devDeps (biome, types, typescript). A statement in today's npm ecosystem.
- **CI rigor unusual for a solo project.** Test matrix, Windows coverage, docs-drift checks, research recomputation contracts.
- **Honest documentation.** The README deflates its own claims ("proof-carrying memory is a name, not a formal proof"; impact analysis is heuristic; guards are not a sandbox). The research folder goes further — it *refutes its own prototypes* (impact-oracle recall 1.00→0.022; routing *increased* cost by 20.2%). This intellectual honesty is the project's biggest trust asset. Market it, don't hide it.
- **Fail-closed guardrails.** When no verdict is reachable, the tool call is blocked, not let through.
- **Release discipline.** Semver, CHANGELOG, npm provenance, docs (ARCHITECTURE, ADRs, SECURITY, CONTRIBUTING, CITATION.cff).

**Gaps**
- **Discoverability: 2 stars, 0 forks.** The code is ready; distribution is not. The project is moving from "build" phase to "distribution" phase.
- **README is ~20 sections.** The 60-second quickstart is good; the depth belongs on the public site.
- **Release cadence is very fast** (v1.7.0→v1.7.4 in ~2 days). Batch small fixes; frequent majors/minors read as instability from outside.
- **10-tool support is uneven by the project's own admission** — Claude Code is deeply exercised, the other nine get native config. The top-level positioning should carry per-tool maturity, not just the count.

## 2. What makes forgekit unique

Four things no competitor combines (Mem0/Letta/Zep do memory-as-SaaS; vendor plugins are tool-specific):

1. **One canonical config → native config for 10 tools.** A *compiler* for agent configuration (Claude Code, Codex, Cursor, Gemini, Aider, Copilot, Windsurf, Zed, Continue, OpenClaw + MCP for Roo/VS Code). Nobody else ships the cross-tool emission layer.
2. **Skeptical memory.** Everyone builds "remember everything"; forgekit builds memory that only trusts evidence — claims carry evidence references, confidence moves only on independent oracles (tests, CI, a human), wrong lessons decay. The philosophy differs, not just the feature.
3. **Deterministic substrate, zero LLM calls in the core loop.** Impact, verify, guards run as code: predictable, cheap, offline-capable.
4. **Git-native team memory.** No SaaS, no lock-in — teammates merge knowledge over plain git. The privacy story *is* the moat for privacy-conscious teams.

The durable moat: if forgekit's canonical files become the standard teams author (the way AGENTS.md did), switching costs compound in our favor. Emission can be copied; a standard is harder.

Proposed positioning line: *"Forgekit: one project config, native setup for every AI coding tool — with memory that only trusts evidence."*

## 3. The pain landscape, September 2026

Fresh field research (late Sept 2026 — Reddit, X/Threads, HN, GitHub issues), ranked by frequency × severity. Full findings were gathered 2026-09-27/28; key sources linked.

**Billing & runaway cost**
1. **Billing opacity is the #1 churn driver.** Copilot free-plan user billed $548.99; $750–$3,000/month reports; no spending caps anywhere. Cursor credited a $1,799 overage then re-billed the same usage. As of Sept 24, Anthropic bills even *refused* API requests. Users now hand-roll trackers (`claudebill`); one dashboard showed $10,227.85 over 2,503 sessions. No vendor shipped caps in September.
2. **Doom loops are now billing events.** $6,000 overnight bill (cache-TTL regression, claude-code#46829); 14,000 redundant tool calls = $437; kimi-cli infinite file-read loop (#640, open). New failure category: **auto-compaction loops**.

**Trust & verification**
3. **Silent model regressions.** "Opus 5 is unreadable" — 648 points, 326 comments; an Anthropic researcher publicly conceded 5.5 is "way, way, way better" (898-point thread). Visible Claude→Codex migration. Nobody sells per-model degradation telemetry — **complete whitespace**.
4. **"Almost right, but not quite" remains the most expensive wrong.** 66% of devs (SO 2025); it survives casual review. JetBrains 2026: 63% spend more time debugging AI code than writing it.
5. **Guardrail bypasses are now demonstrated, not theoretical.** Black Hat Aug 2026: Claude Code, Gemini CLI, Codex all broken at default config (2 CVEs). Counter-pressure: permission fatigue — users approved 97% of prompts; a 40k-run study showed 1-in-3 malicious requests waved through.

**Memory & multi-agent**
6. **Memory loss across sessions/tools.** "/compact permanently drops detail"; every model re-suggests previously rejected decisions. Best framing found: *"a brilliant new hire, every single day, who read none of yesterday's notes."* Note: Tencent open-sourced a team memory hub (Aug 2026) — competition has arrived; memory *quality* is now the moat.
7. **Multi-agent collisions are measured science.** Anthropic Frontier Red Team (Aug): agents sabotaged each other down to kill-loop scripts; reproduction: 66.7% of edits vanished with 3 uncoordinated writers.
8. **MCP supply chain went official.** Google GTIG (Sept 8): trojanized MCP servers, 23,800+ harvested secrets. Enterprise blocker now.

**UX & hallucinations**
9. **Approval fatigue** (97% blind-approve) and **diff-review collapse** (42 files changed, user reviewed 6 — "which six?"). One skim-merge loosened a CI workflow's path filter: green CI, wrong permissions, caught in prod 2 days later.
10. **Compact rot** (201-pt thread: compact took a user from 15% to 90% usage) and **undo blind spots** (`/rewind` can't see Bash/subagent edits — 3 third-party undo tools exist for this gap).
11. **Hallucination taxonomy, all with real incidents:** hallucinated APIs (nonexistent SQLAlchemy method, runtime crash days later); phantom packages — *slopsquatting* (researchers registered invented names, got Fortune-500 callbacks within an hour; one carried live malware); fabricated tool output (narrated a 158MB build + commit hash; no build ever ran); sycophancy; false confidence ("Gaslightus-4.7").

**Structural shifts vs June 2026:** billing moved from *price* to *opacity/uncapped risk*; Kimi went from rising star to trust crisis (data-routing allegations + regulatory probe — launch timing there is sensitive); guardrail bypasses went theory→demonstrated; multi-agent collision went anecdote→measured; config fragmentation is *decreasing* (native AGENTS.md support in Claude Code, Linux Foundation spec) — emission is now a distribution play more than a fragmentation fix.

Richest listening posts: r/ClaudeCode, r/vibecoding, GitHub Community Discussions, Threads/X AI-dev accounts, HN. Meta-source: vibewatch daily digests.

## 4. Beta → production: graduation plan

Don't declare "v2.0 prod" one day. Graduate subsystem by subsystem:

- **Graduate the core now:** `init`, `sync`, `verify`, `ledger`, guards → mark stable. They are tested and in daily use.
- **Keep `impact` honestly advisory** — heuristic forever; roadmap item is confidence scores, not soundness.
- **Freeze CLI output contracts.** Production means scripts depend on our JSON. Version output schemas; contract-test them in CI; breaking change = major (already our semver practice).
- **Measured evidence.** Ship numbers, not adjectives: "X repos, Y weeks dogfooding, Z% fewer broken merges." Keep the self-refuting research public — it *is* the marketing.
- **Bulletproof install.** `npm i -g` on a fresh machine, Windows Git Bash, clean-container smoke test in CI. First impression is install; failure there loses the user.
- **Bin name.** `forge` is generic — check collisions/typosquat risk; claim unscoped `forgekit` on npm if available.
- **Launch assets.** 30-second demo GIF (substrate → impact → verify), one example repo, Show HN post.
- **Trust infra.** SECURITY.md gains a threat model: what is protected, what is *not*. Selling guardrails makes "what we don't stop" a production requirement.
- **Community on-ramp.** Enable Discussions, keep 2–3 "good first issue"s, publish this strategy for comment.

## 5. Multi-agent shared learning ("team brain") roadmap

The direction with the most leverage: from config emitter to the team's shared brain.

1. **Kimi emitter first.** Cheapest win, new user segment. Then a **generic custom-emitter template** so the community adds tools without touching core.
2. **Concurrent-write correctness.** Git merge works when everyone shares a branch; it breaks across worktrees, branches, and cloud sandboxes (Codex Cloud can't push). Move memory toward an **append-only event log** (the ledger is already pointed that way) with deterministic/CRDT merge for lesson claims — "Codex learned X, Claude learned not-X" must adjudicate automatically. (`adjudicate.js`/`consensus.js` exist — make them cross-agent.)
3. **Correction mining — the self-improvement loop.** Today confidence moves on accept/revert, but the *content* of the correction is lost. Mine revert diffs into lessons: "agent did X, human corrected to Y." Wire into `learn_consolidate`. Add a **contradiction detector**: conflicting lessons get flagged and resolved, never silently co-exist.
4. **Memory audit trail.** Record which lesson influenced which decision and the outcome. Bad lessons get *traced and purged* ("this lesson caused 3 bad merges"), not just decayed. Accountability is what teams will pay for.
5. **Cloud: local-first stays, relay is optional.** The no-SaaS positioning is the moat — don't break it. Ship an **optional, self-hostable relay** (`forge relay`, one command): E2E-encrypted blob sync, server can't read content. Content-addressed memory makes CAS-based sync a natural fit. Hosted relay can be paid later; core stays MIT.
6. **Presence before locks.** `.forge/presence/` broadcast of "who is touching what"; surfaced in `forge status`. Awareness prevents 90% of collisions; full distributed locks come later if ever.
7. **Dashboard as learning center.** `forge dash` already exists — grow it into the team view: lesson provenance (who taught it: human/agent/which tool), confidence graphs, open contradictions.

Priority: Kimi emitter → correction mining → CRDT merge → relay → dashboard.

## 6. JEV adapter roadmap

`src/jev.js`: TypeSafe System One client (~160 lines), typed questions (choice/score/noul), ~150ms, opt-in (`TYPESAFE_API_KEY` + `FORGE_LLM=1`), fail-safe null (byte-identical fallback), zero-dep raw-HTTPS transport. Today: 2 call sites (`route.js` complexity band, `preflight.js` assumption gate). Three new adapters, all off the hot hook path, all propose-only, all behind the existing opt-in gate:

1. **Verify-failure triage (build first, effort S).** `classifySuiteFailure` calls every non-zero exit FAIL — flakes mint false lessons and feed doom-loop counters. Ask Jev: *genuine defect or environment flake?* ≥0.7 → FAIL; ≤0.3 → FLAKE (retry advisory, no lesson, no doom-loop feed); between → today's behavior. Jev off → byte-identical.
2. **Lesson contradiction arbitration (effort M).** Conflicting lesson pairs today rot in a "manual review" list. Keep the deterministic MinHash pre-filter; Jev arbitrates only its output. At high conflict, quarantine the lower-confidence lesson through the existing lifecycle (no new states). No mutation without two judges (token guard AND Jev).
3. **Doom-loop nuance triage (effort S–M).** `diagnose.js` escalates mechanically at k=3 repeats. Before declaring thrash, ask Jev: escalate / retry-on-another-axis / needs-info. Rule: Jev may *soften* an escalation (with logged reason), never suppress it — escalation stays the safe default.

**Risks, stated plainly:** vendor dependency cuts against the zero-dep ethos (mitigation: ~50-line transport, portable question assets; outage degrades to today's behavior, never errors); 150–300ms is user-visible on hot paths (all three adapters are off-hot-path by design); cost is unstated in the API docs (wire `usage` into `cost_report.js` before any default-on discussion); memory-content adapters need a privacy callout in docs (`TYPESAFE_BASE_URL` self-host override is the real answer). All adapters stay opt-in until measured evidence exists — and Jev proposes, deterministic rules dispose.

## 7. Prioritized build list

1. **Cost governance:** per-task budgets, spend alerts, circuit breaker. (Pain #1 — the biggest churn driver; nobody ships it because it's against vendors' incentives.)
2. **`forge doctor --adversarial`:** fuzz our own hooks (sed/heredoc rerouting, malformed hook JSON, the `--dangerously-skip-permissions` hole). Guardrail claims without self-test are hollow.
3. **Multi-agent collision primitives:** presence + lane-ownership conventions. (Pain #7.)
4. **Loop-breaker with budget axis:** diagnose.js k-rule + JEV nuance triage + cost circuit breaker ("this run burned $X, stop").
5. **Model-regression monitor:** per-model task-success telemetry on *your* workload, pinned-model CI, degradation alerts. Complete whitespace (pain #3).
6. **Validity-anchored memory:** invalidation-by-correction + contradiction arbitration (JEV adapter #2). Moat defense (pain #6).
7. **Kimi emitter + community emitter template.** Distribution (pains #8/#9).

## 8. Explicit non-goals

- **Never sell the router as "cost saving."** Our own research refutes it (−20.2%). The router is a *transparency* layer. Contradicting our own refutation would burn our best credibility asset.
- **No SaaS lock-in.** Cloud is an optional E2E-encrypted relay, not a platform pivot.
- **No hot-path LLM dependence.** The deterministic core loop stays model-free; Jev and text-LLM proposers stay opt-in cascades.

## Appendix: sources

- Repo review: full tree @ v1.7.4 (2026-09-27) — README, package.json, `src/`, `test/` (136 files), `.github/workflows/`, releases.
- `research/cognitive-substrate/sources/painpoints_report.md` (mid-2026 field report) and `stack_landscape.md`.
- Fresh pain-point research, 2026-09-27/28: Reddit (r/ClaudeCode, r/vibecoding, r/cursor), X/Threads AI-dev accounts, Hacker News, GitHub issues (anthropics/claude-code, openai/codex, MoonshotAI/kimi-cli, github/copilot-cli), GitHub Community Discussions, vibewatch digests, Google GTIG Sept 2026 report.
- JEV: `src/jev.js` (builds on `src/adjudicate.js`'s `llmEnabled`) + call sites in `src/route.js`, `src/preflight.js`.
