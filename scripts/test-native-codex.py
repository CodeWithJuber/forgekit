#!/usr/bin/env python3
"""Verify that a real Codex CLI delivers a private CSV row on an ordinary prompt."""
import argparse
from functools import partial
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
PIN = "0.169.0"


class LocalResponses(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != "/v1/responses":
            self.send_error(404)
            return
        size = int(self.headers["Content-Length"])
        if not 0 < size <= 8 * 1024 * 1024:
            self.send_error(413)
            return
        body = json.loads(self.rfile.read(size))
        self.server.requests.append(body)
        step = getattr(self.server, "supervised_step", 0)
        item = None
        if step == 1:
            self.server.supervised_step = 2
            item = shell_call(body.get("tools", []))
        reply = "Fixture complete."
        message = {"type": "message", "id": "msg_fixture", "role": "assistant",
                   "status": "completed", "content": [{"type": "output_text", "text": reply,
                                                       "annotations": []}]}
        response = {"id": "resp_fixture", "object": "response", "created_at": 1,
                    "status": "completed", "model": "fixture", "output": [message],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        events = [
            ("response.created", {"response": {**response, "status": "in_progress", "output": []}}),
            ("response.output_item.added", {"output_index": 0,
             "item": {**message, "status": "in_progress", "content": []}}),
            ("response.output_text.delta", {"item_id": message["id"], "output_index": 0,
                                            "content_index": 0, "delta": reply}),
            ("response.output_item.done", {"output_index": 0, "item": message}),
            ("response.completed", {"response": response}),
        ]
        if item:
            completed = {**response, "output": [item]}
            events = [
                ("response.created", {"response": {**completed, "status": "in_progress", "output": []}}),
                ("response.output_item.added", {"output_index": 0,
                    "item": {**item, "arguments": "", "status": "in_progress"}}),
                ("response.function_call_arguments.delta", {"output_index": 0, "item_id": item["id"],
                    "delta": item["arguments"]}),
                ("response.function_call_arguments.done", {"output_index": 0, "item_id": item["id"],
                    "arguments": item["arguments"]}),
                ("response.output_item.done", {"output_index": 0, "item": item}),
                ("response.completed", {"response": completed}),
            ]
        for sequence, (kind, fields) in enumerate(events):
            body = {"type": kind, "sequence_number": sequence, **fields}
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(body)}\n\n".encode())
        self.wfile.flush()


def shell_call(tools):
    # Use the protocol and tool name advertised by this CLI. Some Codex versions
    # group functions in namespaces, others list each top-level function directly.
    for group in tools:
        namespaced = group.get("type") == "namespace"
        for t in (group.get("tools", []) if namespaced else [group]):
            name = t.get("name")
            if t.get("type", "function") != "function" or name not in {"exec_command", "shell_command", "shell"}:
                continue
            props = (t.get("parameters") or {}).get("properties", {})
            command = "echo bypassed > native-bypass.txt"
            if "cmd" in props:
                args = {"cmd": command}
            elif (props.get("command") or {}).get("type") == "array":
                args = {"command": ["sh", "-c", command]}
            elif "command" in props:
                args = {"command": command}
            else:
                continue
            item = {"type": "function_call", "id": "fc_fixture", "call_id": "call_fixture",
                    "status": "completed", "name": name, "arguments": json.dumps(args)}
            if namespaced:
                item["namespace"] = group["name"]
            return item
    return None


def verify(codex, folder):
    project, home, manuals = (folder / name for name in ["workspace", "home", "external"])
    code_home, bin_dir = home / ".codex", folder / "bin"
    for directory in [project, code_home, manuals, bin_dir]:
        directory.mkdir(parents=True)
    # Expose the actual packaged CLI on PATH as an npm installation would. An argv
    # shim also works in a source checkout with the JS bin file in mode 0644.
    forge = bin_dir / "forge"
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node is required")
    forge.write_text(f'#!/bin/sh\nexec {shlex.quote(node)} {shlex.quote(str(ROOT / "src/cli.js"))} "$@"\n')
    forge.chmod(0o700)
    env = {"PATH": os.pathsep.join([str(bin_dir), str(Path(node).parent), os.defpath]),
           "HOME": str(home), "CODEX_HOME": str(code_home), "FORGE_HOME": str(home / "forge"),
           "FORGE_EVIDENCE_WEB": "0",
           "FORGE_NO_CATALOG_FETCH": "1", "FORGE_NO_HINT": "1", "NO_COLOR": "1",
           "LANG": "C.UTF-8", "NO_PROXY": "127.0.0.1,localhost",
           "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
           "ALL_PROXY": "http://127.0.0.1:9"}
    run = partial(subprocess.run, cwd=project, env=env, text=True, capture_output=True,
                  stdin=subprocess.DEVNULL, check=True, timeout=60)
    expected = run([codex, "--version"]).stdout.strip()
    if expected != f"codex-cli {PIN}":
        raise SystemExit(f"Expected codex-cli {PIN}, found {expected}")
    run(["git", "init", "-q"])
    location = json.loads(run([forge, "sources", "init"]).stdout)["configPath"]
    Path(location).write_text(json.dumps({"sources": [
        {"id": "manuals", "provider": "local", "root": str(manuals)}]}))
    # Keep the random map reference lowercase so credential-shaped entropy redaction
    # never masks a test value. The value still carries 96 unpredictable bits.
    marker = "ref-" + secrets.token_hex(12)
    (manuals / "procedures.csv").write_text(f"component,evidence\nmainspring,{marker}\n")
    run([forge, "sources", "sync"])
    prompt = "Find the documented mainspring procedure."
    indexed = run([forge, "evidence", prompt]).stdout
    expected_evidence = [marker, "procedures.csv", "rows 1-2"]
    if any(item not in indexed for item in expected_evidence):
        raise SystemExit("Fixture CSV value or row locator missing from synced evidence")
    run([forge, "hooks", "on", "--hosts", "codex", "--json"])
    server = ThreadingHTTPServer(("127.0.0.1", 0), LocalResponses)
    server.requests = []
    try:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        config = f"""model_provider = "local-fixture"
model = "fixture"
check_for_update_on_startup = false
[analytics]
enabled = false
[model_providers.local-fixture]
name = "Local test fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[projects.{json.dumps(str(project))}]
trust_level = "trusted"
"""
        (code_home / "config.toml").write_text(config)
        # This is a fresh synthetic workspace whose hooks we just generated. The
        # CLI's hook-trust override is scoped to this child, and nowhere persisted.
        result = subprocess.run([codex, "exec", "--ephemeral", "--json",
                                 "--sandbox", "read-only", "--dangerously-bypass-hook-trust",
                                 "--disable", "shell_snapshot",
                                 prompt],
                                cwd=project, env=env, text=True, capture_output=True,
                                stdin=subprocess.DEVNULL, timeout=90)
        if result.returncode or not server.requests:
            raise SystemExit(f"Native Codex run failed ({result.returncode}, "
                             f"{len(server.requests)} local requests).\n"
                             f"{(result.stdout + result.stderr)[-2400:]}")
        # A random value exists only in the external source. The model cannot
        # know it from project files, static rules or the prompt. No tool calls
        # are returned by our provider. Verify the first request specifically.
        messages = json.dumps(server.requests[0].get("input", []))
        if any(item not in messages for item in expected_evidence):
            raise SystemExit(f"Missing fixture evidence in the first native model request "
                             f"(value={marker in messages}, file={'procedures.csv' in messages}, "
                             f"locator={'rows 1-2' in messages})")
        print(f"{expected} delivered the external CSV row and locator to the first loopback request.")

        run([forge, "harness", "init", "--hosts", "codex", "--supervised"])
        server.requests.clear()
        server.supervised_step = 1
        # Use a workspace-write sandbox for the negative control. A read-only
        # sandbox also rejects the operation; we specifically need hook evidence.
        guarded = subprocess.run(
            [codex, "exec", "--ephemeral", "--json", "--sandbox", "workspace-write",
             "--dangerously-bypass-hook-trust", "--disable", "shell_snapshot",
             "Review the failing calculator."],
            cwd=project, env=env, text=True, capture_output=True,
            stdin=subprocess.DEVNULL, timeout=90)
        if guarded.returncode or not server.requests:
            raise SystemExit("Supervised Codex did not complete a native session: " +
                             (guarded.stdout + guarded.stderr)[-1600:])
        first = json.dumps(server.requests[0].get("input", []))
        later = json.dumps([r.get("input", []) for r in server.requests[1:]])
        if "forge_harness_run" not in first or "forge-cortex" not in first:
            raise SystemExit("First Codex model request omitted the supervised MCP routing instruction")
        if "supervised ForgeKit" not in later or (project / "native-bypass.txt").exists():
            kinds = [(t.get("type"), t.get("name")) for t in server.requests[0].get("tools", [])]
            raise SystemExit(f"Missing native supervised tool denial: requests={len(server.requests)}, "
                             f"tools={kinds}, followup={later[-1600:]}, trace={guarded.stdout[-1200:]}")
        print(f"{expected} delivered the supervised MCP routing instruction and denied the native "
              "shell write before execution in a workspace-write sandbox.")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True, type=Path, help="path to the pinned Codex CLI")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="forge-native-codex-") as temp:
        verify(args.codex.resolve(), Path(temp))
