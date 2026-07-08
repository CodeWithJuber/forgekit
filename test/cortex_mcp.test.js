import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { processSession } from "../src/cortex_hook.js";
import { handle } from "../src/cortex_mcp.js";

test("handle: initialize advertises the forge-cortex server", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(r.result.serverInfo.name, "forge-cortex");
});

test("handle: tools/list exposes the cortex + preflight tools", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = r.result.tools.map((t) => t.name);
  for (const t of [
    "cortex_lessons",
    "cortex_status",
    "preflight_check",
    "route_task",
    "scope_files",
    "forge_cost",
    "forge_dash_data",
    "forge_dash_summary",
    "forge_brain",
    "forge_ledger_query",
    "forge_diagnose",
    "forge_doctor",
    "forge_remember",
    "forge_ledger_ratify",
    "forge_ledger_retract",
  ]) {
    assert.ok(names.includes(t), `exposes ${t}`);
  }
});

test("handle: notifications get no response; unknown methods error", async () => {
  assert.equal(await handle({ method: "notifications/initialized" }), null);
  assert.equal((await handle({ id: 9, method: "bogus" })).error.code, -32601);
});

const SERVER = fileURLToPath(new URL("../src/cortex_mcp.js", import.meta.url));

test("live server over stdio returns learned lessons for a repo", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-"));
  const session = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, session(), 1);
  processSession(root, session(), 2); // → active lesson

  const requests = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "cortex_lessons", arguments: { files: ["src/tax.ts"] } },
    }),
  ].join("\n");
  const r = spawnSync("node", [SERVER], {
    input: `${requests}\n`,
    encoding: "utf8",
    env: { ...process.env, FORGE_ROOT: root },
    timeout: 10000,
  });
  const responses = r.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const call = responses.find((x) => x.id === 2);
  assert.match(call.result.content[0].text, /Lessons for the files in play/);
  assert.match(call.result.content[0].text, /tax\.ts/);
});

test("forge_remember writes a fact to .forge/brain/ via stdio", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-rem-"));
  mkdirSync(join(root, ".forge", "brain"), { recursive: true });
  const requests = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "forge_remember",
        arguments: { name: "test-fact", body: "testing MCP write" },
      },
    }),
  ].join("\n");
  const r = spawnSync("node", [SERVER], {
    input: `${requests}\n`,
    encoding: "utf8",
    env: { ...process.env, FORGE_ROOT: root },
    timeout: 10000,
  });
  const responses = r.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const call = responses.find((x) => x.id === 2);
  assert.match(call.result.content[0].text, /Remembered/);
  const written = readFileSync(join(root, ".forge", "brain", "facts", "test-fact.md"), "utf8");
  assert.match(written, /testing MCP write/);
});

test("forge_ledger_retract returns error for missing claim via stdio", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-ret-"));
  mkdirSync(join(root, ".forge", "ledger"), { recursive: true });
  const requests = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "forge_ledger_retract", arguments: { id: "nonexistent", reason: "test" } },
    }),
  ].join("\n");
  const r = spawnSync("node", [SERVER], {
    input: `${requests}\n`,
    encoding: "utf8",
    env: { ...process.env, FORGE_ROOT: root },
    timeout: 10000,
  });
  const responses = r.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const call = responses.find((x) => x.id === 2);
  assert.match(call.result.content[0].text, /No claim matching/);
});
