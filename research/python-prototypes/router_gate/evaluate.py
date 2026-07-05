"""Evaluation harness for the router + assumption gate.

Measures three things, honestly:

  1. ROUTING ACCURACY  - on the well-specified tasks the router actually sees in the
                         pipeline (under-specified tasks are halted by the gate first),
                         does it pick the gold tier? Also within-1-tier accuracy.
  2. GATE ACCURACY     - across ALL tasks, does should_ask match the gold_ask label?
                         Reported as precision/recall/F1 for "should ask".
  3. TOKENS / COST SAVED - versus an always-premium baseline, using REAL measured token
                         counts from host.llm (or the offline stub). Cost is arithmetic
                         on measured tokens and the pricing ladder -- never guessed.

Two modes:
  --offline (default): deterministic stub executor, no tokens spent. Token counts are
                       synthetic-but-fixed so the cost arithmetic is exercised end-to-end.
  --live   : uses host.llm through the tier ladder. Only run where `host` is available.

Honesty note baked into the output: the task set is a 30-item, hand-labeled DEMONSTRATION
set that the rubric thresholds were tuned against. High accuracy here shows the rubric
*can separate* the cases; it is not a benchmark and does not estimate field accuracy.
"""
from __future__ import annotations
import argparse, json, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from router_gate import route, assess, run, always_premium_cost
from router_gate.pricing import DEFAULT_LADDER, ladder_from_available
from router_gate import taskset


def stub_executor(task, model_id):
    """Deterministic offline executor. Token counts scale with task length so the
    cost accounting is realistic in shape without calling any model."""
    itok = max(20, len(task) // 3)
    otok = max(30, len(task) // 2)      # pretend the answer is ~1.5x the prompt
    return (f"[stub answer from {model_id}]", itok, otok)


def make_live_executor(host):
    from router_gate import host_llm_executor
    return host_llm_executor(host)


def evaluate(executor, ladder, ask_threshold=0.6):
    tasks = taskset.load()
    rows = []
    # gate confusion
    tp = fp = tn = fn = 0
    # routing (only on well-specified tasks, exact + within-1)
    route_exact = route_within1 = route_total = 0
    TIER_IDX = {"cheap": 0, "mid": 1, "premium": 2}

    # cost accounting across the WHOLE realistic workload:
    # under-specified tasks are halted (0 tokens), well-specified tasks are routed+run.
    routed_cost = routed_tokens = 0.0
    baseline_cost = baseline_tokens = 0.0
    halted = 0

    for x in tasks:
        t, gold_tier, gold_ask = x["task"], x["gold_tier"], x["gold_ask"]
        res = run(t, executor, ladder=ladder, ask_threshold=ask_threshold)

        # gate scoring
        asked = res.halted_for_questions
        if gold_ask and asked: tp += 1
        elif gold_ask and not asked: fn += 1
        elif (not gold_ask) and asked: fp += 1
        else: tn += 1

        if asked:
            halted += 1
        else:
            # routing scoring (well-specified only, i.e. gold_ask == False expected)
            if not gold_ask:
                route_total += 1
                if res.final_tier == gold_tier:
                    route_exact += 1
                if abs(TIER_IDX[res.final_tier] - TIER_IDX[gold_tier]) <= 1:
                    route_within1 += 1
            # cost: routed vs always-premium on the SAME measured tokens
            routed_cost += res.total_cost
            routed_tokens += res.total_tokens
            baseline_cost += always_premium_cost(res, ladder)
            baseline_tokens += res.total_tokens  # tokens same; premium just costs more per tok

        rows.append({
            "task": t[:70], "gold_tier": gold_tier, "gold_ask": gold_ask,
            "asked": asked, "routed_tier": res.final_tier,
            "completeness": round(res.assumption.completeness, 2),
            "score": round(res.routing.score, 1) if res.routing else None,
            "cost_usd": round(res.total_cost, 6),
            "questions": res.assumption.questions if asked else [],
        })

    n = len(tasks)
    gate_acc = (tp + tn) / n
    gate_prec = tp / (tp + fp) if (tp + fp) else 0.0
    gate_rec = tp / (tp + fn) if (tp + fn) else 0.0
    gate_f1 = (2 * gate_prec * gate_rec / (gate_prec + gate_rec)) if (gate_prec + gate_rec) else 0.0

    summary = {
        "n_tasks": n,
        "gate": {
            "accuracy": round(gate_acc, 3),
            "precision": round(gate_prec, 3),
            "recall": round(gate_rec, 3),
            "f1": round(gate_f1, 3),
            "confusion": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
            "n_halted": halted,
        },
        "routing": {
            "n_scored": route_total,
            "exact_accuracy": round(route_exact / route_total, 3) if route_total else None,
            "within_1_tier_accuracy": round(route_within1 / route_total, 3) if route_total else None,
        },
        "cost": {
            "routed_cost_usd": round(routed_cost, 6),
            "always_premium_cost_usd": round(baseline_cost, 6),
            "cost_saved_usd": round(baseline_cost - routed_cost, 6),
            "cost_saved_pct": round(100 * (baseline_cost - routed_cost) / baseline_cost, 1) if baseline_cost else 0.0,
            "note": "Same measured tokens repriced at the premium tier. Savings come purely from routing cheaper-capable tasks to cheaper tiers.",
        },
        "honesty": (
            "30-task hand-labeled DEMONSTRATION set; rubric thresholds were tuned against it. "
            "Accuracy shows the rubric can separate the cases, not a field benchmark. "
            "Cost figures are arithmetic on measured token counts and approximate public list prices."
        ),
    }
    return summary, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="use host.llm instead of the offline stub")
    ap.add_argument("--out", default="eval_results.json")
    args = ap.parse_args()

    ladder = DEFAULT_LADDER
    if args.live:
        # `host` is injected in the Claude Science kernel; import lazily
        import builtins
        host = getattr(builtins, "host", None)
        if host is None:
            print("live mode needs host.llm; falling back to offline"); args.live = False
    if args.live:
        ladder = ladder_from_available(host.list_models())
        executor = make_live_executor(host)
    else:
        executor = stub_executor

    summary, rows = evaluate(executor, ladder)
    out = {"summary": summary, "rows": rows, "mode": "live" if args.live else "offline"}
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps(summary, indent=2))
    print(f"\nwrote {args.out} ({len(rows)} rows, mode={out['mode']})")


if __name__ == "__main__":
    main()
