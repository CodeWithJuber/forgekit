"""JSON-safe serializers for router_gate public objects."""
from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any


def to_jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return to_jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    return value


def result_to_dict(result) -> dict:
    data = to_jsonable(result)
    data["total_cost"] = result.total_cost
    data["total_tokens"] = result.total_tokens
    return data
