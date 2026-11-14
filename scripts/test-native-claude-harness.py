#!/usr/bin/env python3
"""Verify native Claude Code project hooks, MCP routing and a direct write denial against loopback."""
import argparse
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading

from native_harness_fixture import HarnessModel, prepare_project, ROOT, TASK


def tool_result(request):
    for message in reversed(request["messages"]):
        blocks = message["content"]
        for block in reversed(blocks if isinstance(blocks, list) else []):
            if block.get("type") == "tool_result":
                value = block["content"]
                if isinstance(value, str):
                    return value
                return "\n".join(item.get("text") or item.get("tool_name", "") for item in value)
    return ""


class LocalModels(HarnessModel):
    def do_POST(self):
        size = int(self.headers["Content-Length"])
        if not 0 < size <= 8 * 1024 * 1024:
            self.send_error(400)
            return
        path = self.path.split("?")[0]
        req = json.loads(self.rfile.read(size))
        if path == "/v1/chat/completions" and req["model"] == "harness-fixture":
            self.harness_reply(req)
        elif path == "/v1/messages/count_tokens":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"input_tokens":100}')
        elif path == "/v1/messages":
            self.claude_reply(req)
        else:
            self.send_error(404)

    def claude_reply(self, req):
        history = self.server.outer
        history.append(req)
        turn = len(history)
        prefix = self.server.prefix
        call = None
        if turn == 1 and "call forge_harness_run" in json.dumps(req["messages"]).lower():
            call = ("ToolSearch", {"query": "select:" + prefix + "run," + prefix + "status"})
        if turn == 2 and prefix + "run" in tool_result(req) and prefix + "status" in tool_result(req):
            call = (prefix + "run", {"task": TASK, "acceptance": ["Calculator suite passes"]})
        if turn == 3:
            try:
                call = (prefix + "status", {"id": json.loads(tool_result(req))["id"]})
            except (ValueError, KeyError):
                pass
        if turn == 4:
            call = ("Bash", {"command": "echo escaped > native-bypass.txt",
                             "description": "Exercise the native tool boundary"})
        usage = {"input_tokens": 50, "output_tokens": 10}
        message = {"id": f"msg_{turn}", "role": "assistant", "type": "message",
                   "model": req["model"], "content": [], "stop_reason": None,
                   "stop_sequence": None, "usage": usage}
        if call:
            name, args = call
            block = {"type": "tool_use", "id": f"toolu_{turn}", "name": name, "input": {}}
            delta = {"type": "input_json_delta", "partial_json": json.dumps(args)}
        else:
            block = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": "Fixture complete."}
        events = [
            {"type": "message_start", "message": message},
            {"type": "content_block_start", "index": 0, "content_block": block},
            {"type": "content_block_delta", "index": 0, "delta": delta},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use" if call else "end_turn",
                                                "stop_sequence": None}, "usage": usage},
            {"type": "message_stop"},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event in events:
            self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())


def verify(claude, folder, server, mode):
    repo, home, config, bin_dir, state = (folder / p for p in ("repo", "home", "claude", "bin", "state"))
    for d in (repo, home, config, bin_dir, state):
        d.mkdir()
    node = Path(shutil.which("node")).resolve()
    shim = bin_dir / "forge"
    shim.write_text(f'#!/bin/sh\nexec {shlex.quote(str(node))} {shlex.quote(str(ROOT / "src/cli.js"))} "$@"\n')
    shim.chmod(0o700)
    url = f"http://127.0.0.1:{server.server_port}"
    env = {"HOME": str(home), "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
           "FORGE_HOME": str(state), "CLAUDE_CONFIG_DIR": str(config),
           "FORGE_EVIDENCE_WEB": "0", "FORGE_NO_CATALOG_FETCH": "1",
           "ANTHROPIC_BASE_URL": url, "ANTHROPIC_API_KEY": "sk-ant-local-fixture",
           "ENABLE_TOOL_SEARCH": "true", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
           "DISABLE_TELEMETRY": "1", "HTTP_PROXY": "http://127.0.0.1:9",
           "HTTPS_PROXY": "http://127.0.0.1:9", "ALL_PROXY": "http://127.0.0.1:9",
           "NO_PROXY": "127.0.0.1,localhost,::1"}
    def run(*args):
        result = subprocess.run(args, cwd=repo, env=env, capture_output=True, text=True,
                                stdin=subprocess.DEVNULL, timeout=90)
        if result.returncode:
            raise RuntimeError(f"{args[0]} failed: {(result.stdout + result.stderr)[-1400:]}")
        return result.stdout.strip()

    if not run(claude, "--version").startswith("2.1.325 "):
        raise RuntimeError("Expected Claude Code 2.1.325")
    run("git", "init", "-q")
    run("forge", "harness", "init", "--hosts", "claude", "--supervised")
    if mode == "plugin":
        # Isolate the packaged native entry point: omit generated project hooks
        # and project MCP before signing a receipt for this fixture checkout.
        (repo / ".claude/settings.json").unlink()
        (repo / ".mcp.json").unlink()
        registration = ["--plugin-dir", str(ROOT)]
        prefix = "mcp__plugin_forgekit_forge-cortex__forge_harness_"
    else:
        registration = ["--strict-mcp-config", "--mcp-config", str(repo / ".mcp.json")]
        prefix = "mcp__forge-cortex__forge_harness_"
    server.prefix = prefix
    marker = prepare_project(repo, env, run, node, url + "/v1")
    (config / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True, "projects": {
        str(repo): {"hasTrustDialogAccepted": True, "enabledMcpjsonServers": ["forge-cortex"]}}}))
    run(claude, "-p", TASK, "--no-session-persistence", "--model", "sonnet",
        *registration,
        "--allowedTools", prefix + "run", prefix + "status", "ToolSearch", "Bash")
    if len(server.outer) != 5 or len(server.inner) != 2:
        received = tool_result(server.outer[-1])[:240] if server.outer else ""
        raise RuntimeError(f"Expected 5 Claude and 2 harness requests; got {len(server.outer)} and {len(server.inner)}. {received}")
    results = [json.loads(tool_result(req)) for req in server.outer[2:4]]
    if any(r["status"] != "done" or not r["evidence"]["ok"] or r["evidence"]["scope"] != "project-suites"
           for r in results) or results[0]["id"] != results[1]["id"]:
        raise RuntimeError("Claude did not receive signed project verification and its matching status")
    if marker in json.dumps(server.inner[0]["messages"]) or marker not in json.dumps(server.inner[1]["messages"]):
        raise RuntimeError("The real gated read did not supply the random workspace-only value")
    if "supervised ForgeKit" not in tool_result(server.outer[4]) or (repo / "native-bypass.txt").exists():
        raise RuntimeError("The native hook did not prevent the direct file write")
    print(f"Claude Code 2.1.325 ({mode}) discovered the deferred MCP schemas on a plain prompt, called supervised run and status, "
          "obtained signed suite evidence after a gated file read, and blocked a native Bash write.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--claude", type=Path, required=True)
    cli = p.parse_args().claude.resolve()
    for mode in ("project", "plugin"):
        with tempfile.TemporaryDirectory(prefix="forge-claude-harness-") as directory:
            with ThreadingHTTPServer(("127.0.0.1", 0), LocalModels) as server:
                server.outer, server.inner = [], []
                threading.Thread(target=server.serve_forever, daemon=True).start()
                try:
                    verify(cli, Path(directory), server, mode)
                finally:
                    server.shutdown()
