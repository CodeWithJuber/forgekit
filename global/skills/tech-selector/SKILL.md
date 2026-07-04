---
name: tech-selector
description: Choose a library, framework, or tool by verifying the CURRENT best option from live sources — not from training data. Use whenever picking a dependency, starting a project, or the user asks "what's the best X for Y", "latest", "which library", or wants an unbiased/current recommendation.
---

# Tech selector

Training data is stale and biased toward what was popular at cutoff. For any
"what should I use" decision, verify against live sources before recommending.

## Verify before recommending (don't skip)
1. **Docs (Context7 MCP)** — `resolve-library-id` then `get-library-docs` for the
   candidates. Confirms the API is current and the library still exists.
2. **Web search** — "<use-case> best library <current year>", release notes,
   "X vs Y". Look for recency; ignore posts older than ~18 months unless canonical.
3. **GitHub health** (via `gh` or GitHub MCP) — for each finalist check:
   last commit date, release cadence, open-vs-closed issue ratio, maintainer
   count, and license. A popular-but-abandoned repo is a trap.

## Decision rubric (fit first, not stars)
Score finalists on: **fit** to the actual use case > **maintenance** (active,
recent releases) > **license** compatibility > **DX / docs quality** > **bundle
/ runtime cost** > **ecosystem & types** > popularity. Popularity breaks ties, it
doesn't win them.

## Anti-bias rules
- Don't default to the framework you "know" — name ≥2 real alternatives and say
  why the pick wins for *this* case.
- Prefer what the project already uses over introducing a new dependency.
- State the date of the evidence and the version you verified. If you couldn't
  verify, say so — don't assert currency from memory.

## Output
A short table: option · fit · maintenance (last release) · license · why/why-not,
then a one-line pick with the specific version and the trade-off you accepted.
