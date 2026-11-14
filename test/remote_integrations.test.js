import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emitMcp } from "../src/emit/mcp.js";
import { addIntegration, managedMcpState, removeIntegration } from "../src/integrations.js";
import { ENDPOINTS, remoteDefinition } from "../src/remote_endpoints.js";
import { readForgeConfig, writeForgeConfig } from "../src/repo_config.js";

function workspace(t, tools) {
  const temp = mkdtempSync(join(tmpdir(), "forge-http-"));
  const root = join(temp, "work");
  mkdirSync(root);
  const before = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(temp, "private");
  t.after(() => {
    if (before === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = before;
    rmSync(temp, { recursive: true, force: true });
  });
  if (tools) writeForgeConfig(root, (c) => ({ ...c, tools }));
  return root;
}
const read = (root, path) => readFileSync(join(root, path), "utf8");

test("HTTP presets and custom URLs respect host formats, workspace trust, and removal", (t) => {
  const root = workspace(t);
  for (const [id, d] of Object.entries(ENDPOINTS))
    if (d.url) assert.equal(remoteDefinition(id, d.url).url, d.url);
  for (const input of [
    "javascript:x",
    "http://example.org/mcp",
    "https://x.test/mcp?api_key=ABC",
    "https://user:pass@x.test/mcp",
    "https://x.test/" + "$" + "{SECRET}",
    "https://x.test/%24%7BSECRET%7D",
    "https://x.test/mcp#fragment",
  ])
    assert.throws(() => remoteDefinition("internal", input));
  for (const id of ["constructor", "../home", "forge-cortex"])
    assert.throws(() => remoteDefinition(id, "https://docs.example/mcp"));
  assert.throws(() => remoteDefinition("internal", "https://docs.example/mcp", "abc:def"));
  const url = "https://services.example.org/mcp";
  const tokenEnv = "INTERNAL_DOCS_TOKEN";
  const remote = { url, tokenEnv };
  const installed = addIntegration("docs", { targetRoot: root, remote });
  assert.ok(installed.ok);
  assert.ok(addIntegration("docs", { targetRoot: root, remote }).ok);
  const cfg = readForgeConfig(root);
  assert.deepEqual(cfg.mcp.integrations, ["docs"]);
  assert.match(cfg.mcp.remotes.docs, /^[a-f0-9]{64}$/);
  // A fresh repository records only the binding digest. Every HTTP endpoint stays private.
  assert.doesNotMatch(JSON.stringify(cfg), /https?:\/\//i);
  assert.deepEqual(JSON.parse(read(root, ".mcp.json")).mcpServers.docs, {
    type: "http",
    url,
    headers: { Authorization: "Bearer $" + "{INTERNAL_DOCS_TOKEN}" },
  });
  assert.deepEqual(JSON.parse(read(root, ".kimi-code/mcp.json")).mcpServers.docs, {
    url,
    bearerTokenEnvVar: tokenEnv,
  });
  assert.match(read(root, ".codex/config.toml"), /bearer_token_env_var = "INTERNAL_DOCS_TOKEN"/);
  assert.match(read(root, ".cursor/mcp.json"), /Bearer \$\{env:INTERNAL_DOCS_TOKEN\}/);
  assert.match(read(root, ".gemini/settings.json"), /"httpUrl"/);
  assert.ok(!JSON.parse(read(root, ".zed/settings.json")).context_servers.docs);
  assert.ok(!existsSync(join(root, ".continue/mcpServers/forge-docs.yaml")));
  assert.equal(
    addIntegration("docs", { targetRoot: root, remote: { url: "https://attacker.example/mcp" } })
      .ok,
    false,
  );
  assert.deepEqual(managedMcpState(root).servers.docs, remote);
  emitMcp({ targetRoot: root, ...managedMcpState(root) });
  assert.deepEqual(readForgeConfig(root).mcp.integrations, ["docs"]);
  const fresh = join(root, "sibling");
  mkdirSync(fresh);
  writeForgeConfig(fresh, () => ({ mcp: cfg.mcp }));
  assert.equal(managedMcpState(fresh).servers.docs, undefined);
  assert.match(managedMcpState(fresh).warning, /Connect/);
  assert.ok(removeIntegration("docs", { targetRoot: root }).ok);
  assert.ok(!JSON.parse(read(root, ".mcp.json")).mcpServers.docs);
  assert.doesNotMatch(read(root, ".codex/config.toml"), /mcp_servers\.docs/);
  assert.equal(readForgeConfig(root).mcp.remotes.docs, undefined);
});

test("remote OAuth configurations preserve host authentication and user-owned entries", (t) => {
  const root = workspace(t, ["claude", "continue", "zed", "roo"]);
  const other = { command: "user-defined", args: [] };
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { gitlab: other } }));
  const opts = { targetRoot: root, remote: { url: "https://git.company.example/api/v4/mcp" } };
  assert.equal(addIntegration("gitlab", opts).ok, true);
  assert.deepEqual(JSON.parse(read(root, ".mcp.json")).mcpServers.gitlab, other);
  assert.deepEqual(
    JSON.parse(read(root, ".zed/settings.json")).context_servers.gitlab,
    opts.remote,
  );
  assert.match(read(root, ".continue/mcpServers/forge-gitlab.yaml"), /type: streamable-http/);
  assert.equal(JSON.parse(read(root, ".roo/mcp.json")).mcpServers.gitlab.type, "streamable-http");
  assert.equal(removeIntegration("gitlab", { targetRoot: root }).ok, true);
  assert.deepEqual(JSON.parse(read(root, ".mcp.json")).mcpServers.gitlab, other);
  assert.ok(!existsSync(join(root, ".continue/mcpServers/forge-gitlab.yaml")));
  writeForgeConfig(root, (c) => ({ ...c, tools: ["zed"] }));
  assert.equal(
    addIntegration("gitlab", {
      targetRoot: root,
      remote: { ...opts.remote, tokenEnv: "GITLAB_TOKEN" },
    }).ok,
    false,
  );
  assert.ok(!readForgeConfig(root).mcp.integrations.includes("gitlab"));
});

test("connect CLI probes a real loopback Streamable HTTP server before recording the workspace", async (t) => {
  const root = workspace(t, ["claude"]);
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push([body.method, req.headers.authorization]);
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : { tools: [{ name: "search_docs", inputSchema: { type: "object" } }] };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const canary = "loopback-only-test-value";
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  // Drive the user-facing process and inspect the exact generated host config.
  const child = spawn(
    process.execPath,
    [
      cli,
      "integrations",
      "connect",
      "internal",
      "--url",
      url,
      "--token-env",
      "TEST_REMOTE_BEARER",
      "--probe",
    ],
    {
      cwd: root,
      env: { ...process.env, TEST_REMOTE_BEARER: canary },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  assert.equal(status, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).probe.tools, ["search_docs"]);
  assert.deepEqual(
    seen.map((x) => x[0]),
    ["initialize", "notifications/initialized", "tools/list"],
  );
  assert.ok(seen.every((x) => x[1] === `Bearer ${canary}`));
  assert.ok(!stdout.includes(canary));
  assert.ok(!read(root, ".mcp.json").includes(canary));
  assert.deepEqual(JSON.parse(read(root, ".mcp.json")).mcpServers.internal.url, url);
});
