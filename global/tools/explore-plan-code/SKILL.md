---
name: explore-plan-code
description: Structured workflow for non-trivial features or unfamiliar code — explore, then plan, then implement, then verify. Use when a change spans multiple files, the approach is uncertain, or the user asks for a spec/plan first.
---

# Explore → Plan → Code → Verify

Separate research from execution so you don't build the wrong thing.

1. **Explore (read-only).** Enter plan mode or use the `scout` subagent. Read the
   relevant files and existing patterns. Answer: where does this live, what
   conventions apply, what will change. No edits yet.
2. **Plan.** Produce a concrete plan naming the exact files/interfaces to touch,
   what's out of scope, and an end-to-end verification step. For big features,
   interview the user with `AskUserQuestion`, then write it to `SPEC.md` and start
   a fresh session to implement against it.
3. **Code.** Implement against the plan. Follow existing patterns; add no new deps
   without cause.
4. **Verify.** Run the check (tests/build/lint) and show the output. For risky
   diffs, hand to the `verifier` subagent. Iterate until it actually passes —
   don't assert success without evidence.

Skip this whole flow for one-line or obviously-scoped fixes; the ceremony isn't
worth it there.
