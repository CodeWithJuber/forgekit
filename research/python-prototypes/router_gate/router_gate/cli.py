"""Command-line interface for production router_gate workflows."""
from __future__ import annotations

import argparse
import json
import sys
from typing import Optional

from .config import load_config, serialize_ladder
from .executors import external_command_executor
from .gate import assess
from .pipeline import run
from .router import route
from .serialization import result_to_dict, to_jsonable


def _read_task(args) -> str:
    if args.task is not None:
        return args.task
    if args.file:
        with open(args.file, "r", encoding="utf-8") as handle:
            return handle.read()
    return sys.stdin.read()


def _print(data: dict, *, pretty: bool) -> None:
    if pretty:
        print(json.dumps(data, indent=2, sort_keys=True))
    else:
        print(json.dumps(data, separators=(",", ":"), sort_keys=True))


def _add_task_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("task", nargs="?", help="task text; if omitted, stdin is used")
    parser.add_argument("--file", "-f", help="read task text from a file")


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", help="TOML config file")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="router-gate", description="Assumption gate + complexity router for agentic coding workflows")
    _add_common_args(parser)
    sub = parser.add_subparsers(dest="command", required=True)

    p_assess = sub.add_parser("assess", help="score specification completeness and clarifying questions")
    _add_task_args(p_assess)

    p_route = sub.add_parser("route", help="score task complexity and choose cheap/mid/premium")
    _add_task_args(p_route)

    p_decide = sub.add_parser("decide", help="run gate and route without executing a model")
    _add_task_args(p_decide)

    p_run = sub.add_parser("run", help="gate, route, execute an external command, verify only by command success")
    _add_task_args(p_run)
    p_run.add_argument("--executor-command", help="command to call; task is stdin, model in ROUTER_GATE_MODEL_ID; supports {model}")
    p_run.add_argument("--timeout", type=float, help="executor timeout in seconds")
    p_run.add_argument("--no-escalation", action="store_true", help="disable tier escalation")

    p_config = sub.add_parser("config", help="show effective runtime configuration")
    return parser


def command_assess(args) -> dict:
    config = load_config(args.config)
    report = assess(_read_task(args), ask_threshold=config.ask_threshold)
    return {"ok": True, "assumption": to_jsonable(report)}


def command_route(args) -> dict:
    decision = route(_read_task(args))
    return {"ok": True, "routing": to_jsonable(decision)}


def command_decide(args) -> dict:
    config = load_config(args.config)
    task = _read_task(args)
    report = assess(task, ask_threshold=config.ask_threshold)
    payload = {"ok": True, "assumption": to_jsonable(report), "halted_for_questions": report.should_ask}
    if not report.should_ask:
        payload["routing"] = to_jsonable(route(task))
    return payload


def command_run(args) -> dict:
    config = load_config(args.config)
    command = args.executor_command or config.executor_command
    if not command:
        return {"ok": False, "error": "missing executor command; pass --executor-command or ROUTER_GATE_EXECUTOR_COMMAND"}
    timeout = args.timeout if args.timeout is not None else config.executor_timeout_seconds
    executor = external_command_executor(command, timeout_seconds=timeout)
    try:
        result = run(
            _read_task(args),
            executor,
            ladder=list(config.ladder),
            ask_threshold=config.ask_threshold,
            allow_escalation=(not args.no_escalation and config.allow_escalation),
        )
    except Exception as exc:  # keep CLI contract JSON-safe for agents
        return {"ok": False, "error": str(exc), "type": exc.__class__.__name__}
    return {"ok": True, "result": result_to_dict(result)}


def command_config(args) -> dict:
    config = load_config(args.config)
    return {
        "ok": True,
        "config": {
            "ask_threshold": config.ask_threshold,
            "allow_escalation": config.allow_escalation,
            "executor_command": config.executor_command,
            "executor_timeout_seconds": config.executor_timeout_seconds,
            "ladder": serialize_ladder(config.ladder),
        },
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "assess": command_assess,
        "route": command_route,
        "decide": command_decide,
        "run": command_run,
        "config": command_config,
    }
    try:
        payload = handlers[args.command](args)
    except Exception as exc:
        payload = {"ok": False, "error": str(exc), "type": exc.__class__.__name__}
    _print(payload, pretty=args.pretty)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
