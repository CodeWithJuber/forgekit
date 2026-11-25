"""Synthetic project and loopback coding model shared by the native MCP acceptance tests."""
from http.server import BaseHTTPRequestHandler
import json
import re
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parent.parent
TASK = "Verify the synthetic calculator unit suite."


def tool(name, args, number):
    return {"id": f"call_{number}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}


class HarnessModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

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


def prepare_project(repo, env, run, node, url):
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
    return marker


class NativeEditReview:
    """A loopback model proposes the same harmless edit before and after an external scope review."""
    def __init__(self, root, review):
        self.file = root / "native-review.txt"
        self.review = review
        self.calls = 0
        self.completed = False
        self.error = None

    def next_edit(self, messages):
        self.calls += 1
        if self.calls == 2:
            match = re.search(r"impact --review ([0-9a-f]{64})", json.dumps(messages))
            if self.file.exists() or not match:
                self.error = "native callback did not stop the pending edit with a review ID"
                return False
            try:
                response = json.loads(self.review(match.group(1)))
                if response["files"] != [self.file.name] or not response["plan"]["fullSuite"]:
                    raise ValueError("unexpected received scope")
            except Exception as error:
                self.error = f"scope could not be confirmed ({error})"
                return False
        if self.calls == 3:
            self.completed = self.file.is_file() and self.file.read_text().strip() == "reviewed fixture"
        return self.calls in (1, 2)

    def check(self, version):
        if not self.completed:
            raise RuntimeError(f"{version}: {self.error or 'native client did not apply the reviewed edit'}")
        print(f"{version} blocked a named file edit, returned a review ID and applied the same edit after its scope was reviewed.")
