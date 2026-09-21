# Impact Oracle — Codebase World-Model + Blast-Radius Predictor

A Python package that builds a persistent structural model of a codebase and
predicts the blast radius of proposed symbol changes.  Designed as a concrete
demonstrator of the "know what exists and what it affects" faculty — the kind
of external stateful architecture that a frozen LLM structurally lacks.

## Why

A transformer at inference time is a stateless function `y = f_θ(x)`.  It
cannot maintain a structural model of a codebase across turns, and it cannot
simulate the consequences of a proposed edit before making it.  The Impact
Oracle is an external module that fills this gap: it parses the codebase once,
persists the resulting dependency graph, and — given a proposed change —
traverses reverse dependencies to predict what will break.

## Architecture

```
┌───────────────────────────────────────────────────────┐
│  World Model (world_model.py)                         │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────┐  │
│  │  AST Parser  │──▶│  Dependency  │──▶│ Persistent │  │
│  │  (parser.py) │   │    Graph     │   │   Cache    │  │
│  └─────────────┘   │  (NetworkX)  │   │  (JSON)    │  │
│                     └──────────────┘   └───────────┘  │
└───────────────┬───────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────┐
│  Impact Oracle (oracle.py)                            │
│  - Reverse-dependency BFS with confidence decay       │
│  - + SIBLING and FORWARD relations (repair v2)        │
│  - Per-edge-kind weights (calls > imports > refs)     │
│  - Ranked impact set with explanation paths           │
│  - Baselines: grep + edited-file-only                 │
└───────────────────────────────────────────────────────┘
```

### Repaired (v2) — what changed and why

The empirical refutation in [`research/empirical-refutation/`](../../empirical-refutation/)
measured this prototype against real co-change data on nine repositories and found two
defects. Both repairs now live here, and the frozen parameters they were tuned with are
in `oracle.py` as the module defaults:

1. **src-layout phantom nodes** (`world_model.py`, `_merge_phantom_nodes`). A module's
   qualified name came from its path relative to the codebase root, so in a `src/` layout a
   real node carried a `src.` prefix that absolute imports elsewhere in the same repo
   legitimately omit — and the unprefixed target was auto-created as an empty phantom. The
   merge now also matches that direction, stripping only a top-level path segment the
   parser actually observed, and only when exactly one real node results.
   Pooled recall 0.0220 → 0.2424 at threshold 0.02.
2. **Reverse-only traversal** (`oracle.py`, `predict_impact`). 94.7% of the remaining
   misses were *siblings* — A and B both depend on module C — and 2.1% were pure forward
   dependencies. Two terminal relations were added: `sibling` (one bounded forward hop to a
   bridge, then one bounded reverse hop from it, skipping bridges whose in-degree exceeds
   the cap) and `forward` (the changed symbol's own dependencies, ≤2 hops).
   Held-out (never-tuned) repos at threshold 0.10: precision 0.320, recall 0.647,
   **F1 0.428 vs the grep baseline's 0.371** — a reversal of the as-shipped 0.042 vs 0.437.

`ImpactOracle(wm, sibling_enabled=False, forward_enabled=False)` reproduces the
as-shipped reverse-only traversal exactly; the untouched as-shipped package is archived as
`prototypes/impact_oracle_v1_as_shipped.zip` inside the replication tarball. The same two
repairs are ported to the shipped Node implementation (`src/atlas.js`, `forge impact`).

### Graph structure

- **Nodes** = symbols: modules, classes, functions/methods, module-level names
- **Edges** = structural dependencies:
  - `imports` — module-level import statements
  - `calls` — function/method calls
  - `inherits` — class inheritance
  - `references` — attribute access, name usage
  - `contains` — parent scope → child definition
- Each edge carries a **confidence** score (1.0 = certain, <1.0 = heuristic)

### Incremental update

Files are content-hashed (SHA-256).  On subsequent builds, only changed files
are re-parsed.  The graph is persisted as JSON (portable node-link) — the earlier
pickle cache was removed as an insecure-deserialization vector.

## Quick start

```bash
# Install dependencies
pip install networkx matplotlib pytest

# Run the demo
python demo.py

# Run the evaluation (mutation testing)
python evaluate.py

# CLI usage
python -m impact_oracle.cli build demo_package/
python -m impact_oracle.cli impact demo_package/ utils.validation.validate_positive
python -m impact_oracle.cli summary demo_package/
```

## Evaluation

The evaluation uses **mutation testing** as ground truth:

1. For each target symbol, apply a breaking mutation (change behavior/signature)
2. Run pytest — the set of modules whose tests fail = true behavioral blast radius
3. Compare oracle prediction vs. mutation ground truth

### Results (5 mutations, averaged)

| Method            | Precision | Recall | F1    |
|-------------------|-----------|--------|-------|
| **Graph Oracle**  | 0.633     | **1.000** | **0.753** |
| Grep baseline     | 0.733     | 0.943  | 0.787 |
| Edited-file only  | **1.000** | 0.529  | 0.650 |

On this demo package the oracle reached recall 1.000 (it missed no affected module in
these five mutations), with its best F1 of 0.79 at the optimal threshold (t=0.4).

> **Refuted on real code.** That recall did not transfer. On 759 files in nine open-source
> Python repositories, with co-change ground truth, this version's recall was **0.022** and a
> grep baseline scored F1 0.437 against its 0.042: the traversal walks only reverse edges, and a
> construction defect breaks `src/`-layout packages. A repaired version ships in
> [`../../empirical-refutation/replication_package.tar.gz`](../../empirical-refutation/). Earlier
> versions of this README said the oracle "achieves perfect recall (never misses a truly affected
> module)". (Corrected 2026-09-21.)

## File structure

```
impact_oracle/          # The package
  __init__.py
  parser.py             # AST-based Python source parser
  world_model.py        # Persistent structural graph (world model)
  oracle.py             # Blast-radius prediction engine
  cli.py                # Command-line interface

demo_package/           # Example multi-module codebase (8 files)
  __init__.py
  models.py             # Product, PremiumProduct classes
  inventory.py          # Stock management
  orders.py             # Order processing
  reports.py            # Reporting aggregation
  utils/
    validation.py       # Shared validation functions
    formatting.py       # Display formatting
  sub/
    pricing.py          # Pricing analytics

tests/
  test_demo_package.py  # 36 tests exercising the demo package
  test_repair_fixes.py  # 13 regression tests for the two v2 repairs

demo.py                 # End-to-end demonstration script
evaluate.py             # Mutation-based evaluation
```

## License

Research prototype — no license restrictions.
