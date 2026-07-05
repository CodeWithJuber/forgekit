"""Minimal MCP-compatible stdio server for router_gate.

This implements the JSON-RPC surface needed by MCP clients such as Claude Code:
initialize, tools/list, tools/call, notifications/initialized, and ping. It stays
stdlib-only so the package can be installed anywhere without native deps.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Optional

from .config import load_config
from .gate import assess
from .router import route
from .serialization import to_jsonable

SERVER_NAME = "router-gate"
SERVER_VERSION = "0.2.0"


TOOLS = [
    {
        "name": "assess_task",
        "description": "Score whether a coding task is sufficiently specified; returns risk, missing dimensions, and clarifying questions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "Task/request text"},
                "ask_threshold": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["task"],
            "additionalProperties": False,
        },
    },
    {
        "name": "route_task",
        "description": "Choose the cheapest capable model tier for a well-specified coding task and explain the decision.",
        "inputSchema": {
            "type": "object",
            "properties": {"task": {"type": "string", "description": "Task/request text"}},
            "required": ["task"],
            "additionalProperties": False,
        },
    },
    {
        "name": "decide_task",
        "description": "Run the assumption gate; if safe to proceed, also return the routing tier.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "Task/request text"},
                "ask_threshold": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["task"],
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


def _call_tool(name: str, arguments: dict) -> dict:
    config = load_config()
    task = arguments.get("task")
    if not isinstance(task, str) or not task.strip():
        raise ValueError("argument 'task' must be a non-empty string")
    threshold = float(arguments.get("ask_threshold", config.ask_threshold))
    if not 0 <= threshold <= 1:
        raise ValueError("ask_threshold must be between 0 and 1")

    if name == "assess_task":
        return _content({"assumption": to_jsonable(assess(task, ask_threshold=threshold))})
    if name == "route_task":
        return _content({"routing": to_jsonable(route(task))})
    if name == "decide_task":
        report = assess(task, ask_threshold=threshold)
        payload = {"assumption": to_jsonable(report), "halted_for_questions": report.should_ask}
        if not report.should_ask:
            payload["routing"] = to_jsonable(route(task))
        return _content(payload)
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


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
