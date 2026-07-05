import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-mcp-"));

test("sync emits MCP config into each tool's real format", () => {
  const root = fixture();
  sync({ targetRoot: root });
  assert.match(readFileSync(join(root, ".mcp.json"), "utf8"), /"mcpServers"[\s\S]*context7/);
  assert.match(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"), /context7/);
  assert.match(
    readFileSync(join(root, ".zed", "settings.json"), "utf8"),
    /"context_servers"[\s\S]*context7/,
  );
  assert.match(readFileSync(join(root, ".vscode", "mcp.json"), "utf8"), /"servers"[\s\S]*context7/);
  assert.match(
    readFileSync(join(root, ".codex", "config.toml"), "utf8"),
    /\[mcp_servers\.context7\]/,
  );
  assert.match(
    readFileSync(join(root, ".continue", "mcpServers", "forge-mcp.yaml"), "utf8"),
    /mcpServers:/,
  );
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
  assert.ok(j.mcpServers.context7, "forge server added");
});

test("cortex MCP exposes substrate tools", async () => {
  const { handle } = await import("../src/cortex_mcp.js");
  const listed = handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("substrate_check"));
  assert.ok(names.includes("predict_impact"));
  assert.ok(names.includes("assumption_gate"));
  const called = handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "assumption_gate", arguments: { task: "Fix the bug." } },
  });
  assert.match(called.result.content[0].text, /shouldAsk/);
});
