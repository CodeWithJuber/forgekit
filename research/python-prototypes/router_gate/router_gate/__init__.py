"""router_gate -- a complexity-aware model router + assumption/uncertainty gate.

Two mechanisms from 'A Cognitive Substrate for Coding Agents' (Theory -> Evidence ->
Build-Map edition), made runnable:

  M1 Complexity-aware routing  (router.py)  -- don't pay premium rates for trivial tasks.
  M2 Assumption/uncertainty gate (gate.py)  -- halt and ask instead of confabulating.

Composed by pipeline.run(): gate -> route -> execute -> verify -> escalate.
"""
from .router import route, RoutingDecision, extract_signals, score_complexity, band
from .gate import assess, AssumptionReport
from .pipeline import run, PipelineResult, host_llm_executor, always_premium_cost
from .pricing import DEFAULT_LADDER, ladder_from_available, Tier
from .config import RouterGateConfig, load_config
from .executors import external_command_executor

__all__ = [
    "route", "RoutingDecision", "extract_signals", "score_complexity", "band",
    "assess", "AssumptionReport",
    "run", "PipelineResult", "host_llm_executor", "always_premium_cost",
    "DEFAULT_LADDER", "ladder_from_available", "Tier",
    "RouterGateConfig", "load_config", "external_command_executor",
]
__version__ = "0.2.0"
