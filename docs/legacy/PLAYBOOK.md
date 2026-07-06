# Playbook — how to drive your Claude setup

> ⚠️ **Archived — pre-Forge.** Kept for history; **not maintained**. It describes an older
> hand-rolled `~/.claude` setup, not today's `forge` CLI. For the current workflow start at
> **[ONBOARDING.md](../../ONBOARDING.md)** → **[docs/GUIDE.md](../GUIDE.md)**. Any credentials or
> open action items below are historical and superseded — do not act on them.

Your global config auto-loads skills/rules by what you ask; you rarely invoke them
by name. Below: the exact prompt per situation, and what fires under the hood.

## Setup per repo (once)
```bash
cd ~/the-repo && claude-init      # writes AGENTS.md + thin CLAUDE.md (auto-detects stack)
claude-taste minimalist-ui        # optional: enable ONE UI taste for this repo (claude-taste = list)
graphify install --project        # optional: adds a code-graph skill to this repo
```
Then in Claude Code, once per big repo: `/graphify .` (builds the graph) and
`graphify hook install` (keeps it current on every commit).

Housekeeping: run `claude-learn-consolidate` weekly to dedupe/prune learned lessons.
Minimalism enforcer is always on via Ponytail (`/ponytail`, `/ponytail-review`).

---

## New project
> "New Next.js app for X. Interview me on scope/stack/edge cases with AskUserQuestion,
> write SPEC.md, then scaffold. Verify best current libs before choosing."

Fires: explore-plan-code → tech-selector (current libs, not memory) → reuse-first.
Then: `claude-init` in the new folder to lay down AGENTS.md/CLAUDE.md.

## Existing project — understand it fast
> "/graphify . then explain how auth connects to the database and where sessions live."

Fires: Graphify graph (≈71× fewer tokens than reading files) + `scout` subagent for
anything the graph doesn't cover. Cheap, keeps main context clean.

## Bug fixing
> "Users report login fails after session timeout. Reproduce with a failing test in
> src/auth/, find the root cause, fix it, and prove the test passes."

Fires: self-correction (write failing test → fix → re-run → show output), reuse-first,
`verifier` subagent on the diff. Address root cause, no error suppression.

## Security fixing
> "Audit this repo for exposed secrets, injection, and authz gaps. Fix the highest-risk
> ones and show before/after. Don't touch .env values — tell me what to rotate."

Fires: security rules + protect-paths hook (blocks writing secret files) + your
`semgrep` plugin. Note: your my-next-app has a **committed .env with WHMCS creds** —
`git rm --cached .env`, gitignore it, rotate the creds.

## Testing
> "Add tests for src/pricing covering empty, error, and boundary cases. Prefer real
> inputs over mocks. Run the suite and show results."

Fires: reuse-first (test discipline) + self-correction (iterate to green). Stack test
cmds live in each repo's AGENTS.md (Vitest/Playwright/pytest).

## UI work (your pain point)
> "Build the settings screen to match [screenshot/URL]. One direction only. Use our
> shadcn components, then screenshot desktop + mobile and fix diffs."

Fires: ui-workflow (one direction + shadcn MCP + screenshot-verify) + design-md
(create/update DESIGN.md) + `frontend-verifier` subagent (visual + a11y check).

## Refactor / modernize legacy
> "Modernize src/legacy incrementally. Pin current behavior with tests first, migrate
> one module at a time, keep business logic identical, commit per slice."

Fires: code-modernization (assess→safety-net→incremental→verify) + serena/Graphify
for mapping + `verifier` per slice.

## Choosing a library / tech
> "Best current option for background jobs in our Node stack? Verify live, don't guess."

Fires: tech-selector (Context7 docs + web + GitHub health) + tech-currency rule.
Output: comparison table + a dated pick, not a training-data default.

## Stay current
> "/dev-radar weekly — my stack"

Fires: dev-radar (GitHub trending + Reddit + papers + blogs, hype-filtered, cited).
Refreshes ~/.claude/rules/stack-notes.md.

## Before merge (review)
> "/code-review"  — or —  "use a subagent to review this diff against SPEC.md; report
> only correctness/requirement gaps."

Fires: fresh-context `verifier` subagent (won't rubber-stamp its own code).

## Keep cost low on big tasks
> "This is a large migration — use scout for exploration, keep context lean, /clear
> between unrelated parts."

Fires: cost-guard (search-don't-read, delegate, cache hygiene). Watch the status
line's `⚡%` cache indicator; `/clear` between unrelated tasks.

---

## Habits that make it all work
- Let it auto-trigger; only type `/skill` when you want to force one.
- Give it a check it can run (tests/build/screenshot) — that's what makes it self-correct.
- `/clear` between unrelated tasks; pick model + connect MCP at session start (cache).
- When you correct the same thing twice, it records a lesson (self-improve →
  ~/.claude/skills/learned/). Session-learning also captures lessons at exit.
- Restart Claude Code after config changes; they load on restart.

## Still yours to do
- Rotate the GitHub PAT and the my-next-app WHMCS creds.
- Fill the `<fill in>` stack line in the few monorepo AGENTS.md files.
- Commit AGENTS.md/CLAUDE.md per repo: `git add AGENTS.md CLAUDE.md && git commit`.
