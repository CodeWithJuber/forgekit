import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-mcp-"));

test("sync emits MCP config into each tool's real format (forge server only, no third-party)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const mcp = readFileSync(join(root, ".mcp.json"), "utf8");
  assert.match(mcp, /"mcpServers"[\s\S]*forge-cortex/);
  // P0-06: the third-party context7 server is NOT installed by default.
  assert.doesNotMatch(mcp, /context7/, "context7 must not be a default MCP server");
  assert.match(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"), /forge-cortex/);
  assert.match(
    readFileSync(join(root, ".zed", "settings.json"), "utf8"),
    /"context_servers"[\s\S]*forge-cortex/,
  );
  assert.match(
    readFileSync(join(root, ".vscode", "mcp.json"), "utf8"),
    /"servers"[\s\S]*forge-cortex/,
  );
  assert.match(
    readFileSync(join(root, ".codex", "config.toml"), "utf8"),
    /\[mcp_servers\.forge-cortex\]/,
  );
  assert.match(
    readFileSync(join(root, ".continue", "mcpServers", "forge-mcp.yaml"), "utf8"),
    /mcpServers:/,
  );
});

test("integrations add context7 writes it (opt-in) after not being present by default", async () => {
  const root = fixture();
  sync({ targetRoot: root });
  assert.doesNotMatch(readFileSync(join(root, ".mcp.json"), "utf8"), /context7/);
  const m = await import("../src/integrations.js");
  assert.equal(m.planIntegration("nope").ok, false, "unknown integration rejected");
  const res = m.addIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  const after = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.ok(after.mcpServers.context7, "context7 added on opt-in");
  assert.ok(after.mcpServers["forge-cortex"], "existing forge server preserved");
});

test("managed-entry update: a drifted forge server is refreshed, user servers untouched", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        mine: { command: "x" },
        "forge-cortex": { command: "forge", args: ["OLD-STALE-ARG"] },
      },
    }),
  );
  sync({ targetRoot: root });
  const j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(
    j.mcpServers["forge-cortex"].args,
    ["cortex-mcp"],
    "stale forge entry refreshed",
  );
  assert.ok(j.mcpServers.mine, "user server preserved");
});

test("sync emits Continue rules (Continue does not read AGENTS.md)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  assert.ok(existsSync(join(root, ".continue", "rules", "00-forge.md")));
  assert.match(
    readFileSync(join(root, ".continue", "rules", "00-forge.md"), "utf8"),
    /## Workflow/,
  );
});

test("MCP + rules emit is idempotent (second sync writes nothing new)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const written = sync({ targetRoot: root }).report.filter((r) => r.action === "written");
  assert.equal(written.length, 0, `second sync wrote: ${written.map((r) => r.target)}`);
});

test("MCP merge preserves a user's own server", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { mine: { command: "x" } } }),
  );
  sync({ targetRoot: root });
  const j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.ok(j.mcpServers.mine, "user server preserved");
  assert.ok(j.mcpServers["forge-cortex"], "forge server added");
});

test("cortex MCP exposes substrate tools", async () => {
  const { handle } = await import("../src/cortex_mcp.js");
  const listed = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("substrate_check"));
  assert.ok(names.includes("predict_impact"));
  assert.ok(names.includes("assumption_gate"));
  const called = await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "assumption_gate", arguments: { task: "Fix the bug." } },
  });
  assert.match(called.result.content[0].text, /shouldAsk/);
});
