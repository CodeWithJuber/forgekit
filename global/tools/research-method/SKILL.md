---
name: research-method
description: Method for new research and finding ideas others miss — start from what you do not know, question inherited assumptions, look at the real system, rule out hypotheses one at a time, borrow mechanisms from other fields, and prove a small version before scaling. Use when the task is to investigate, compare approaches, find a better way, explore an unfamiliar area, or pick a research or product direction.
---

# Research method

Research stops the moment you assume you already have the full picture. This method keeps an
agent curious, grounded in observation and honest about what is proven. Match depth to the
question: a quick comparison needs steps 1, 3 and 6, not the whole drill.

## The six steps

1. **Start from what you do not know.** Write two lists: what you know with proof, and what
   you only assume. Every item on the second list is a hypothesis, not a premise. Expect new
   unknowns with every answer; that is progress, not failure.
2. **Question what everyone takes for granted.** For each inherited assumption ask whether
   anyone measured it here. Respect earlier work without copying its flaws. "We always did
   it this way" is a reason to check, never a reason to keep.
3. **Look at the real thing.** Read the code, run it, measure it, open the data. Do not infer
   behaviour from names, docs or memory alone.
   - `forge evidence "<topic>"` finds existing code and cached sources first.
   - `forge ledger query "<topic>"` and `forge deja "<task>"` show what this team already
     learned and solved.
4. **Rule out hypotheses one at a time.** List the candidate explanations. For each, name an
   observation that would prove it wrong, then look for that observation. Drop what fails;
   keep what survives every attempt to break it.
5. **Borrow from other fields.** Look for a mechanism that already works elsewhere (another
   project, another language, another domain, nature) and test whether its structure fits.
6. **Prove it small, then measure precisely.** Turn the idea into a test you can run today
   on a handful of examples. If it fails, drop it without ego. If it works, measure the
   variables that matter and record exact numbers with the procedure that produced them.

Finish by recording the result and what stays open: `forge remember <name> "<finding>"`, or a
decision with `forge decide`. Label each claim as established, inferred, conjectured or open.

## Breakthrough drill (five minutes, any crowded problem)

Use this when the obvious approaches are taken and you want the one nobody is looking at.

1. **Blind spot.** Write down the annoying step, slow script, manual workaround or noisy
   artifact everyone in the field calls "just part of the job". That friction is often the
   uncrowded opportunity.
2. **Delete the biggest assumption.** List the three assumptions every current tool or paper
   makes, and cross out the biggest one. Example: "agents need a vector database to remember
   a codebase" — what if plain files and search do better with no infrastructure?
3. **Ask the opposite question.** Flip the main goal. "How do we generate code faster?"
   becomes "How do we delete most of the code so bugs have nowhere to hide?" "How do we catch
   a wrong output?" becomes "How do we make the wrong output impossible to produce?"
4. **Use what already exists.** Ask what in your environment solves most of this for free if
   you stop fighting it: the compiler, the type checker, database constraints, the test
   suite, the platform's own limits.
5. **Two-hour proof.** Shrink the idea to a toy you can run in under two hours on ten
   examples. Fail fast and drop it, or keep a reproducible result before anyone else asked
   the question.

## Habits

- Treat nothing as ordinary: ask how it started and why it works the way it does.
- Keep the two lists (proven, guessed) current as you go.
- Measure exact proportions and variables; a vague result cannot be built on.
- Filter topics by lasting benefit to the people who will use the result, not by novelty or
  hype. Flashy ideas fade quickly; useful ones remain.

## What this skill does not do

It does not replace a literature review or domain expertise, and a toy proof is not a field
result. Say which one you have.
