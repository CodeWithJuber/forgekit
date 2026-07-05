# router_gate

Production-ready **assumption gate + complexity-aware model router** for coding agents.

It is designed to sit in front of Claude Code, MCP clients, custom agent CLIs, internal LLM gateways, or any workflow where you want two safety checks before spending premium model tokens:

1. **Assumption gate** — if the task is under-specified, halt and ask clarifying questions instead of guessing.
2. **Complexity router** — if the task is clear, route it to `cheap`, `mid`, or `premium` with an auditable explanation.

The core package is dependency-free. Tests only need `pytest`.

## Install

From this source directory:

```bash
python -m pip install -e .
```

For tests:

```bash
python -m pip install -e '.[dev]'
python -m pytest
```

## CLI usage

Pass task text as an argument, via `--file`, or on stdin.

```bash
router-gate assess "Fix the bug." --pretty
router-gate route "Implement an LRU cache class with O(1) get/put. Python." --pretty
router-gate decide "Write is_even(n). is_even(4) -> True. Python." --pretty
```

`decide` is the safest integration point for agents: it gates first, and only returns a route when the task is specified enough to act on.

## Execute through any model gateway

`router-gate run` can call any external command. The task is sent on stdin and the selected model id is exposed as `ROUTER_GATE_MODEL_ID`. You can also use `{model}` in the command string.

Preferred executor stdout is JSON:

```json
{"text":"model output", "input_tokens":123, "output_tokens":456}
```

Plain text stdout also works; token counts are estimated for cost accounting.

Example:

```bash
router-gate run \
  --executor-command './my-agent-call --model {model}' \
  "Write is_prime(n). is_prime(7) -> True, is_prime(8) -> False. Python." \
  --pretty
```

If the selected tier fails, the pipeline records the error and escalates to the next tier unless `--no-escalation` is set.

## Claude Code / MCP usage

Install the package, then register the stdio MCP server with your MCP-capable client.

Example MCP server command:

```bash
router-gate-mcp
```

Claude Code-style config shape:

```json
{
  "mcpServers": {
    "router-gate": {
      "command": "router-gate-mcp",
      "args": []
    }
  }
}
```

Exposed tools:

- `assess_task` — returns completeness, risk, missing dimensions, and questions.
- `route_task` — returns `cheap` / `mid` / `premium` plus scoring reasons.
- `decide_task` — runs the assumption gate first; if safe, also routes.

Use `decide_task` before expensive or ambiguous work. If it returns `halted_for_questions: true`, ask the returned questions before continuing.

## Configuration

Config can come from a TOML file or environment variables.

```toml
ask_threshold = 0.6
allow_escalation = true
executor_command = "./my-agent-call --model {model}"
executor_timeout_seconds = 120

[tiers.cheap]
model_id = "claude-haiku-4-5-20251001"
usd_in_per_mtok = 1.0
usd_out_per_mtok = 5.0

[tiers.mid]
model_id = "claude-sonnet-5"
usd_in_per_mtok = 3.0
usd_out_per_mtok = 15.0

[tiers.premium]
model_id = "claude-opus-4-8"
usd_in_per_mtok = 15.0
usd_out_per_mtok = 75.0
```

Environment overrides:

```bash
export ROUTER_GATE_CONFIG=/path/to/router-gate.toml
export ROUTER_GATE_ASK_THRESHOLD=0.65
export ROUTER_GATE_ALLOW_ESCALATION=true
export ROUTER_GATE_EXECUTOR_COMMAND='./my-agent-call --model {model}'
export ROUTER_GATE_EXECUTOR_TIMEOUT_SECONDS=180
```

Inspect the effective config:

```bash
router-gate config --pretty
```

## Python API

```python
from router_gate import assess, route, run, external_command_executor

report = assess("Fix the bug.")
if report.should_ask:
    print(report.questions)
else:
    decision = route("Write is_even(n). is_even(4) -> True. Python.")
    print(decision.tier, decision.explain())

executor = external_command_executor("./my-agent-call --model {model}")
result = run(
    "Write is_prime(n). is_prime(7) -> True, is_prime(8) -> False. Python.",
    executor,
)
print(result.success, result.final_tier, result.total_cost)
```

## Architecture

```text
request -> assumption gate -> halt & ask OR route -> execute -> verify -> escalate
```

- Router decisions are transparent rubric scores, not another opaque model call.
- Verification is caller-owned: tests, compilers, regex checks, or review gates can be plugged into `run(..., verifier=...)`.
- Cost accounting uses measured executor token counts when available and conservative estimates otherwise.

## Development

```bash
python demo.py
python evaluate.py
python -m pytest
```

The included evaluation task set is a demonstration set, not a field benchmark. Calibrate thresholds on your own workload before enforcing automated model selection in high-stakes production paths.
