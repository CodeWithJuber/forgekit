"""Command-line interface for the Impact Oracle."""

from __future__ import annotations

import argparse
import json
import sys

from impact_oracle.world_model import WorldModel
from impact_oracle.oracle import ImpactOracle


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(
        prog="impact-oracle",
        description="Codebase world-model builder and impact predictor.",
    )
    sub = parser.add_subparsers(dest="command")

    # -- build --
    build_p = sub.add_parser("build", help="Parse codebase and build/update the world-model graph.")
    build_p.add_argument("root", help="Codebase root directory.")
    build_p.add_argument("--no-incremental", action="store_true", help="Full rebuild (ignore cache).")
    build_p.add_argument("--cache-dir", help="Override cache directory.")

    # -- impact --
    imp_p = sub.add_parser("impact", help="Predict blast radius of changing a symbol.")
    imp_p.add_argument("root", help="Codebase root directory.")
    imp_p.add_argument("symbol", help="Qualified name of the symbol to change.")
    imp_p.add_argument("--threshold", type=float, default=0.1, help="Confidence threshold (default 0.1).")
    imp_p.add_argument("--cache-dir", help="Override cache directory.")
    imp_p.add_argument("--json", action="store_true", help="Output as JSON.")

    # -- summary --
    sum_p = sub.add_parser("summary", help="Print world-model summary.")
    sum_p.add_argument("root", help="Codebase root directory.")
    sum_p.add_argument("--cache-dir", help="Override cache directory.")

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return

    if args.command == "build":
        wm = WorldModel(args.root, cache_dir=args.cache_dir)
        stats = wm.build(incremental=not args.no_incremental)
        print(f"Parsed {stats['files_parsed']}/{stats['files_total']} files "
              f"(skipped {stats['files_skipped']} unchanged)")
        print(f"World model: {stats['nodes']} nodes, {stats['edges']} edges")

    elif args.command == "impact":
        wm = WorldModel(args.root, cache_dir=args.cache_dir)
        wm.build(incremental=True)
        oracle = ImpactOracle(wm)
        report = oracle.predict_impact(args.symbol, threshold=args.threshold)

        if getattr(args, "json", False):
            print(json.dumps(report.to_dict(), indent=2))
        else:
            print(f"\n=== Impact Report for: {report.changed_symbol} ===")
            print(f"Threshold: {report.threshold_used}")
            print(f"Impacted symbols: {len(report.impacted)}")
            print(f"Impacted files: {len(report.impacted_files)}")
            for node in report.impacted:
                edge_str = " → ".join(node.edge_kinds)
                print(f"  [{node.confidence:.3f}] {node.qualified_name} "
                      f"({node.kind}, hop={node.hop_distance}) via {edge_str}")
            if report.impacted_files:
                print(f"\nFiles affected:")
                for f in report.impacted_files:
                    print(f"  {f}")

    elif args.command == "summary":
        wm = WorldModel(args.root, cache_dir=args.cache_dir)
        wm.build(incremental=True)
        s = wm.summary()
        print(f"World model: {s['nodes']} nodes, {s['edges']} edges, {s['files']} files")
        print(f"Node kinds: {s['node_kinds']}")
        print(f"Edge kinds: {s['edge_kinds']}")


if __name__ == "__main__":
    main()
