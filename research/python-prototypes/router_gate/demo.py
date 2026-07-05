"""Demo: run a handful of tasks through the gate->route->execute->verify loop.

Offline by default (deterministic stub executor, no tokens spent), so it runs
anywhere. Prints, for each task, the gate decision, the routed tier, and the cost
versus an always-premium baseline.

    python demo.py

The point of the demo is to make the two mechanisms legible in a few lines:
  - under-specified tasks HALT with concrete questions (M2: don't confabulate);
  - well-specified tasks ROUTE to the cheapest capable tier (M1: don't overpay).
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from router_gate import route, assess, run, always_premium_cost
from router_gate.pricing import DEFAULT_LADDER


def stub_executor(task, model_id):
    itok = max(20, len(task) // 3)
    otok = max(30, len(task) // 2)
    return (f"[stub answer from {model_id}]", itok, otok)


EXAMPLES = [
    "Write a Python function is_prime(n). is_prime(7) -> True, is_prime(8) -> False.",
    "Implement an LRU cache class with get and put, O(1), capacity fixed at construction. Python.",
    "Design and implement a thread-safe bounded blocking queue in Python supporting put() and "
    "get() from multiple producer and consumer threads, with proper condition-variable signaling "
    "and no busy-waiting. Include tests for the empty and full boundary conditions.",
    "Fix the bug.",
    "Optimize it.",
]


def main():
    print("=" * 74)
    print("Complexity-aware router + assumption gate  --  offline demo")
    print("=" * 74)
    total_routed = total_premium = 0.0
    for task in EXAMPLES:
        res = run(task, stub_executor, ladder=DEFAULT_LADDER)
        print(f"\nTASK: {task}")
        if res.halted_for_questions:
            print(f"  GATE: HALT (completeness={res.assumption.completeness:.2f}, "
                  f"risk={res.assumption.risk}) -- asking instead of guessing:")
            for q in res.assumption.questions:
                print(f"        ? {q}")
        else:
            print(f"  GATE: proceed (completeness={res.assumption.completeness:.2f})")
            print(f"  ROUTE: {res.routing.tier}  (score={res.routing.score:.1f})")
            print(f"         {'; '.join(w for _, w in res.routing.reasons[1:4])}")
            print(f"  RAN on: {res.final_tier}  cost=${res.total_cost:.6f}  "
                  f"(always-premium would be ${always_premium_cost(res):.6f})")
            total_routed += res.total_cost
            total_premium += always_premium_cost(res)

    if total_premium:
        saved = 100 * (total_premium - total_routed) / total_premium
        print("\n" + "-" * 74)
        print(f"Executed tasks: routed ${total_routed:.6f} vs premium ${total_premium:.6f}  "
              f"->  {saved:.0f}% saved")
    print("\n(For live numbers on real models: python evaluate.py --live)")


if __name__ == "__main__":
    main()
