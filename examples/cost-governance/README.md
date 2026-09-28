# Example: cost governance

> The #1 churn driver for agent coding tools is billing opacity — a run that
> quietly burns $40 while you watch the spinner. This example sets a budget,
> inspects it, and shows the circuit breaker that stops a runaway task.

## The pain

Without a budget, an agent loop has no concept of "too expensive". It retries,
re-plans, and re-reads files until the task is done — or your wallet is. Forge
treats spend as a first-class guardrail: per-day and per-task budgets, an alert
threshold, and an opt-in hard breaker the cost guard enforces.

## Run it

```bash
# from the repo root (node src/cli.js is the CLI entry; or use an installed `forge`)
forge() { node "$PWD/src/cli.js" "$@"; }
demo_dir="$(mktemp -d)" && cd "$demo_dir"

# 1. set a budget: $10/day, $2/task, alert at 80%, hard breaker ON
forge budget set --daily 10 --per-task 2 --alert-at 0.8 --hard

# 2. inspect it
forge budget status

# 3. ask the guard whether a new tool call may proceed — this is the same
#    entry point the cost guard calls mid-run (every 100th tool call).
#    With no spend telemetry wired up, Forge stays honest: unknown spend
#    never alerts and never blocks.
forge budget check --session-id demo
```

Expected: step 3 reports `decision: allow` with an empty reason — spend is
unknown and unknown spend never blocks (the honesty rule). Wire real spend
(via ccusage) and the same command returns `ask` past the alert threshold —
or **deny** past the ceiling when `--hard` is on.

## What to look at

- `budget status` shows both limbs (daily + per-task) and the alert threshold —
  one screen, no dashboard needed.
- `budget check` is the same entry point the cost guard calls mid-run, so what
  you see here is exactly what the agent sees.
- `--hard` is strictly opt-in. Without it, over-budget is a warning, never a
  block — unknown spend never alerts and never blocks.

## Cleanup

Everything lives in `$demo_dir/.forge/` — delete the scratch dir and it's gone.
`forge budget clear` wipes the budget in any repo without deleting the dir.

## Files

- `demo.sh` — the steps above as an executable script
- `demo.gif` — screen recording of the real output:
  [`mintlify/images/cost-governance.gif`](../../mintlify/images/cost-governance.gif)
  (rendered by `scripts/make-cost-gif.py` from captured real CLI output)
