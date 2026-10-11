# Evidence model — claims, evidence, and the ratify/retract lifecycle

## The unit: a claim with evidence

A ledger entry is not a note. It's a triple:

- **claim** — a falsifiable statement ("checkout latency p99 is 1.2s on the EU region")
- **evidence** — what backs it (a measurement, a commit, a log excerpt, a doc link)
- **provenance** — who recorded it, when, from what source

`forge ledger show <id>` prints all three. `forge ledger blame <id>` answers "says who?"
with the recording context, not just a username.

## Lifecycle

```
recorded ──→ ratified ──→ (stands, re-verified on schedule)
    │              │
    └────→ retracted (with --reason; the entry stays, marked dead)
```

- **recorded** — a claim entered the ledger (by an agent or a human).
- **ratified** — a human signed off: "yes, this evidence supports this claim."
  `forge ledger ratify <id>`. Ratified claims are what `forge impact` trusts for
  its incident-history signal.
- **retracted** — the claim was wrong or superseded. `forge ledger retract <id>
  --reason "superseded by …"`. History is append-only: retraction marks, never
  deletes. A deleted mistake is a repeated mistake.

## Verification

`forge ledger verify` re-checks every claim's evidence: does the linked commit
still exist? does the file the claim cites still say that? Stale claims are
flagged, not silently kept. Run it on a schedule (weekly is sane) and after any
migration that moves files around.

## Time travel

- `forge ledger at <date>` — reconstruct what the ledger knew then. Useful when
  debugging "when did we first know about this?"
- `forge ledger diff <since> [<until>]` — what entered, what was ratified, what
  died between two points. The changelog of institutional knowledge.

## Personal vs team

`--personal` keeps a claim in your ledger only. Default is the team ledger, which
`forge ledger sync` shares. Rule of thumb: personal for working notes, team for
anything someone else will rely on.
