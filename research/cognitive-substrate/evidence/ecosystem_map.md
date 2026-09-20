# Ecosystem Map: Cognitive Substrate vs. the Mid-2026 Claude Code Stack

Cross-references the white paper's 5 structural faculties (memory, learning, imagination,
self-correction, impact-awareness) and 6 extension mechanisms (M1-M6: complexity routing,
assumption/uncertainty, task decomposition, goal-anchoring, anti-over-engineering, inline
verification) against the tools actually documented in the stack landscape file, mid-2026.
`existing_tooling` names are drawn from the stack landscape document only; where the separate
pain-points report names additional workaround tools or "Open gap" / "Build opportunity"
language, those are cited in the residual-gap column for context, not counted as stack-sourced
existing tooling. Purpose: don't build what already exists; be honest about what does.

**Summary: 11 items -- 2 solved by existing tooling, 6 partially
addressed (documented gap remains), 3 residual gap (essentially unaddressed).**

## Faculties (from the base white paper)

| Item | Status | Existing tooling (from stack file) | Residual gap | Our contribution |
|---|---|---|---|---|
| **Memory (across sessions)** | Partial | CLAUDE.md (always-on project context, survives /compact); Auto Memory (v2.1.59+, self-written notes in ~/.claude/projects/<project>/memory/); Mem0 (~58k stars, hosted MCP + lifecycle hooks); claude-mem (SQLite+FTS5/vector, Haiku summaries); Hindsight (94.6% LongMemEval, self-hostable); supermemory (cross-machine sync); Anthropic memory tool (API, client-side file ops) | Pain-points report names this directly: 'no standard, tool-agnostic, durable memory layer that reliably persists project knowledge, decisions, and corrections across sessions, tools, and teammates' (Open gap #2), with JetBrains finding 77% of devs still manually re-correct conventions every session. Auto Memory itself has a documented 'memory cliff' -- 200-line index cap + 5-files-per-turn retrieval with silent truncation. Existing backends store notes; none track whether a stored fact has since been invalidated by a correction. | Validity-anchored memory: stored facts carry a confirmed/discredited state updated by verified outcomes, not a static note-dump -- addresses the correction dimension the named tools don't. |
| **Learning (from outcomes)** | Residual gap | Auto Memory 'feedback' memory type (stores feedback notes); Superpowers subagent-driven-development two-stage review (spec compliance, then code quality); ccusage / usage trackers (cost signal only, not outcome learning) | No tool in the stack closes the loop from a task's actual outcome (did the fix hold, did the test stay green, was the PR reverted) back into changed future behavior. Auto Memory's feedback type is note storage, not an evaluated lesson; frozen weights mean nothing updates the model itself. Neither source names a shipped mechanism for this -- it is unaddressed rather than partially addressed. | Outcome-validated learning loop: capture a task's actual downstream result, verify it independently, and write back only confirmed lessons (not raw logs) into the memory store consulted on the next similar task. |
| **Imagination (simulate consequences before acting)** | Partial | Plan mode / built-in Plan subagent (read-only); Explore subagent; Superpowers brainstorm -> plan -> TDD -> subagent-dev -> review | These are textual/symbolic planning steps within the stack itself, not a simulation of an edit's actual downstream effects -- no hook, skill, or MCP server in the stack landscape traces a dependency graph before a change is made. (The pain-points report separately documents spec-driven-development tools such as Spec Kit, Kiro, and OpenSpec as workarounds, and names the same open gap: 'Cross-service/architectural-impact awareness at monorepo scale remains weak,' with the build opportunity framed as 'architecture-aware agents that reason over dependency graphs.') | A pre-action impact simulation step -- dependency-graph/call-graph traversal that predicts affected files/tests before code is written, feeding predicted blast radius into the plan rather than discovering it after the edit. |
| **Self-correction** | Partial | Stop hooks (e.g. npm test || exit 2, forces continued work); PreToolUse blocking hooks; Playwright's healer agent (auto-repairs failing tests); TDD RED-GREEN-REFACTOR (Superpowers); /security-review and pr-review-toolkit (5 parallel Sonnet review agents); Ralph Wiggum loop / /loop, /goal, /batch | These are retry/gate mechanisms, not diagnosis. The pain-points report documents the 'doom loop' by name -- an agent that 'makes a mistake, tries to fix it, makes it worse' and can even delete its own changes while declaring success -- and states plainly: 'Automatic doom-loop detection and root-cause reasoning (vs. symptom-patching) are largely unsolved,' naming the build opportunity as 'loop-breakers and budget circuit-breakers that detect thrashing, halt, and escalate to a human with a diagnosis.' | A root-cause-aware correction gate that distinguishes genuine progress from thrash (same failure signature repeating), halts and escalates with a diagnosis instead of blindly re-looping. |
| **Impact-awareness (what exists in the codebase / what an edit affects)** | Partial | filesystem and memory (knowledge graph) MCP servers (modelcontextprotocol/servers monorepo); Context7 (version-specific library docs via MCP); sequential-thinking MCP server; sandboxing's 'trust verification for new codebases/MCP servers' (native control) | These stack primitives expose retrieval (docs, a memory graph, filesystem access) that the model may or may not consult -- none is a deterministic, mandatory gate run before every edit, and none computes blast radius. (The pain-points report separately names full-repo indexers such as Sourcegraph Cody/Amp, Augment Code, Greptile, CodeAnt AI, and CodeRabbit as workarounds, but states directly: 'one change to a shared utility can break dozens of packages with no cross-package awareness' and 'Cross-service/architectural-impact awareness at monorepo scale remains weak.') | A MANDATORY pre-action impact gate -- a hook-enforced (not LLM-judged) dependency-graph query that runs before every edit is applied, not an optional retrieval step the model may or may not consult. |

## Mechanisms (this extension: M1-M6)

| Item | Status | Existing tooling (from stack file) | Residual gap | Our contribution |
|---|---|---|---|---|
| **M1 Complexity-aware routing** | Solved | Model tiering (Haiku/Sonnet/Opus, /model command); Per-agent model: field in .claude/agents/; LLM gateways: LiteLLM, Portkey, OpenRouter; Named orchestration pattern: 'orchestrator-classifies-then-routes to Haiku/Sonnet/Opus by complexity' | The routing decision is set at config time (a developer picks model: haiku for an agent) or by the gateway's own cost logic -- it is not a transparent, per-task, auditable classification the user can see and override before dispatch. | A transparent complexity classification surfaced to the user before dispatch, making the routing decision auditable rather than a silent config default. |
| **M2 Assumption / uncertainty** | Residual gap | Reasoning models acting as an internal review pass; Context7 (reduces API-hallucination via current docs, not the underlying issue); Spec-driven development (Spec Kit, Kiro, OpenSpec) as a workaround that forces the human to write the spec | Named directly and unsolved in the pain-points report: 'Models rarely signal uncertainty or say I can't do this' -- the report's own build opportunity is 'calibrated-confidence and known-unknowns tooling -- agents that flag low-confidence regions and ask clarifying questions instead of confabulating.' SDD only helps if the human already wrote a complete spec; it does not make the model self-flag what it doesn't know. | This is the paper's named root failure: an assumption/uncertainty gate that requires the model to enumerate its unstated assumptions and ask before proceeding when confidence is low, instead of depending on the user having pre-empted every ambiguity in a spec. |
| **M3 Task / session decomposition** | Solved | Subagents (isolated context windows, only final message returned); Agent Teams (experimental, shared task list, teammate-to-teammate messaging); git worktrees for parallel-agent isolation; Parallel fan-out orchestration pattern (60-80% wall-clock savings); Superpowers subagent-driven-development (fresh subagent per task) | Mature, well-tooled pattern. The remaining gap is small: deciding the decomposition boundary itself (what counts as independent vs. needs shared context) is still a manual/heuristic judgment call by the developer, not something any listed tool decides automatically. | Automatic decomposition-boundary detection -- deciding when to fork a subagent/session vs. keep work in one context, rather than leaving that call to developer heuristics. |
| **M4 Goal-anchoring** | Partial | CLAUDE.md (always-on context, re-read from disk, survives /compact); Spec-driven development (spec as source of truth); /goal command (v2.1.139+); Task lists in Agent Teams | These anchors are loaded once and are static. The report documents the anchor decaying over a session: 'circular reasoning at 20% [context usage], context compression wiping scrollback at 40%,' and Open gap #1 states plainly that 'specs drift out of sync with code (context drift)' with 'no mature, widely-adopted tooling [that] keeps specs, code, and tests continuously verified against each other.' | A continuous goal-drift check that periodically re-validates in-progress output against the original stated objective, rather than loading the goal once and trusting it stays in view. |
| **M5 Anti-over-engineering** | Residual gap | frontend-design skill's minimalism discipline ('remove one accessory') -- UI/design scope only; TDD RED-GREEN-REFACTOR (write only enough code to pass a test); pr-review-toolkit / CodeRabbit / Greptile review agents (not scoped to over-engineering specifically) | The frontend-design skill's discipline is explicitly UI-only; no general-purpose backend/architecture tool measures unnecessary abstraction, premature generalization, or scope creep against the stated task. GitClear's tracked defects (8x duplication, copy-paste) are the opposite failure mode (under-abstraction) -- over-engineering isn't named or tracked by any tool in either source. | A scope-minimality check that compares an implementation's footprint (files touched, abstractions introduced) against the stated task requirement and flags additions the task didn't ask for. |
| **M6 Inline verification** | Partial | Real-time thinking/tool-call streaming (Claude Code); Self-QA pattern (agent opens localhost and checks its own changes); PostToolUse hooks (auto-format/lint immediately after a write); Plan mode human-in-the-loop gating | Streaming and immediate post-edit hooks give passive visibility but do not require a human interpretive checkpoint DURING generation. The pain-points report's central statistic is the '48-point gap': 'Sonar's 2026 report: 96% of developers don't fully trust AI code is correct, yet only 48% always verify' -- verification is deferred to an end-of-task PR review (median review time up 441.5%), not performed inline. | A mandatory inline checkpoint that surfaces a human-checkable claim or diff at each meaningful generation step, shifting verification earlier instead of batching it into a single end-of-task review. |

## What NOT to build (already solved)

Two items need no new infrastructure. **M1 (complexity-aware routing)** is a mature, named
pattern in the 2026 stack: model tiering (Haiku/Sonnet/Opus via `/model`), per-agent `model:`
fields in `.claude/agents/`, and LLM gateways (LiteLLM, Portkey, OpenRouter) that already route
by cost/complexity, with "orchestrator-classifies-then-routes to Haiku/Sonnet/Opus by
complexity" documented as a standard orchestration pattern. **M3 (task/session decomposition)**
is equally mature: Subagents (isolated context, final-message-only return), the experimental
Agent Teams model, git worktrees for isolation, and Superpowers' subagent-driven-development
already give parallel fan-out with 60-80% wall-clock savings. Building a new decomposition or
routing *engine* would be reinventing a well-adopted primitive; the honest opportunity in both
cases is a thin transparency/audit layer on top (surfacing *why* a routing or fork decision was
made), not the mechanism itself.

Three faculties also have substantial existing tooling worth acknowledging even though a gap
remains: **memory** (CLAUDE.md, Auto Memory, Mem0, claude-mem, Hindsight, supermemory, the
Anthropic memory tool API), **imagination** (Plan mode, Explore subagent, Superpowers'
brainstorm-to-review pipeline), and **impact-awareness** (filesystem/memory-knowledge-graph and
Context7 MCP servers, sequential-thinking MCP, sandboxing's codebase trust verification). None
of these should be reinvented from scratch -- the substrate's job is to close the specific,
named gap each one leaves open (below), not to duplicate the retrieval/planning/indexing layer.

## Genuine whitespace

Three items are essentially unaddressed by any tool named in the stack landscape file, and each
is independently corroborated by the pain-points report's own "Open gap" / "Build opportunity"
language rather than asserted by us. **Learning from outcomes** has no counterpart at all --
Auto Memory's "feedback" type stores notes, not verified, evaluated lessons, and nothing in the
stack closes the loop from an actual task outcome back into changed future behavior. **M2
(assumption/uncertainty)** is named explicitly as unsolved: models "rarely signal uncertainty or
say I can't do this," and the report's own build opportunity calls for "calibrated-confidence and
known-unknowns tooling" -- this is also the paper's named ROOT deficit, so it is the highest-
priority build target. **M5 (anti-over-engineering)** has a UI-only analogue (the frontend-design
skill's minimalism discipline) but no general-purpose backend equivalent; scope creep and
premature abstraction are not tracked by any named quality gate.

Two further items are partial-with-a-documented-gap rather than untouched: **self-correction**
has retry/gate mechanisms in the stack (Stop hooks, the Ralph Wiggum loop, Playwright's healer,
pr-review-toolkit) but the pain-points report names "doom-loop" thrashing and calls automatic
root-cause detection "largely unsolved"; **M6 (inline verification)** has passive
streaming/self-QA but the defining 2026 statistic -- 96% of developers don't fully trust AI code
yet only 48% always verify it -- shows verification is still batched into an end-of-task review,
not performed while code is written. **M4 (goal-anchoring)** and **impact-awareness** round out
the partial column: both have static, one-time anchors (CLAUDE.md, `/goal`, MCP filesystem/memory
retrieval) but no tooling in the stack that continuously re-checks alignment or mandatorily gates
an edit against blast radius as the session progresses.

## Sources

- Stack landscape: `source_stack_landscape.md` (mid-2026 Claude Code / agent tooling survey) -- sole source for `existing_tooling`.
- Pain-points report: `source_painpoints_report.md` (full-SDLC field report and build-opportunity map, mid-2026) -- source for residual-gap quotes and named workaround tools cited for context only.
