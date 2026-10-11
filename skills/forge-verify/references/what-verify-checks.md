# What `forge verify` actually checks

## Default run

| Check | What it does | Typical failure |
|---|---|---|
| test suite | runs the repo's tests as CI would | a red test you didn't run locally |
| hallucinated symbols | every imported/called/configured symbol in the diff must resolve to a real definition | calling a function that doesn't exist, importing a deleted module |
| provenance | each change is traceable to its source (commit, author, tool) | generated files with no recorded generator |

## `--deep` (multi-lens consensus)

Runs the default checks plus independent lenses that must *agree*:

- static analysis lens (lint/typecheck surface)
- behavioral lens (tests, again, isolated)
- semantic lens (does the change mean what the diff says)

One lens dissenting fails the gate. Slower — reserve for risky changes.

## Reading a red gate

The output names the check, the file, and the symbol. Fix in this order:

1. **secrets** — never commit; rotate if one leaked
2. **hallucinated symbols** — usually a bad merge or a renamed import
3. **tests** — reproduce locally with the exact command the gate printed
4. **docs drift** — behavior changed but docs didn't move with it

## What verify does NOT do

- It doesn't review design quality — that's your job.
- It doesn't run the app end-to-end — that's staging's job.
- A green gate means "safe to push", not "correct". Review still matters.
