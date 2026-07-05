"""Production executor adapters.

The core pipeline only needs a small callable: ``(task, model_id) ->
(text, input_tokens, output_tokens)``. This module provides hardened adapters for
real agent runtimes while keeping the package dependency-free.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ExecutorError(RuntimeError):
    """Raised when an external executor cannot complete a model call."""

    message: str
    returncode: Optional[int] = None
    stderr: str = ""

    def __str__(self) -> str:
        parts = [self.message]
        if self.returncode is not None:
            parts.append(f"returncode={self.returncode}")
        if self.stderr:
            parts.append(f"stderr={self.stderr[:500]}")
        return " | ".join(parts)


def approximate_tokens(text: str) -> int:
    """Small dependency-free token estimate for executors that do not report usage."""
    return max(1, len(text or "") // 4)


def parse_executor_output(stdout: str, task: str) -> tuple[str, int, int]:
    """Parse executor stdout.

    Preferred stdout is JSON:
      {"text": "...", "input_tokens": 12, "output_tokens": 34}

    Plain text is also accepted; token usage is estimated so cost accounting remains
    conservative and never crashes the routing loop.
    """
    raw = stdout or ""
    stripped = raw.strip()
    if not stripped:
        return "", approximate_tokens(task), 0

    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return raw, approximate_tokens(task), approximate_tokens(raw)

    if not isinstance(parsed, dict):
        return raw, approximate_tokens(task), approximate_tokens(raw)

    text = parsed.get("text", parsed.get("output", ""))
    if text is None:
        text = ""
    text = str(text)
    usage = parsed.get("usage", {}) if isinstance(parsed.get("usage", {}), dict) else {}
    input_tokens = parsed.get("input_tokens", usage.get("input_tokens"))
    output_tokens = parsed.get("output_tokens", usage.get("output_tokens"))

    try:
        input_count = int(input_tokens) if input_tokens is not None else approximate_tokens(task)
        output_count = int(output_tokens) if output_tokens is not None else approximate_tokens(text)
    except (TypeError, ValueError):
        input_count = approximate_tokens(task)
        output_count = approximate_tokens(text)
    return text, max(0, input_count), max(0, output_count)


def external_command_executor(command: str, *, timeout_seconds: float = 120.0, cwd: Optional[str] = None):
    """Create an executor backed by an arbitrary command.

    The task is sent on stdin. ``ROUTER_GATE_MODEL_ID`` is set in the environment.
    If the command contains ``{model}``, it is replaced with a shell-quoted model id.

    This makes router_gate usable with Claude Code wrappers, custom agent CLIs,
    internal gateways, or any local script without linking a provider SDK.
    """
    if not command or not command.strip():
        raise ValueError("executor command cannot be empty")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    def _exec(task: str, model_id: str) -> tuple[str, int, int]:
        env = os.environ.copy()
        env["ROUTER_GATE_MODEL_ID"] = model_id
        rendered = command.replace("{model}", shlex.quote(model_id))
        try:
            completed = subprocess.run(
                rendered,
                input=task or "",
                text=True,
                capture_output=True,
                shell=True,
                cwd=cwd,
                env=env,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ExecutorError(f"executor timed out after {timeout_seconds}s", stderr=str(exc)) from exc
        except OSError as exc:
            raise ExecutorError(f"executor failed to start: {exc}") from exc

        if completed.returncode != 0:
            raise ExecutorError(
                "executor exited with failure",
                returncode=completed.returncode,
                stderr=completed.stderr or "",
            )
        return parse_executor_output(completed.stdout, task or "")

    return _exec
