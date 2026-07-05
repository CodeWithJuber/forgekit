"""The decision loop: gate -> route -> execute -> verify -> escalate.

This composes the two mechanisms into one control flow that embodies the paper's
thesis at the level of a single request:

    1. ASSUMPTION GATE (M2)  - is the request specified enough to act on? If not,
                               HALT and return questions. (Do not guess.)
    2. ROUTE (M1)            - score complexity, pick the cheapest capable tier.
    3. EXECUTE               - run on that tier (pluggable executor; host.llm in prod,
                               a deterministic stub in tests).
    4. VERIFY (external)     - check the output with a caller-supplied predicate
                               (a test, a compile, a regex). Trust is earned here,
                               not asserted by the model.
    5. ESCALATE             - only if verification fails, retry one tier up. Bounded
                               by the tier ladder, so worst case is a small constant.

Every call's measured token usage and computed cost is recorded, so the harness can
report REAL tokens/cost saved versus an always-premium baseline -- not an estimate.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Callable, Optional
from .router import route, next_tier, RoutingDecision
from .gate import assess, AssumptionReport
from .pricing import DEFAULT_LADDER, tier_by_name


@dataclass
class CallRecord:
    tier: str
    model_id: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    verified: bool
    error: Optional[str] = None


@dataclass
class PipelineResult:
    task: str
    halted_for_questions: bool
    assumption: AssumptionReport
    routing: Optional[RoutingDecision] = None
    output: Optional[str] = None
    calls: list = field(default_factory=list)     # list[CallRecord]
    final_tier: Optional[str] = None
    success: bool = False

    @property
    def total_cost(self) -> float:
        return sum(c.cost_usd for c in self.calls)

    @property
    def total_tokens(self) -> int:
        return sum(c.input_tokens + c.output_tokens for c in self.calls)


# An executor takes (task, model_id) and returns (text, input_tokens, output_tokens).
Executor = Callable[[str, str], tuple]
# A verifier takes (task, output_text) and returns True if the output passes.
Verifier = Callable[[str, str], bool]


def host_llm_executor(host):
    """Production executor backed by host.llm, returning real measured token usage."""
    def _exec(task: str, model_id: str):
        r = host.llm(task, model=model_id)
        u = r.get("usage", {}) or {}
        return (r.get("text", ""),
                int(u.get("input_tokens", 0)),
                int(u.get("output_tokens", 0)))
    return _exec


def run(task: str,
        executor: Executor,
        *,
        verifier: Optional[Verifier] = None,
        ladder=None,
        ask_threshold: float = 0.6,
        allow_escalation: bool = True) -> PipelineResult:
    """Run one task through the full gate->route->execute->verify->escalate loop."""
    ladder = ladder or DEFAULT_LADDER

    # --- 1. assumption gate ---
    ar = assess(task, ask_threshold=ask_threshold)
    if ar.should_ask:
        # HALT: do not spend a single token confabulating past the missing spec.
        return PipelineResult(task=task, halted_for_questions=True, assumption=ar,
                              success=False)

    # --- 2. route ---
    rd = route(task)
    res = PipelineResult(task=task, halted_for_questions=False, assumption=ar, routing=rd)

    # --- 3-5. execute, verify, escalate ---
    tier_name = rd.tier
    while tier_name is not None:
        tier = tier_by_name(ladder, tier_name)
        text = ""
        itok = otok = 0
        error = None
        try:
            text, itok, otok = executor(task, tier.model_id)
            ok = True if verifier is None else bool(verifier(task, text))
        except Exception as exc:
            ok = False
            error = f"{exc.__class__.__name__}: {exc}"
        res.calls.append(CallRecord(tier.name, tier.model_id, itok, otok,
                                    tier.cost(itok, otok), ok, error))
        res.output = text
        res.final_tier = tier.name
        if ok:
            res.success = True
            break
        if not allow_escalation:
            break
        tier_name = next_tier(tier_name)   # escalate one tier up, or None -> stop

    return res


def always_premium_cost(records_or_result, ladder=None) -> float:
    """Counterfactual: what would this task have cost if every call went to premium?

    Uses the SAME measured token counts, repriced at the premium tier -- an honest
    apples-to-apples baseline for 'tokens/cost saved by routing'.
    """
    ladder = ladder or DEFAULT_LADDER
    premium = ladder[-1]
    calls = records_or_result.calls if isinstance(records_or_result, PipelineResult) else records_or_result
    return sum(premium.cost(c.input_tokens, c.output_tokens) for c in calls)
