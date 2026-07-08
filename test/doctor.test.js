import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processSession } from "../src/cortex_hook.js";
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

test("doctor reports 'no lessons yet' on a fresh repo, and counts once learning happens", () => {
  const fresh = fixture();
  const c0 = doctor({ targetRoot: fresh }).results.find((r) => r.label === "cortex");
  assert.ok(c0);
  assert.match(c0.note, /no lessons yet/);

  const learned = fixture();
  const s = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/a.ts" },
    { type: "edit", file: "src/a.ts" },
    { type: "edit", file: "src/a.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(learned, s(), 1);
  processSession(learned, s(), 2); // → active lesson
  const c1 = doctor({ targetRoot: learned }).results.find((r) => r.label === "cortex");
  assert.match(c1.note, /1 active/);
});

test("doctor surfaces the new tooling / guards-exec / atlas / pricing checks", () => {
  const labels = doctor({ targetRoot: fixture() }).results.map((r) => r.label);
  for (const l of ["guards exec", "jq", "atlas", "model pricing"]) {
    assert.ok(labels.includes(l), `doctor runs the '${l}' check`);
  }
});

test("doctor checks plugin manifests and hook compatibility", () => {
  const results = doctor({ targetRoot: fixture() }).results;
  const claude = results.find((r) => r.label === "Claude plugin hooks");
  const codex = results.find((r) => r.label === "Codex plugin");
  assert.ok(claude, "Claude plugin compatibility check ran");
  assert.ok(codex, "Codex plugin compatibility check ran");
  assert.equal(claude.status, "ok");
  assert.match(claude.note, /additive hook command/);
  assert.equal(codex.status, "ok");
  assert.match(codex.note, /no repo-level hook takeover/);
});
