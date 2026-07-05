# Cognitive substrate capability map

| Paper capability | Forge surface | Guarantee |
| --- | --- | --- |
| Memory | `forge recall`, `forge cortex` | File-backed facts/lessons are persisted and auditable. |
| Learning | `forge cortex` | External outcomes update lessons; model weights do not change. |
| Imagination | `forge impact`, `forge substrate` | Static graph simulates possible blast radius. |
| Self-correction | `forge verify`, doom-loop guard | Tests/builds beat model claims. |
| Impact-awareness | `forge atlas`, `forge impact` | Known symbols/files and likely dependents are surfaced. |
| M1 routing | `forge route` | Transparent model-tier recommendation. |
| M2 assumption gate | `forge preflight`, `forge substrate` | Under-specified tasks return questions. |
| M3 decomposition | `forge scope` | Import clusters show independent vs coupled files. |
| M4 goal anchoring | `forge substrate` | One pre-action summary anchors goal, risk, and verification. |
| M5 anti-over-engineering | `forge substrate`, `lean-guard` | Broad/underspecified work gets minimality warnings. |
| M6 inline verification | `forge verify` | External checks are required before done. |

Limits: static graph edges are conservative; memory relevance and model routing are advisory; non-hook tools cannot be forcibly blocked.
