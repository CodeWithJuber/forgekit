#!/usr/bin/env python3
"""Verify that a real Codex CLI delivers a private CSV row on an ordinary prompt."""
import argparse
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
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
        self.server.requests.append(json.loads(self.rfile.read(size)))
        response = {"id": "resp_fixture", "object": "response", "created_at": 1,
                    "status": "completed", "model": "fixture", "output": [],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for kind in ["response.created", "response.completed"]:
            body = {"type": kind, "response": {**response, "status":
                    "in_progress" if kind == "response.created" else "completed"}}
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(body)}\n\n".encode())


def verify(codex, folder):
    project, home, manuals = (folder / name for name in ["workspace", "home", "external"])
    code_home, bin_dir = home / ".codex", folder / "bin"
    for directory in [project, code_home, manuals, bin_dir]:
        directory.mkdir(parents=True)
    # Expose the actual packaged CLI on PATH as an npm installation would. An argv
    # shim also works in a source checkout with the JS bin file in mode 0644.
    forge = bin_dir / "forge"
    forge.write_text("#!/bin/sh\nexec node \"$FORGE_TEST_CLI\" \"$@\"\n")
    forge.chmod(0o700)
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node is required")
    env = {"PATH": os.pathsep.join([str(bin_dir), str(Path(node).parent), os.defpath]),
           "HOME": str(home), "CODEX_HOME": str(code_home), "FORGE_HOME": str(home / "forge"),
           "FORGE_TEST_CLI": str(ROOT / "src/cli.js"), "FORGE_EVIDENCE_WEB": "0",
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
    marker = "FW-" + secrets.token_hex(12)
    (manuals / "procedures.csv").write_text(f"component,evidence\nmainspring,{marker}\n")
    run([forge, "sources", "sync"])
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
                                 "Find the documented mainspring procedure."],
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
        if marker not in messages or "procedures.csv" not in messages or "rows 1-2" not in messages:
            raise SystemExit("The first native model request did not include the CSV row and its source locator")
        print(f"{expected} delivered the external CSV row and locator to the first loopback request.")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True, type=Path, help="path to the pinned Codex CLI")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="forge-native-codex-") as temp:
        verify(args.codex.resolve(), Path(temp))
