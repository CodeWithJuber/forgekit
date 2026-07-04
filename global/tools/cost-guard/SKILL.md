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

## Model choice (balanced)
- Default working model handles implementation.
- Cheap model (`scout`) for search/triage/enumeration.
- Reserve the top model for genuinely hard reasoning, not routine edits.

## Prompt-cache hygiene
Claude Code caches by exact request *prefix* (system prompt → project context →
conversation). A change high in the prefix recomputes everything after it — a
slow, expensive turn. Keep the cache warm:
- **Pick model + connect MCP servers at session start.** Switching model mid-task
  (incl. `opusplan` plan-mode toggles) recomputes the whole history — each model
  has its own cache. This config pins a fixed model to avoid that.
- **Save `/compact` for natural breaks** between tasks, not mid-task. To abandon a
  path, prefer `/rewind` (truncates to an already-cached prefix) over `/compact`
  (builds a new one).
- **Don't add bare-tool deny rules mid-session** (e.g. deny `Bash`/`WebFetch`) —
  that changes the tool set and busts the system-prompt layer. Scoped rules like
  `Bash(rm *)` are cache-safe.
- **Editing CLAUDE.md/output-style mid-session** is cache-safe but *doesn't apply*
  until `/clear` or restart — so edit, then restart to pick it up.
- Watch the status line's `⚡NN%` cache indicator: green is healthy; if it stays
  low turn after turn, something in your prefix keeps changing.

## Fan-out for big batches
For repetitive edits across many files, generate the file list first, test the
prompt on 2–3 files, then loop `claude -p "<prompt>" --allowedTools "Edit,Bash(git commit *)"`
over the rest rather than doing all of it in one bloated session.
