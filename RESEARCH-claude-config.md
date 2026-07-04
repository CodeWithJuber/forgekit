# Deep research — best Claude Code configs vs. yours (2026)

Multi-source, cross-checked. Verdict up front: **your config already matches or
exceeds documented community best practice on ~90% of dimensions.** Two genuine
gaps remain. Unbiased finding: the quality move now is *consolidation, not adding
more* — the same sources warn that big plugin/skill piles hurt.

## What the best configs do — and whether you have it

| Best practice (consensus) | Evidence | You? |
|---|---|---|
| CLAUDE.md ≤ ~150–200 instructions; strip to what code can't infer | Models reliably follow ~150–200; one test cut a 3,847→312-tok CLAUDE.md, 91.9% smaller, no quality loss | ✅ global CLAUDE.md ~39 lines |
| AGENTS.md as single cross-tool source; CLAUDE.md thin/symlinked | AGENTS.md is the late-2025 cross-tool standard | ✅ ~/.ai/AGENTS.md imported + per-repo AGENTS.md |
| Hooks for must-happen; skills on-demand; subagents to isolate context; MCP for data | "Skill=knows how; Hook=happens regardless; Subagent=delegate; MCP=data" | ✅ all four, used correctly |
| Skills < ~2,000 tokens each | Anthropic skill-authoring guidance | ✅ yours are concise |
| Prompt caching (~90% savings) + model routing + compaction | cache reads ~1/10 input price; routing+compaction cut spend 40–72% | ✅ sonnet default, cache-% statusline, haiku scout |
| Prune ruthlessly; value ≠ longest CLAUDE.md or most plugins | "teams getting value treat CLAUDE.md as precious, ruthlessly pruned" | ✅ you pruned taste skills + allow-list |
| Memory: append learnings + 3-layer (index/topics/transcripts) | learnings.md append; Memory.md + topic files + transcripts | ✅ remember + episodic-memory + learned/ + session-learning hook |

You're ahead of the average on memory and minimalism (Ponytail + self-improve).

## The 2 real gaps (concrete, worth doing)

**1. Always-on token budget — the biggest unmeasured cost lever.** Every session
starts at **20,000–30,000 tokens before you type** (system prompt + CLAUDE.md +
memory + MCP tool schemas + skill names), and you now run **21 enabled plugins**,
11 skills, Ponytail (~983 tok always-on), Graphify, and hooks on top. None of that
is audited. Action: `claude plugin details <name>` reports each plugin's projected
token cost — audit the 21, disable more low-value ones. This is the same lever that
took real teams from $2,400→$680/mo (~72%). *(High confidence — docs + multiple
case studies.)*

**2. Your learner only appends — it never consolidates.** Best-in-class memory
("dreaming"/autoDream) adds conflict-resolution, **pruning, and dedupe** between
sessions. Your session-learning hook + `remember` only *append* to
`~/.claude/skills/learned/`, so lessons will accumulate, duplicate, and eventually
contradict — bloating context. Action: a weekly consolidation pass that dedupes and
prunes learned lessons + the MEMORY index. *(Medium confidence — "dreaming" is
partly emerging/vendor-framed, but the append-only bloat risk is concrete.)*

## Minor / optional
- Add a tiny guard that warns if any CLAUDE.md/AGENTS.md exceeds ~200 lines.
- Broaden cheap-model routing beyond the `scout` subagent (more haiku for triage).

## What NOT to do (unbiased)
There are ~425 plugins / 2,810 skills out there. The evidence says adding more is
usually negative-value — context bloat with no proportional gain. Your instinct to
stop adding is correct. Skip the marketplaces.

## Confidence & method
5 search angles, ~15 sources, claims cross-checked. High confidence: CLAUDE.md
sizing, caching economics, the four-layer model, prune-don't-add. Lower confidence
(emerging/vendor-framed): "dreaming" self-improvement specifics — treated as
direction, not proven mechanism.

Sources: [Anthropic best-practices](https://code.claude.com/docs/en/best-practices) · [Manage costs](https://code.claude.com/docs/en/costs) · [CLAUDE.md rules (Kirill Markin)](https://kirill-markin.com/articles/claude-code-rules-for-ai/) · [CLAUDE.md best practices (Techsy)](https://techsy.io/en/blog/claude-md-best-practices) · [Skills vs Hooks vs Subagents vs MCP (Totalum)](https://www.totalum.app/blog/claude-code-skills-totalum) · [Full-stack explainer (alexop.dev)](https://alexop.dev/posts/understanding-claude-code-full-stack/) · [Token optimization (BuildToLaunch)](https://buildtolaunch.substack.com/p/claude-code-token-optimization) · [Cut costs 70% (Branch8)](https://branch8.com/posts/claude-code-token-limits-cost-optimization-apac-teams) · [Persistent memory (MindStudio)](https://www.mindstudio.ai/blog/persistent-memory-system-claude-code-agents) · [Claude dreaming (MindStudio)](https://www.mindstudio.ai/blog/claude-dreaming-feature-self-improving-agent-memory) · [Memory systems guide](https://cc.bruniaux.com/memory-systems/)
