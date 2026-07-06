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
│  - Per-edge-kind weights (calls > imports > refs)     │
│  - Ranked impact set with explanation paths           │
│  - Baselines: grep + edited-file-only                 │
└───────────────────────────────────────────────────────┘
```

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

The oracle achieves **perfect recall** (never misses a truly affected module),
with its best F1 of 0.79 at the optimal threshold (t=0.4).

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

demo.py                 # End-to-end demonstration script
evaluate.py             # Mutation-based evaluation
```

## License

Research prototype — no license restrictions.
