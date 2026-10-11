# Gate lattice — turn ⊂ commit ⊂ PR

forgekit treats verification as a lattice of three gates, each strictly stronger than
the last. A weaker gate passing never excuses a stronger one.

## Turn level — `forge preflight`

Run at task start, before writing any code. It answers: *what does this task name
that the repo doesn't define?* — missing symbols, phantom files, flags nothing
provides. Catching a hallucinated assumption here costs seconds; catching it in
review costs a rewrite.

## Commit level — `forge precommit`

Run on staged changes, before `git commit`:

- **staged code without docs** — if you changed behavior, the docs/state artifacts
  must move with it (the completion gate enforces the same rule at session end)
- **secret scan** — API keys, tokens, credentials in the diff

`FORGE_COMMIT_GATE=block` turns findings into a hard stop; `warn` (default) reports
them; `0` disables the gate (don't).

## PR level — `forge verify`

Run before `git push` / opening a PR. Independent verification, not self-review:

1. **tests** — the repo's own suite, unmodified
2. **hallucinated-symbol check** — every symbol the diff references must resolve
   to a real definition (imports, calls, config keys)
3. **provenance** — what produced each change is traceable

`--deep` adds multi-lens consensus: several independent checks must agree before
the gate passes. Use it for security-sensitive code, migrations, and public APIs.

## The rule

`preflight` green → write code. `precommit` green → commit. `verify` green → push.
A gate is green only when the tool says so — "it looked fine" is not a gate result.
