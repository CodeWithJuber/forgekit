"""Configuration loading for production router_gate usage.

The package is intentionally dependency-free. Configuration is accepted from:
  1. explicit CLI flags / caller-provided values,
  2. a TOML file, and
  3. environment variables.

Python 3.11+ uses stdlib ``tomllib`` for TOML. On older Python versions, callers can
still use environment variables or pass values directly without installing anything.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from typing import Iterable, Optional

from .pricing import DEFAULT_LADDER, Tier

try:  # pragma: no cover - depends on Python minor version
    import tomllib  # type: ignore[attr-defined]
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None  # type: ignore[assignment]


@dataclass(frozen=True)
class RouterGateConfig:
    """Runtime configuration for the gate/router."""

    ask_threshold: float = 0.6
    allow_escalation: bool = True
    ladder: tuple[Tier, ...] = tuple(DEFAULT_LADDER)
    executor_command: Optional[str] = None
    executor_timeout_seconds: float = 120.0


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {value!r}") from exc


def _tier_from_mapping(name: str, data: dict, fallback: Tier) -> Tier:
    model_id = str(data.get("model_id", fallback.model_id))
    input_price = float(data.get("usd_in_per_mtok", fallback.usd_in_per_mtok))
    output_price = float(data.get("usd_out_per_mtok", fallback.usd_out_per_mtok))
    return Tier(name, model_id, input_price, output_price)


def _ladder_from_mapping(data: dict) -> tuple[Tier, ...]:
    configured = data.get("tiers", {}) if isinstance(data, dict) else {}
    if not isinstance(configured, dict):
        raise ValueError("config field 'tiers' must be a table/object")

    fallback_by_name = {tier.name: tier for tier in DEFAULT_LADDER}
    tiers = []
    for name in ("cheap", "mid", "premium"):
        raw = configured.get(name, {})
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise ValueError(f"config field 'tiers.{name}' must be a table/object")
        tiers.append(_tier_from_mapping(name, raw, fallback_by_name[name]))
    return tuple(tiers)


def load_config(path: Optional[str | os.PathLike[str]] = None) -> RouterGateConfig:
    """Load config from TOML plus environment overrides.

    Environment variables:
      ROUTER_GATE_CONFIG
      ROUTER_GATE_ASK_THRESHOLD
      ROUTER_GATE_ALLOW_ESCALATION
      ROUTER_GATE_EXECUTOR_COMMAND
      ROUTER_GATE_EXECUTOR_TIMEOUT_SECONDS
    """
    raw_path = str(path or os.getenv("ROUTER_GATE_CONFIG", "")).strip()
    data: dict = {}
    if raw_path:
        config_path = Path(raw_path).expanduser()
        if tomllib is None:
            raise RuntimeError("TOML config files require Python 3.11+; use env vars instead")
        with config_path.open("rb") as handle:
            loaded = tomllib.load(handle)
        if not isinstance(loaded, dict):
            raise ValueError("config file must contain a TOML table")
        data = loaded

    ask_threshold = float(data.get("ask_threshold", 0.6))
    allow_escalation = bool(data.get("allow_escalation", True))
    executor_command = data.get("executor_command")
    if executor_command is not None:
        executor_command = str(executor_command)
    executor_timeout = float(data.get("executor_timeout_seconds", 120.0))
    ladder = _ladder_from_mapping(data)

    ask_threshold = _env_float("ROUTER_GATE_ASK_THRESHOLD", ask_threshold)
    allow_escalation = _env_bool("ROUTER_GATE_ALLOW_ESCALATION", allow_escalation)
    executor_command = os.getenv("ROUTER_GATE_EXECUTOR_COMMAND", executor_command)
    executor_timeout = _env_float("ROUTER_GATE_EXECUTOR_TIMEOUT_SECONDS", executor_timeout)

    if not 0.0 <= ask_threshold <= 1.0:
        raise ValueError("ask_threshold must be between 0 and 1")
    if executor_timeout <= 0:
        raise ValueError("executor_timeout_seconds must be positive")

    return RouterGateConfig(
        ask_threshold=ask_threshold,
        allow_escalation=allow_escalation,
        ladder=ladder,
        executor_command=executor_command,
        executor_timeout_seconds=executor_timeout,
    )


def serialize_ladder(ladder: Iterable[Tier]) -> list[dict]:
    """Return JSON-safe tier configuration."""
    return [
        {
            "name": tier.name,
            "model_id": tier.model_id,
            "usd_in_per_mtok": tier.usd_in_per_mtok,
            "usd_out_per_mtok": tier.usd_out_per_mtok,
        }
        for tier in ladder
    ]
