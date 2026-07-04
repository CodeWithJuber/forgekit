---
name: dev-radar
description: Pull current, real-world software-dev signal on demand from GitHub trending, Reddit, research papers, and blogs — filtered to the user's stack, hype-filtered, with verified sources. Use when the user asks "what's new/trending", "latest in <tech>", "should I adopt X", or wants a dev digest. Coding topics only.
disable-model-invocation: true
---

# Dev radar

On-demand scan of what's actually happening in software dev right now — not
training-data recall. Signal over noise, coding topics only.

## Sources (fetch live each run)

- **GitHub trending** — [https://github.com/trending?since=daily](https://github.com/trending?since=daily) | weekly | monthly
(add `&spoken_language_code=` / language filters). Best for real traction.
Cross-check a repo's health before recommending (last commit, releases, issues,
license) — trending ≠ maintained.
- **Reddit** (via WebSearch / old.reddit JSON) — r/programming, r/webdev,
r/ExperiencedDevs, r/nextjs, r/node, r/LocalLLaMA, r/MachineLearning. Read the
top comments, not just the headline — Reddit's value is the critique.
- **Papers** — arXiv (cs.SE, cs.AI), Hugging Face papers (HF MCP), Context7 for
library docs. Use for AI/ML and algorithmic topics.
- **Blogs** — WebSearch for Medium/eng-blog posts; treat as opinion, verify claims.



## Method

1. Scope to the user's stack unless they widen it: Next.js/React, Node, Postgres +
  pgvector, TypeScript, Python, LLM/agent tooling. Ignore unrelated trends.
2. Gather from 2-3 sources in parallel; dedupe.
3. **Hype filter** — drop "X is dead" / "just switch to Y" posts unless there's
  real evidence (adoption, benchmarks, maintainer signal). Note the counter-view.
4. For anything actionable, hand it to `tech-selector` before recommending adoption.



## Output (dated)

A short digest: **What's moving** (3-6 items: repo/paper/thread · one line · link ·
why it matters to your stack) → **Worth a real look** (1-2, with the trade-off) →
**Skip / hype** (things being overhyped, and why). Every claim links its source and
states the date. End with: which items (if any) warrant a `tech-selector` pass.

## Guardrails

- Software/coding only — no general news.
- Cite sources; never assert currency from memory. If a source didn't load, say so.
- Trending is a starting signal, not a recommendation. Adoption still needs the
fit/maintenance/license check.



## Optional: recurring digest

For a weekly cadence, the user can wire a scheduled run (`claude -p "/dev-radar weekly, my stack"`) via cron or their scheduler, output appended to a notes file.