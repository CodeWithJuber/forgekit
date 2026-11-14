#!/usr/bin/env python3
"""Exercise a real Kimi prompt, supervised MCP run and native denial with two loopback providers."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent
PREFIX = "mcp__forge-cortex__forge_harness_"
TASK = "Verify the synthetic calculator unit suite."


def tool(name, args, number):
    return {"id": f"call_{number}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}


class LocalModels(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        size = int(self.headers["Content-Length"])
        if self.path != "/v1/chat/completions" or not 0 < size < 8 * 1024 * 1024:
            self.send_error(400)
            return
        body = json.loads(self.rfile.read(size))
        if body["model"] == "harness-fixture":
            self.harness_reply(body)
        else:
            self.kimi_reply(body)

    def harness_reply(self, body):
        self.server.inner.append(body)
        if len(self.server.inner) == 1:
            message = {"role": "assistant", "content": None,
                       "tool_calls": [tool("read_file", {"path": "calculator.txt"}, 1)]}
        else:
            message = {"role": "assistant", "content": "Finished the requested local check."}
        payload = {"id": "inner", "model": "harness-fixture",
                   "choices": [{"index": 0, "finish_reason": "tool_calls" if "tool_calls" in message else "stop",
                                "message": message}],
                   "usage": {"prompt_tokens": 20, "completion_tokens": 8}}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def kimi_reply(self, body):
        history = self.server.outer
        history.append(body)
        turn = len(history)
        call = None
        if turn == 1:
            first = json.dumps({"messages": body["messages"], "tools": body.get("tools", [])})
            if "forge-cortex" in first and "forge_harness_run" in first:
                call = tool(PREFIX + "run", {"task": TASK, "acceptance": ["Calculator suite passes"]}, turn)
        elif turn == 2:
            try:
                result = json.loads(body["messages"][-1]["content"])
                call = tool(PREFIX + "status", {"id": result["id"]}, turn)
            except (KeyError, ValueError):
                pass
        elif turn == 3:
            call = tool("Bash", {"command": "echo escaped > native-bypass.txt",
                                 "description": "Exercise the supervised action boundary"}, turn)
        deltas = [({"role": "assistant", "tool_calls": [{"index": 0, **call}]}, None), ({}, "tool_calls")] if call else [
            ({"role": "assistant", "content": "Fixture complete."}, None), ({}, "stop")]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in deltas:
            event = {"id": f"outer_{turn}", "object": "chat.completion.chunk", "created": 1,
                     "model": "kimi-fixture", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


def verify(kimi, folder, server):
    repo, home, khome, bin_dir, state = (folder / p for p in ("repo", "home", "kimi", "bin", "state"))
    for d in (repo, home, khome / "plugins", bin_dir, state):
        d.mkdir(parents=True)
    node = Path(shutil.which("node")).resolve()
    cli = ROOT / "src" / "cli.js"
    shim = bin_dir / "forge"
    shim.write_text(f'#!/bin/sh\nexec {shlex.quote(str(node))} {shlex.quote(str(cli))} "$@"\n')
    shim.chmod(0o700)
    url = f"http://127.0.0.1:{server.server_port}/v1"
    env = {"HOME": str(home), "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
           "FORGE_HOME": str(state), "KIMI_CODE_HOME": str(khome), "FORGE_EVIDENCE_WEB": "0",
           "FORGE_NO_CATALOG_FETCH": "1", "KIMI_CODE_TRUST_WORKSPACE": "1",
           "KIMI_DISABLE_TELEMETRY": "1", "KIMI_CODE_NO_AUTO_UPDATE": "1",
           "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
           "ALL_PROXY": "http://127.0.0.1:9", "NO_PROXY": "127.0.0.1,localhost,::1",
           "KIMI_MODEL_PROVIDER_TYPE": "openai", "KIMI_MODEL_NAME": "kimi-fixture",
           "KIMI_MODEL_API_KEY": "synthetic", "KIMI_MODEL_BASE_URL": url, "KIMI_MODEL_CAPABILITIES": "tool_use"}

    def run(*args):
        result = subprocess.run(args, cwd=repo, env=env, capture_output=True, text=True,
                                stdin=subprocess.DEVNULL, timeout=100)
        if result.returncode:
            raise RuntimeError(f"{args[0]} failed: {(result.stdout + result.stderr)[-1400:]}")
        return result.stdout.strip()

    if run(kimi, "--version") != "2.6.2":
        raise RuntimeError("Expected Kimi Code 2.6.2")
    record = {"id": "forgekit", "root": str(ROOT), "source": "local-path",
              "enabled": True, "installedAt": "2026-11-14T00:00:00Z"}
    (khome / "plugins" / "installed.json").write_text(json.dumps({"version": 1, "plugins": [record]}))
    (khome / "config.toml").write_text("telemetry = false\nauto_session_title = false\n")
    run("git", "init", "-q")
    run("forge", "harness", "init", "--hosts", "kimi", "--supervised")
    routing_file = repo / "harness" / "routing.yaml"
    routing = json.loads(routing_file.read_text())
    route = routing["routes"][0]
    route.update(baseUrl=url, model="harness-fixture")
    routing_file.write_text(json.dumps(routing))
    run("forge", "harness", "trust")
    module = (ROOT / "src" / "harness_router.js").as_uri()
    code = f'import {{harnessRouteFingerprint as f}} from {json.dumps(module)};console.log(f(JSON.parse(process.argv[1])))'
    env["FORGE_HARNESS_TRUSTED_ROUTES"] = run(node, "--input-type=module", "-e", code, json.dumps(route))
    marker = "case-" + secrets.token_hex(12)
    (repo / "calculator.txt").write_text(marker)
    (repo / "package.json").write_text(json.dumps({"name": "native-calc", "scripts": {"test": "node --test calculator.test.js"}}))
    (repo / "calculator.test.js").write_text('require("node:test")("sum",()=>require("node:assert/strict").equal(1+2,3))\n')
    run("forge", "verify", "--json")
    run(kimi, "-p", TASK)
    if len(server.outer) != 4 or len(server.inner) != 2:
        raise RuntimeError(f"Expected 4 Kimi and 2 harness requests; received {len(server.outer)} and {len(server.inner)}")
    if marker not in json.dumps(server.inner[1]["messages"]) or marker in json.dumps(server.inner[0]["messages"]):
        raise RuntimeError("The supervised read did not introduce the workspace-only random value")
    results = [json.loads(r["messages"][-1]["content"]) for r in server.outer[1:3]]
    if any(r["status"] != "done" or r["evidence"]["scope"] != "project-suites" or not r["evidence"]["ok"]
           for r in results) or results[0]["id"] != results[1]["id"]:
        raise RuntimeError("Kimi did not receive a verified run and matching status result")
    if "supervised ForgeKit" not in server.outer[3]["messages"][-1]["content"] or (repo / "native-bypass.txt").exists():
        raise RuntimeError("Native shell write was not blocked")
    print("Kimi Code 2.6.2 discovered supervised run, executed a gated workspace read, received signed suite evidence, inspected status, and blocked a direct native write.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--kimi", required=True, type=Path)
    args = p.parse_args()
    with tempfile.TemporaryDirectory(prefix="forge-kimi-harness-") as area:
        with ThreadingHTTPServer(("127.0.0.1", 0), LocalModels) as http:
            http.outer, http.inner = [], []
            threading.Thread(target=http.serve_forever, daemon=True).start()
            try:
                verify(args.kimi.resolve(), Path(area), http)
            finally:
                http.shutdown()
