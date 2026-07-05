"""Unit tests for the router, the gate, and the composed pipeline.

Offline and deterministic: the executor is a stub, so no tokens are spent and the
suite runs in milliseconds. These check the MECHANISM's logic, not model quality.
"""
import pytest
from router_gate import route, assess, run, always_premium_cost
from router_gate.router import band, score_complexity, extract_signals, next_tier
from router_gate.gate import assess as gate_assess
from router_gate.pricing import DEFAULT_LADDER, ladder_from_available
from router_gate import taskset


# ---------------- router ----------------

def test_trivial_task_routes_cheap():
    d = route("Write a Python function is_prime(n). is_prime(7) -> True.")
    assert d.tier == "cheap", d.explain()

def test_complex_task_routes_premium():
    d = route("Design and implement a thread-safe bounded blocking queue with "
              "condition-variable signaling, multiple producers and consumers, and "
              "no busy-waiting. Include tests for empty and full boundaries.")
    assert d.tier == "premium", d.explain()

def test_moderate_task_routes_mid():
    d = route("Implement an LRU cache class with get and put, capacity fixed at "
              "construction, O(1) operations, with a docstring.")
    assert d.tier in ("mid", "premium"), d.explain()

def test_routing_is_explainable():
    d = route("Reverse a string. 'abc' -> 'cba'.")
    assert d.reasons and all(len(r) == 2 for r in d.reasons)
    assert "tier=" in d.explain()

def test_band_thresholds_monotone():
    assert band(0.0) == "cheap"
    assert band(4.0) == "mid"
    assert band(10.0) == "premium"

def test_next_tier_escalation_path():
    assert next_tier("cheap") == "mid"
    assert next_tier("mid") == "premium"
    assert next_tier("premium") is None


# ---------------- gate ----------------

def test_underspecified_task_triggers_ask():
    r = assess("Fix the bug.")
    assert r.should_ask is True
    assert r.questions, "expected clarifying questions"
    assert r.risk in ("high", "medium")

def test_wellspecified_task_does_not_ask():
    r = assess("Write a Python function is_even(n) that returns True if n is even. "
               "Example: is_even(4) -> True.")
    assert r.should_ask is False, r.explain()

def test_vague_words_lower_completeness():
    concrete = assess("Write add(a, b) in Python returning a+b. add(2,3) -> 5.")
    vague = assess("Handle the data appropriately and make it work properly.")
    assert vague.completeness < concrete.completeness

def test_questions_are_capped():
    r = assess("Do the thing.")
    assert len(r.questions) <= 3

def test_gate_is_explainable():
    r = assess("Optimize it.")
    assert "completeness=" in r.explain()


# ---------------- pipeline ----------------

def _stub_executor(fixed_tokens=(100, 50)):
    """Deterministic executor: returns canned text and fixed token counts."""
    def _exec(task, model_id):
        return (f"[output for {model_id[:12]}]", fixed_tokens[0], fixed_tokens[1])
    return _exec

def test_pipeline_halts_on_underspecified():
    res = run("Fix the bug.", _stub_executor())
    assert res.halted_for_questions is True
    assert res.success is False
    assert res.calls == []          # spent zero calls -- did not confabulate
    assert res.assumption.questions

def test_pipeline_runs_wellspecified_on_cheap():
    res = run("Write is_prime(n) in Python. is_prime(7) -> True, is_prime(8) -> False.",
              _stub_executor())
    assert res.halted_for_questions is False
    assert res.final_tier == "cheap"
    assert res.success is True
    assert len(res.calls) == 1

def test_pipeline_escalates_on_failed_verification():
    # verifier always fails on cheap+mid output, passes only at premium
    def verifier(task, out):
        return "opus" in out
    res = run("Write a Python function is_even(n) that returns True for even n. "
              "is_even(4) -> True, is_even(3) -> False.", _stub_executor(), verifier=verifier)
    # should have climbed the ladder to premium
    assert res.final_tier == "premium"
    assert [c.tier for c in res.calls] == ["cheap", "mid", "premium"]
    assert res.success is True

def test_pipeline_no_escalation_when_disabled():
    def verifier(task, out):
        return False
    res = run("Write a Python function reverse(s) that reverses a string. "
              "reverse('ab') -> 'ba'.", _stub_executor(),
              verifier=verifier, allow_escalation=False)
    assert len(res.calls) == 1
    assert res.success is False

def test_cost_savings_vs_premium_baseline():
    res = run("Write factorial(n). factorial(5) -> 120.", _stub_executor())
    routed = res.total_cost
    baseline = always_premium_cost(res)
    # routed to cheap tier, so it must cost strictly less than the premium counterfactual
    assert routed < baseline
    assert routed > 0 and baseline > 0


# ---------------- pricing ----------------

def test_ladder_adapts_to_available_models():
    avail = ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"]
    lad = ladder_from_available(avail)
    assert lad[0].model_id == "claude-haiku-4-5-20251001"
    assert "sonnet" in lad[1].model_id
    assert "opus" in lad[2].model_id

def test_cost_is_arithmetic_on_tokens():
    t = DEFAULT_LADDER[0]
    assert t.cost(1_000_000, 0) == pytest.approx(t.usd_in_per_mtok)
    assert t.cost(0, 1_000_000) == pytest.approx(t.usd_out_per_mtok)


# ---------------- taskset sanity ----------------

def test_taskset_wellformed():
    ts = taskset.load()
    assert len(ts) >= 25
    assert all(x["gold_tier"] in ("cheap", "mid", "premium") for x in ts)
    assert any(x["gold_ask"] for x in ts) and any(not x["gold_ask"] for x in ts)

# ---------------- production surfaces ----------------

def test_pipeline_records_executor_failure_and_escalates():
    attempts = []
    def flaky_executor(task, model_id):
        attempts.append(model_id)
        if len(attempts) == 1:
            raise RuntimeError("temporary provider failure")
        return ("ok", 10, 5)

    res = run("Write is_even(n) in Python. is_even(4) -> True.", flaky_executor)
    assert res.success is True
    assert len(res.calls) == 2
    assert res.calls[0].verified is False
    assert "temporary provider failure" in res.calls[0].error
    assert res.calls[1].verified is True


def test_external_command_executor_parses_json(tmp_path):
    from router_gate.executors import external_command_executor

    script = tmp_path / "executor.py"
    script.write_text(
        "import json, os, sys\n"
        "task = sys.stdin.read()\n"
        "print(json.dumps({'text': os.environ['ROUTER_GATE_MODEL_ID'] + ':' + task, 'input_tokens': 3, 'output_tokens': 4}))\n"
    )
    executor = external_command_executor(f"python {script}", timeout_seconds=5)
    text, input_tokens, output_tokens = executor("hello", "test-model")
    assert text == "test-model:hello"
    assert input_tokens == 3
    assert output_tokens == 4


def test_cli_decide_outputs_json(capsys):
    from router_gate.cli import main

    code = main(["--pretty", "decide", "Fix the bug."])
    out = capsys.readouterr().out
    payload = __import__("json").loads(out)
    assert code == 0
    assert payload["ok"] is True
    assert payload["halted_for_questions"] is True
    assert payload["assumption"]["questions"]


def test_mcp_tools_call_decide_task():
    from router_gate.mcp_server import handle

    response = handle({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "decide_task", "arguments": {"task": "Fix the bug."}},
    })
    assert response["id"] == 1
    text = response["result"]["content"][0]["text"]
    assert "halted_for_questions" in text
    assert "questions" in text
