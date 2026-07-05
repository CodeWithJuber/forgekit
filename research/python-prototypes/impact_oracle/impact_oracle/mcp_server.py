"""Minimal MCP-compatible stdio server for Impact Oracle."""
from __future__ import annotations

import json
import sys
from typing import Any, Optional

from impact_oracle.oracle import ImpactOracle
from impact_oracle.world_model import WorldModel

SERVER_NAME = "impact-oracle"
SERVER_VERSION = "0.2.0"

TOOLS = [
    {
        "name": "build_world_model",
        "description": "Parse a Python codebase and build/update its structural dependency graph.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "description": "Codebase root directory"},
                "cache_dir": {"type": "string", "description": "Optional cache directory"},
                "incremental": {"type": "boolean", "description": "Reuse unchanged cached files", "default": True},
            },
            "required": ["root"],
            "additionalProperties": False,
        },
    },
    {
        "name": "predict_impact",
        "description": "Predict blast radius for changing a qualified Python symbol.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "description": "Codebase root directory"},
                "symbol": {"type": "string", "description": "Qualified symbol name"},
                "threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.1},
                "cache_dir": {"type": "string", "description": "Optional cache directory"},
            },
            "required": ["root", "symbol"],
            "additionalProperties": False,
        },
    },
    {
        "name": "world_model_summary",
        "description": "Return graph summary for a Python codebase world model.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "description": "Codebase root directory"},
                "cache_dir": {"type": "string", "description": "Optional cache directory"},
            },
            "required": ["root"],
            "additionalProperties": False,
        },
    },
]


def _content(payload: Any) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, sort_keys=True)}]}


def _error(request_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _result(request_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _world_model(root: str, cache_dir: Optional[str] = None) -> WorldModel:
    if not isinstance(root, str) or not root.strip():
        raise ValueError("argument 'root' must be a non-empty string")
    return WorldModel(root, cache_dir=cache_dir)


def _call_tool(name: str, arguments: dict) -> dict:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    root = arguments.get("root")
    cache_dir = arguments.get("cache_dir")
    wm = _world_model(root, cache_dir=cache_dir if isinstance(cache_dir, str) else None)

    if name == "build_world_model":
        stats = wm.build(incremental=bool(arguments.get("incremental", True)))
        return _content({"stats": stats})
    if name == "predict_impact":
        symbol = arguments.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            raise ValueError("argument 'symbol' must be a non-empty string")
        threshold = float(arguments.get("threshold", 0.1))
        if not 0 <= threshold <= 1:
            raise ValueError("threshold must be between 0 and 1")
        wm.build(incremental=True)
        report = ImpactOracle(wm).predict_impact(symbol, threshold=threshold)
        return _content({"impact": report.to_dict()})
    if name == "world_model_summary":
        wm.build(incremental=True)
        return _content({"summary": wm.summary()})
    raise ValueError(f"unknown tool: {name}")


def handle(message: dict) -> Optional[dict]:
    method = message.get("method")
    request_id = message.get("id")
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        return _result(request_id, {
            "protocolVersion": message.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        return _result(request_id, {"tools": TOOLS})
    if method == "tools/call":
        params = message.get("params", {})
        if not isinstance(params, dict):
            return _error(request_id, -32602, "params must be an object")
        try:
            return _result(request_id, _call_tool(str(params.get("name", "")), params.get("arguments", {}) or {}))
        except Exception as exc:
            return _error(request_id, -32000, str(exc))
    if request_id is None:
        return None
    return _error(request_id, -32601, f"method not found: {method}")


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("message must be a JSON object")
            response = handle(message)
        except Exception as exc:
            response = _error(None, -32700, str(exc))
        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
