import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { probeSourceMcp } from "../src/source_mcp.js";

const base = { provider: "jira", mcp: { url: "https://mcp.example.test/ctx", tool: "read_issue" } };
const rpc = (id, result, headers) => Response.json({ jsonrpc: "2.0", id, result }, { headers });
const init = { protocolVersion: "2025-11-25", capabilities: { tools: {} } };
test("loopback MCP server: session handshake, mixed JSON/SSE, pagination, precise tool match and close", async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    calls.push({ method: req.method, headers: req.headers, body });
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (body.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "Mcp-Session-Id": "probe-opaque" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: init }));
      return;
    }
    if (body.params.cursor) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        ': heartbeat\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n',
      );
      res.write('event: message\r\ndata: {"jsonrpc":"2.0",\r\n');
      res.write(`data: "id":${body.id},"result":{"tools":[{"name":"read_issue"}]}}\r\n\r\n`);
      // The client must detect its own response while the stream is open.
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "update_issue" }], nextCursor: "page-two" },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const addr = server.address();
  const source = {
    provider: "jira",
    mcp: { url: `http://127.0.0.1:${addr.port}/mcp`, tokenEnv: "MCP_OAUTH", tool: "read_issue" },
  };
  const report = await probeSourceMcp(source, {
    env: { MCP_OAUTH: "example-token" },
    timeoutMs: 2500,
  });
  assert.deepEqual(report.tools, ["read_issue", "update_issue"]);
  assert.equal(report.available, true);
  assert.equal(report.configuredTool, "read_issue");
  assert.deepEqual(
    calls.map((c) => c.body.method ?? c.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/list", "DELETE"],
  );
  assert.equal(calls[0].headers["mcp-session-id"], undefined);
  for (const [i, c] of calls.entries()) {
    assert.equal(c.headers.authorization, "Bearer example-token");
    if (i > 0) {
      assert.equal(c.headers["mcp-session-id"], "probe-opaque");
      assert.equal(c.headers["mcp-protocol-version"], "2025-11-25");
    }
  }
  assert.doesNotMatch(JSON.stringify(report), /probe-opaque|example-token/);
});
test("stateless server without tools returns unavailable and needs no DELETE", async () => {
  const methods = [];
  const fetchImpl = async (_url, req) => {
    methods.push(req.method);
    const request = JSON.parse(req.body);
    if (request.method === "initialize") return rpc(request.id, { ...init, capabilities: {} });
    return new Response(null, { status: 202 });
  };
  const r = await probeSourceMcp(base, { fetchImpl });
  assert.deepEqual(methods, ["POST", "POST"]);
  assert.deepEqual(r.tools, []);
  assert.equal(r.available, false);
});
test("invalid scopes, configuration and missing named credentials never send a request", async () => {
  for (const source of [
    { provider: "local", mcp: base.mcp },
    { ...base, mcp: { url: "http://corp.example/" } },
    { ...base, mcp: { url: "https://token@corp.example" } },
    { ...base, mcp: { url: "https://corp.example/?access_token=value" } },
    { ...base, mcp: { ...base.mcp, tokenEnv: "TOKEN" } },
    { ...base, mcp: { ...base.mcp, tool: "unsafe name" } },
  ]) {
    let called = false;
    await assert.rejects(
      probeSourceMcp(source, {
        env: {},
        fetchImpl: async () => {
          called = true;
          throw new Error();
        },
      }),
    );
    assert.equal(called, false);
  }
});
test("HTTP failures preserve status, suppress raw body and never follow auth redirects", async () => {
  await assert.rejects(
    probeSourceMcp(base, {
      fetchImpl: async (_url, req) => {
        assert.equal(req.redirect, "error");
        assert.equal(req.credentials, "omit");
        return new Response("secret response", { status: 403 });
      },
    }),
    (e) => e.status === 403 && !e.message.includes("secret response"),
  );
});
test("malformed, large and repeated paginated responses cannot appear available", async () => {
  for (const kind of ["cursor", "body", "id", "version"]) {
    let closed = 0;
    const fetchImpl = async (_url, req) => {
      if (req.method === "DELETE") {
        closed++;
        return new Response(null, { status: 405 });
      }
      const q = JSON.parse(req.body);
      if (q.method === "initialize")
        return rpc(q.id, kind === "version" ? { ...init, protocolVersion: "x" } : init, {
          "Mcp-Session-Id": "session",
        });
      if (q.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (kind === "body")
        return new Response(" ".repeat(520 * 1024), {
          headers: { "content-type": "application/json" },
        });
      return rpc(kind === "id" ? 0 : q.id, { tools: [{ name: "read_issue" }], nextCursor: "same" });
    };
    await assert.rejects(probeSourceMcp(base, { fetchImpl }), /MCP/);
    assert.equal(closed, 1);
  }
});
