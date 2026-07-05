import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doctor } from "../src/doctor.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-doctor-"));

test("doctor warns when a repo has more than ~6 MCP servers", () => {
  const root = fixture();
  const servers = {};
  for (let i = 0; i < 7; i++) servers[`s${i}`] = { command: "x" };
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  const mcp = doctor({ targetRoot: root }).results.find((r) => r.label === "MCP servers");
  assert.ok(mcp, "MCP check ran");
  assert.equal(mcp.status, "warn");
});

test("doctor is ok with a small MCP set", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { context7: { command: "npx" } } }),
  );
  const mcp = doctor({ targetRoot: root }).results.find((r) => r.label === "MCP servers");
  assert.equal(mcp.status, "ok");
});
