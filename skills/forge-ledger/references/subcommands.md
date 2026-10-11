# Ledger subcommands

Full syntax:

```
forge ledger (stats | verify | show <id> | blame <id> | query <text> | at <date>
  | diff <since> [<until>] | root | ratify <id> | retract <id> --reason "<why>"
  | merge <path> | sync [--dir <path>|--remote <name>|--ref <ref>] | import)
  [--personal] [--json]
```

## Reading

| Command | Example | Use |
|---|---|---|
| `stats` | `forge ledger stats` | ledger health: claim count, evidence coverage, staleness |
| `query` | `forge ledger query "checkout latency"` | full-text search over claims |
| `show` | `forge ledger show claim-042` | one claim + its evidence + provenance |
| `blame` | `forge ledger blame claim-042` | who recorded it, when, from what source |
| `at` | `forge ledger at 2026-06-01` | the ledger's state on that date |
| `diff` | `forge ledger diff 2026-06-01 2026-07-01` | what changed in June |
| `root` | `forge ledger root` | where the ledger lives on disk |

## Writing

| Command | Example | Notes |
|---|---|---|
| `ratify` | `forge ledger ratify claim-042` | human sign-off; makes the claim trustworthy for automation |
| `retract` | `forge ledger retract claim-042 --reason "superseded by claim-089"` | append-only: marks dead, never deletes |
| `compact` | `forge ledger compact` | distills old claims; provenance is preserved |
| `merge` | `forge ledger merge ./teammate-ledger/` | merge another ledger's claims in |
| `import` | `forge ledger import` | import from external sources |
| `sync` | `forge ledger sync --remote origin` | share with the team |

## Maintenance

- `forge ledger verify` — re-check all evidence links; run weekly and after migrations.
- `forge ledger stats` — if evidence coverage drops, the ledger is rotting: re-verify
  or retract the stale claims. A ledger nobody verifies becomes a rumor mill.

## Exit codes

0 = done. Non-zero = the ledger itself has a problem (corrupt store, unwritable
path) — fix the store before trusting its answers.
