#!/usr/bin/env python
"""End-to-end demo of the Impact Oracle.

Builds a world-model graph of the demo_package codebase, then predicts
the blast radius of editing a symbol, printing the predicted impact set
with confidence scores and dependency paths.

Usage:
    python demo.py
"""

import os
import sys
import json

# Ensure the workspace root is on PYTHONPATH
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from impact_oracle.world_model import WorldModel
from impact_oracle.oracle import ImpactOracle


def main():
    workspace = os.path.dirname(os.path.abspath(__file__))
    demo_root = os.path.join(workspace, "demo_package")

    # ---------------------------------------------------------------
    # 1. Build the world model
    # ---------------------------------------------------------------
    print("=" * 60)
    print("  IMPACT ORACLE — Codebase World-Model Demo")
    print("=" * 60)

    wm = WorldModel(demo_root, cache_dir="/tmp/impact_oracle_demo_cache")
    stats = wm.build(incremental=True)

    print(f"\n[1] World Model Built")
    print(f"    Files parsed: {stats['files_parsed']}/{stats['files_total']}")
    print(f"    Graph size:   {stats['nodes']} nodes, {stats['edges']} edges")

    summary = wm.summary()
    print(f"    Node kinds:   {summary['node_kinds']}")
    print(f"    Edge kinds:   {summary['edge_kinds']}")

    # ---------------------------------------------------------------
    # 2. Show what the model knows
    # ---------------------------------------------------------------
    print(f"\n[2] Symbols in the Codebase")
    for kind in ["module", "class", "function"]:
        nodes = wm.all_nodes(kind=kind)
        print(f"    {kind}s ({len(nodes)}):")
        for n in sorted(nodes, key=lambda x: x["qualified_name"])[:8]:
            sig = n.get("signature", "")
            print(f"      {n['qualified_name']}{sig}")
        if len(nodes) > 8:
            print(f"      ... and {len(nodes) - 8} more")

    # ---------------------------------------------------------------
    # 3. Predict blast radius
    # ---------------------------------------------------------------
    oracle = ImpactOracle(wm)

    targets = [
        "utils.validation.validate_positive",
        "models.Product.discounted_price",
        "utils.formatting.format_currency",
    ]

    for symbol in targets:
        print(f"\n{'=' * 60}")
        print(f"[3] Impact Prediction: what breaks if we change '{symbol}'?")
        print(f"{'=' * 60}")

        report = oracle.predict_impact(symbol, threshold=0.1)

        print(f"    Impacted symbols: {len(report.impacted)}")
        print(f"    Impacted files:   {report.impacted_files}")
        print(f"    Threshold used:   {report.threshold_used}")

        print(f"\n    Ranked impact set:")
        for n in report.impacted:
            path_str = " → ".join(n.path)
            edge_str = " → ".join(n.edge_kinds)
            print(f"      [{n.confidence:.3f}] {n.qualified_name}")
            print(f"               kind={n.kind}, hop={n.hop_distance}")
            print(f"               path: {path_str}")
            print(f"               via:  {edge_str}")

        # Baselines comparison
        grep_files = ImpactOracle.grep_baseline(symbol, demo_root)
        edited_files = ImpactOracle.edited_file_baseline(symbol, wm.graph)

        print(f"\n    Baselines comparison:")
        print(f"      Oracle files:      {sorted(report.impacted_files)}")
        print(f"      Grep baseline:     {sorted(grep_files)}")
        print(f"      Edited-file only:  {sorted(edited_files)}")

    # ---------------------------------------------------------------
    # 4. Incremental update demo
    # ---------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[4] Incremental Update (re-build without changes)")
    stats2 = wm.build(incremental=True)
    print(f"    Files parsed: {stats2['files_parsed']}/{stats2['files_total']} "
          f"(skipped {stats2['files_skipped']} unchanged)")

    print(f"\nDone. The world model is cached at /tmp/impact_oracle_demo_cache/")


if __name__ == "__main__":
    main()
