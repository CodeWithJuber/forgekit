"""Mutation-based evaluation of the Impact Oracle.

For each target symbol, we:
1. Back up the original file
2. Introduce a breaking mutation (change behavior/signature)
3. Run pytest and record which tests fail
4. Map failing tests to their source files to get the true blast radius
5. Restore the original
6. Compare oracle prediction vs mutation ground truth vs baselines
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Ensure workspace root on PYTHONPATH
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from impact_oracle.world_model import WorldModel
from impact_oracle.oracle import ImpactOracle


# --- Mutation definitions ---
# Each mutation: (symbol, file_rel, old_text, new_text, description)

MUTATIONS = [
    {
        "symbol": "utils.validation.validate_positive",
        "file": "demo_package/utils/validation.py",
        "old": '    if value < 0:\n        raise ValueError(f"Value must be non-negative, got {value}")\n    return float(value)',
        "new": '    return -abs(float(value))  # MUTATED: always returns negative',
        "description": "validate_positive now always returns negative — breaks all consumers expecting validated positive values",
    },
    {
        "symbol": "models.Product.discounted_price",
        "file": "demo_package/models.py",
        "old": "        return self.price * (1 - discount_pct / 100)",
        "new": "        return self.price * (1 + discount_pct / 100)  # MUTATED: adds instead of subtracts",
        "description": "discounted_price adds discount instead of subtracting — affects orders, pricing analytics",
    },
    {
        "symbol": "utils.formatting.format_currency",
        "file": "demo_package/utils/formatting.py",
        "old": '    return f"${amount:,.2f}"',
        "new": '    return f"EUR {amount:,.2f}"  # MUTATED: changed currency symbol',
        "description": "format_currency returns EUR prefix — breaks receipt formatting and report assertions",
    },
    {
        "symbol": "inventory.Inventory.remove_stock",
        "file": "demo_package/inventory.py",
        "old": "        if current < quantity:\n            return False\n        self._stock[product_name] = (product, current - quantity)\n        return True",
        "new": "        self._stock[product_name] = (product, current + quantity)  # MUTATED: adds instead of removes\n        return True",
        "description": "remove_stock adds stock instead — affects orders that depend on stock depletion",
    },
    {
        "symbol": "models.PremiumProduct.discounted_price",
        "file": "demo_package/models.py",
        "old": "        capped = min(discount_pct, 30.0)\n        return super().discounted_price(capped)",
        "new": "        return self.price  # MUTATED: no discount at all",
        "description": "PremiumProduct.discounted_price ignores discounts entirely",
    },
]


# --- Test-to-file mapping ---
# Maps test class names to the modules they exercise

# Maps test classes to the PRIMARY module they test (the module whose
# behavior is directly exercised, not every transitive import).
# This is the right level: a failing TestInventory test means the
# inventory module's behavior changed, regardless of what it imports.
TEST_FILE_MAP = {
    "TestValidation": ["demo_package/utils/validation.py"],
    "TestFormatting": ["demo_package/utils/formatting.py"],
    "TestProduct": ["demo_package/models.py"],
    "TestPremiumProduct": ["demo_package/models.py"],
    "TestInventory": ["demo_package/inventory.py"],
    "TestOrderLine": ["demo_package/orders.py"],
    "TestOrder": ["demo_package/orders.py"],
    "TestReports": ["demo_package/reports.py"],
    "TestPricing": ["demo_package/sub/pricing.py"],
}


def run_mutation_test(mutation: dict, workspace: str) -> dict:
    """Apply a mutation, run tests, record failures, restore."""
    filepath = os.path.join(workspace, mutation["file"])
    original = Path(filepath).read_text()

    # Apply mutation
    mutated = original.replace(mutation["old"], mutation["new"])
    if mutated == original:
        return {"error": f"Mutation pattern not found in {mutation['file']}"}
    Path(filepath).write_text(mutated)

    # Clear ALL __pycache__ under workspace to ensure fresh imports
    subprocess.run(
        ["find", workspace, "-type", "d", "-name", "__pycache__", "-exec", "rm", "-rf", "{}", "+"],
        capture_output=True
    )

    # Run pytest with cache disabled in a SEPARATE subprocess
    env = os.environ.copy()
    env["PYTHONPATH"] = workspace
    result = subprocess.run(
        [sys.executable, "-m", "pytest",
         os.path.join(workspace, "tests/test_demo_package.py"),
         "-v", "--tb=line", "-p", "no:cacheprovider"],
        capture_output=True, text=True, env=env, cwd=workspace
    )

    # Restore original
    Path(filepath).write_text(original)

    # Parse failed tests from pytest summary section
    # The summary section starts with "FAILED tests/..." lines (no percentage)
    failed_tests = []
    failed_modules = set()
    seen_ids = set()
    for line in result.stdout.split("\n"):
        line = line.strip()
        # Match both formats:
        # "FAILED tests/test_demo_package.py::TestClass::test_method - ..."
        # "tests/test_demo_package.py::TestClass::test_method FAILED [ xx%]"
        if "FAILED" not in line:
            continue
        # Extract test ID (the path::class::method part)
        if line.startswith("FAILED "):
            # Summary line format
            test_id = line.split("FAILED ")[1].split(" - ")[0].strip()
        elif " FAILED" in line:
            # Verbose inline format
            test_id = line.split(" FAILED")[0].strip()
        else:
            continue

        if test_id in seen_ids:
            continue
        seen_ids.add(test_id)
        failed_tests.append(test_id)

        for cls_name, files in TEST_FILE_MAP.items():
            if cls_name in test_id:
                for f in files:
                    rel = f.replace("demo_package/", "")
                    failed_modules.add(rel)
                break

    return {
        "symbol": mutation["symbol"],
        "description": mutation["description"],
        "failed_tests": failed_tests,
        "failed_test_count": len(failed_tests),
        "ground_truth_files": sorted(failed_modules),
        "exit_code": result.returncode,
    }


def files_from_oracle(report, threshold=0.1):
    """Extract file set from an oracle impact report."""
    return set(report.impacted_files)


def compute_precision_recall(predicted: set, actual: set) -> dict:
    """Compute precision, recall, F1 between predicted and actual sets."""
    if not predicted and not actual:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0, "predicted": 0, "actual": 0}
    if not predicted:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "predicted": 0, "actual": len(actual)}
    if not actual:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "predicted": len(predicted), "actual": 0}

    tp = len(predicted & actual)
    precision = tp / len(predicted) if predicted else 0
    recall = tp / len(actual) if actual else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "tp": tp,
        "fp": len(predicted - actual),
        "fn": len(actual - predicted),
        "predicted": len(predicted),
        "actual": len(actual),
    }


def main():
    workspace = os.path.dirname(os.path.abspath(__file__))

    # Build world model
    print("Building world model...")
    wm = WorldModel(
        os.path.join(workspace, "demo_package"),
        cache_dir="/tmp/impact_oracle_eval_cache"
    )
    stats = wm.build(incremental=False)
    print(f"World model: {stats['nodes']} nodes, {stats['edges']} edges")

    oracle = ImpactOracle(wm)
    results = []

    for mut in MUTATIONS:
        print(f"\n{'='*60}")
        print(f"Mutating: {mut['symbol']}")
        print(f"  {mut['description']}")

        # 1. Get mutation ground truth
        gt = run_mutation_test(mut, workspace)
        if "error" in gt:
            print(f"  ERROR: {gt['error']}")
            continue
        print(f"  Failed tests: {gt['failed_test_count']}")
        print(f"  Ground truth files: {gt['ground_truth_files']}")

        # 2. Oracle prediction
        report = oracle.predict_impact(mut["symbol"], threshold=0.1)
        oracle_files = files_from_oracle(report)
        print(f"  Oracle predicted files: {sorted(oracle_files)}")

        # 3. Grep baseline
        grep_files = ImpactOracle.grep_baseline(mut["symbol"], os.path.join(workspace, "demo_package"))
        print(f"  Grep baseline files: {sorted(grep_files)}")

        # 4. Edited-file-only baseline
        edited_files = ImpactOracle.edited_file_baseline(mut["symbol"], wm.graph)
        print(f"  Edited-file-only baseline: {sorted(edited_files)}")

        # 5. Compare
        gt_set = set(gt["ground_truth_files"])

        oracle_pr = compute_precision_recall(oracle_files, gt_set)
        grep_pr = compute_precision_recall(grep_files, gt_set)
        edited_pr = compute_precision_recall(edited_files, gt_set)

        print(f"\n  Oracle:      P={oracle_pr['precision']:.3f}  R={oracle_pr['recall']:.3f}  F1={oracle_pr['f1']:.3f}")
        print(f"  Grep:        P={grep_pr['precision']:.3f}  R={grep_pr['recall']:.3f}  F1={grep_pr['f1']:.3f}")
        print(f"  Edited-only: P={edited_pr['precision']:.3f}  R={edited_pr['recall']:.3f}  F1={edited_pr['f1']:.3f}")

        results.append({
            "symbol": mut["symbol"],
            "description": mut["description"],
            "ground_truth": gt,
            "oracle": {
                "predicted_files": sorted(oracle_files),
                "impacted_symbols": len(report.impacted),
                **oracle_pr,
            },
            "grep_baseline": {
                "predicted_files": sorted(grep_files),
                **grep_pr,
            },
            "edited_file_baseline": {
                "predicted_files": sorted(edited_files),
                **edited_pr,
            },
        })

    # Compute averages
    avg = lambda key, method: sum(r[method][key] for r in results) / len(results) if results else 0
    summary = {
        "oracle_avg": {
            "precision": round(avg("precision", "oracle"), 4),
            "recall": round(avg("recall", "oracle"), 4),
            "f1": round(avg("f1", "oracle"), 4),
        },
        "grep_avg": {
            "precision": round(avg("precision", "grep_baseline"), 4),
            "recall": round(avg("recall", "grep_baseline"), 4),
            "f1": round(avg("f1", "grep_baseline"), 4),
        },
        "edited_file_avg": {
            "precision": round(avg("precision", "edited_file_baseline"), 4),
            "recall": round(avg("recall", "edited_file_baseline"), 4),
            "f1": round(avg("f1", "edited_file_baseline"), 4),
        },
        "graph_size": {
            "nodes": stats["nodes"],
            "edges": stats["edges"],
            "files": stats["files_total"],
        },
    }

    print(f"\n{'='*60}")
    print("AVERAGES:")
    print(f"  Oracle:      P={summary['oracle_avg']['precision']:.3f}  R={summary['oracle_avg']['recall']:.3f}  F1={summary['oracle_avg']['f1']:.3f}")
    print(f"  Grep:        P={summary['grep_avg']['precision']:.3f}  R={summary['grep_avg']['recall']:.3f}  F1={summary['grep_avg']['f1']:.3f}")
    print(f"  Edited-only: P={summary['edited_file_avg']['precision']:.3f}  R={summary['edited_file_avg']['recall']:.3f}  F1={summary['edited_file_avg']['f1']:.3f}")

    output = {"per_symbol": results, "summary": summary}
    with open("eval_results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nResults saved to eval_results.json")
    return output


if __name__ == "__main__":
    main()
