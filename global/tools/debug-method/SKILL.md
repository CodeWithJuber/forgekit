---
name: debug-method
description: Debugging protocol that finds the cause instead of guessing — verify the inputs and logs first, isolate one variable at a time, reduce to the simplest form, prove the fix with a check that failed before, and feed failures back into the next attempt. Use when code breaks, a test fails, an error is obscure, the same failure keeps coming back, or a fix "should work" but does not.
---

# Debug method

A fix that nobody can reproduce is a guess. This protocol moves from evidence to cause to
proof, one step at a time. State which step you are in.

## The steps

1. **Read before you act.** Read the full error, the log around it and the exact inputs.
   Treat every source as unverified until checked: user input, an API payload, a model's
   output, another agent's report, your own memory of how the code works.
2. **Reproduce it.** Get the smallest input that fails, and run it. No fix starts before
   there is a failing observation.
3. **Reduce to the simplest form.** Strip the feature back to data in, transformation, data
   out. Find the first point where the data is wrong.
4. **Isolate one variable at a time.** List the hypotheses. Change one thing, observe,
   record. Use `git bisect` for regressions. Never change five files at once and hope.
   - `forge impact <symbol>` shows the direct references to the code under suspicion first.
   - `forge deja "<error>"` finds whether this was solved before.
5. **Fix the cause, not the symptom.** A wrong status in the UI is rarely a UI bug. Write the
   failing test before the fix.
6. **Prove it.** The same reproduction fails before the fix and passes after, and the
   adjacent tests still pass. `forge verify` runs the suites and binds the verdict to the
   exact tree; `forge test-select` names the tests the change owes.
7. **Check the smallest cases.** Empty, zero, null, boundaries, off-by-one, time zones, leap
   days, Unicode and right-to-left text. Defects hide where nobody weighed.
8. **Own and record it.** Write down the cause, the fix and how it was proven
   (`forge remember`). A workaround is labelled a workaround, with the open cause named.

## When the same failure keeps coming back

`forge diagnose "<error>"` records the failure; the same signature three times mints a
diagnosis, and the doom-loop hook stops the session from patching blindly. At that point:

- Re-read the failing assertion and the code it exercises. Re-running without a change
  cannot fix anything.
- Question the assumption you have tested three times; it is the likeliest wrong one.
- Reset to a fresh context with only the reproduction, or hand off to a human or a stronger
  model with what you tried.

## Feedback loop for agents

Feed every linter error, compiler message and test failure back into the next attempt
verbatim. The agent that reads its own failures and corrects course converges; the one that
retries the same edit does not.
