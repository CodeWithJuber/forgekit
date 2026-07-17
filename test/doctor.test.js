import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processSession } from "../src/cortex_hook.js";
import { doctor } from "../src/doctor.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-doctor-"));

test("doctor reports subsystem health in the standard vocabulary (P1-06)", () => {
  const root = fixture();
  const { health } = doctor({ targetRoot: root });
  const allowed = new Set(["ACTIVE", "DEGRADED", "UNAVAILABLE", "FAILED"]);
  for (const key of ["secret-redaction", "guards", "atlas", "managed-config", "pricing"]) {
    assert.ok(key in health, `health reports ${key}`);
    assert.ok(allowed.has(health[key]), `${key}=${health[key]} is a valid state`);
  }
  // node is present in this runtime, so redaction is ACTIVE (not silently missing).
  assert.equal(health["secret-redaction"], "ACTIVE");
});

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

test("doctor stays silent about gateway models when no custom gateway is configured", () => {
  const save = {
    l: process.env.LITELLM_BASE_URL,
    a: process.env.ANTHROPIC_BASE_URL,
  };
  try {
    // Direct Anthropic (default endpoint) or nothing configured → no probe, no "gateway models" row.
    process.env.LITELLM_BASE_URL = "";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    const labels = doctor({ targetRoot: fixture() }).results.map((r) => r.label);
    assert.ok(!labels.includes("gateway models"), "no gateway check for a direct-API session");
  } finally {
    process.env.LITELLM_BASE_URL = save.l ?? "";
    process.env.ANTHROPIC_BASE_URL = save.a ?? "";
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

test("doctor --fix turns a missing-hooks settings warn into ok via mergeSettings", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json"); // absent → not forge-managed

  const before = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "settings",
  );
  assert.ok(before, "settings check ran");
  assert.equal(before.status, "warn");
  assert.ok(before.fix, "warn carries a fix descriptor");

  const fixed = doctor({ targetRoot: root, settingsPath, fix: true });
  const settings = fixed.results.find((r) => r.label === "settings");
  assert.equal(settings.status, "ok", "settings warn → ok after --fix");
  assert.ok(
    fixed.repairs.some((rep) => rep.id === "settings" && rep.ok),
    "a settings repair was recorded",
  );
  // mergeSettings actually wrote the marker + hooks.
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(written._forge, "forge-managed");
  assert.ok(written.hooks && Object.keys(written.hooks).length, "hooks merged in");
});

test("doctor --fix adds the ledger union-merge rule to .gitattributes", () => {
  const root = fixture();
  // A populated ledger makes the 'ledger merge' check run (empty ledgers report ok early).
  mkdirSync(join(root, ".forge", "ledger", "claims"), { recursive: true });
  const settingsPath = join(fixture(), "settings.json");

  const before = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "ledger merge",
  );
  assert.equal(before.status, "warn");

  doctor({ targetRoot: root, settingsPath, fix: true });
  const attrs = join(root, ".gitattributes");
  assert.ok(existsSync(attrs), ".gitattributes was created");
  assert.match(readFileSync(attrs, "utf8"), /\.forge\/ledger\//);
});

test("doctor --fix is idempotent — a second run repairs nothing", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge", "ledger", "claims"), { recursive: true });
  const settingsPath = join(fixture(), "settings.json");

  const first = doctor({ targetRoot: root, settingsPath, fix: true });
  assert.ok(first.repairs.length > 0, "first --fix run does work");

  const second = doctor({ targetRoot: root, settingsPath, fix: true });
  assert.equal(second.repairs.length, 0, "second --fix run is a no-op");
});
