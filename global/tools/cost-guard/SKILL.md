---
name: cost-guard
description: Reduce token/cost burn on large or exploratory tasks. Use when a task will touch many files, involves broad codebase search, a big migration, or when the user asks to keep cost/context low.
---

# Cost guard

Playbook for high-performance, low-cost runs. The constraint is the context
window: performance degrades as it fills, and tokens cost money. Spend context
deliberately.

## Rules of thumb
- **Search, don't read.** Use `rg`/`grep`/`glob` to locate, then read only the
  relevant lines/ranges — not whole files or directories.
- **Delegate exploration.** For "how does X work / where is Y" questions across
  many files, spawn the `scout` subagent. It reads in its own context and returns
  a summary, keeping the main thread lean.
- **Verify with a fresh model.** For non-trivial diffs, use the `verifier`
  subagent instead of re-reading everything yourself.
- **Clear between tasks.** Unrelated work → `/clear`. Long single problems can
  keep context; switching topics should not.
- **Compact with intent.** When near limits, `/compact Focus on <the thing that
  matters>` beats a generic compaction.
- **Prefer CLIs** (`gh`, cloud CLIs) over pasting large outputs or fetching pages.
- **Scope investigations.** Never say "investigate X" unbounded — name the files
  or the question, or hand it to `scout`.

## Model choice + measurement
- `forge route "<task>"` names the cheapest capable tier before you pick a model;
  escalate only after an external verifier fails.
- Cheap model (`scout`) for search/triage/enumeration; reserve the top model for
  genuinely hard reasoning, not routine edits.
- `forge cost` shows real per-day spend; **`forge cost --stages`** shows the
  measured per-stage savings (gate / cache / route / context) from
  `.forge/metrics.jsonl` — a stage with no events says "no data", never a default.
- `forge reuse query "<spec>"` before regenerating: a hit is verified code you
  already paid for.

## Prompt-cache hygiene
Claude Code caches by exact request *prefix*; a change high in the prefix
recomputes everything after it. Pick model + MCP servers at session start
(switching mid-task busts the cache); save `/compact` for natural breaks and
prefer `/rewind` to abandon a path; don't add bare-tool deny rules mid-session
(scoped rules like `Bash(rm *)` are cache-safe); watch the status line's `⚡NN%`
indicator — if it stays low turn after turn, your prefix keeps changing.

## Fan-out for big batches
For repetitive edits across many files, generate the file list first, test the
prompt on 2–3 files, then loop `claude -p "<prompt>" --allowedTools "Edit,Bash(git commit *)"`
over the rest rather than doing all of it in one bloated session.
