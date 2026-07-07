# Cognitive substrate capability map

| Paper capability | Forge surface | Guarantee |
| --- | --- | --- |
| Memory | `forge recall`, `forge cortex`, `forge ledger` | Facts/lessons persist as content-addressed ledger claims; `forge ledger blame` shows provenance. |
| Learning | `forge cortex`, ledger oracles | External outcomes (tests, CI, human accept/revert) move claim confidence; model weights do not change. |
| Imagination | `forge imagine [--run]`, `forge impact` | Predicted breaks + minimal covering test suite; `--run` dry-runs it in a sandboxed worktree. |
| Self-correction | `forge verify`, `forge diagnose` | Tests/builds beat model claims; 3× the same failure signature mints a diagnosis + escalation. |
| Impact-awareness | `forge atlas`, `forge impact` | Known symbols/files and likely dependents are surfaced. |
| M1 routing | `forge route` | Transparent model-tier recommendation. |
| M2 assumption gate | `forge preflight`, `forge context` | Under-specified tasks return *computed* missing-set questions. |
| M3 decomposition | `forge scope` | Import clusters show independent vs coupled files. |
| M4 goal anchoring | `forge anchor`, `forge substrate` | Changed files are checked against the stated goal. |
| M5 anti-over-engineering | `forge lean`, `forge uicheck design` | Footprint vs ask; UI slop-distance + fingerprint conformance gate. |
| M6 inline verification | `forge verify` | External checks are required before done. |

Limits: static graph edges are conservative; memory relevance and model routing are advisory; non-hook tools cannot be forcibly blocked.
