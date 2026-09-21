import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { processSession } from "../src/cortex_hook.js";
import { handle } from "../src/cortex_mcp.js";
import { mintClaim, val } from "../src/ledger.js";
import { loadClaims, putClaim, repoLedger, stats } from "../src/ledger_store.js";
import { TOOLS } from "../src/mcp_tools.js";
import { fakeGithubPat } from "./_fixtures.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

test("handle: initialize advertises the forge-cortex server", async () => {
  const r = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
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
    "rank_code",
    "collide_check",
  ]) {
    assert.ok(names.includes(t), `exposes ${t}`);
  }
});

test("rank_code without an atlas answers built:false over stdio, never a throw", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-rank-"));
  const requests = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "rank_code", arguments: {} },
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
  assert.deepEqual(JSON.parse(call.result.content[0].text), { built: false });
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

test("handle: a tool handler that throws still gets a JSON-RPC error reply (no client hang)", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-throw-"));
  // `.forge` is a FILE, so every store write under it throws ENOTDIR inside the handler.
  writeFileSync(join(root, ".forge"), "not a dir");
  const requests = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "forge_remember", arguments: { name: "x", body: "y" } },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
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
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const failed = responses.find((x) => x.id === 1);
  assert.ok(failed, "the throwing call is answered");
  assert.equal(failed.error?.code, -32603);
  assert.match(failed.error.message, /forge_remember/);
  assert.ok(
    responses.some((x) => x.id === 2),
    "the server keeps serving after the failure",
  );
});

/** Drive the live server with tools/call requests; returns {id → text|error}. */
const callServer = (root, calls) => {
  const requests = calls.map((c, i) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name: c.name, arguments: c.arguments },
    }),
  );
  const r = spawnSync("node", [SERVER], {
    input: `${requests.join("\n")}\n`,
    encoding: "utf8",
    env: { ...process.env, FORGE_ROOT: root, FORGE_AUTHOR: "Alice Human <alice@corp>" },
    timeout: 10000,
  });
  const out = {};
  for (const l of r.stdout.trim().split("\n").filter(Boolean)) {
    const x = JSON.parse(l);
    out[x.id] = x.result?.content?.[0]?.text ?? x.error;
  }
  return out;
};

/** A ledger with two fact claims whose ids share their first two hex chars. */
const ledgerWithTwinPrefix = () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-led-"));
  const dir = repoLedger(root);
  const first = mintClaim({ kind: "fact", body: { name: "a", text: "t0" } }).claim;
  putClaim(dir, first);
  for (let i = 1; ; i++) {
    const c = mintClaim({ kind: "fact", body: { name: "a", text: `t${i}` } }).claim;
    if (c.id.slice(0, 2) === first.id.slice(0, 2)) {
      putClaim(dir, c);
      return { root, dir, ids: [first.id, c.id].sort() };
    }
  }
};

test("forge_ledger_retract refuses anything but one full claim id (C2)", () => {
  const { root, dir, ids } = ledgerWithTwinPrefix();
  const out = callServer(root, [
    { name: "forge_ledger_retract", arguments: { id: "nonexistent", reason: "test" } },
    { name: "forge_ledger_retract", arguments: { id: ids[1].slice(0, 2), reason: "stale" } },
    { name: "forge_ledger_retract", arguments: { id: ids[1].slice(0, 12), reason: "stale" } },
    { name: "forge_ledger_retract", arguments: { id: "f".repeat(64), reason: "stale" } },
  ]);
  for (const id of [1, 2, 3]) assert.match(out[id], /full 64-character claim id/, `call ${id}`);
  assert.match(out[4], /No claim matching/);
  assert.equal(loadClaims(dir).length, 2, "a refused call writes nothing at all");
});

test("forge_ledger_retract only PROPOSES: the claim stays live and the proposal is visible", () => {
  const { root, dir, ids } = ledgerWithTwinPrefix();
  const before = val(loadClaims(dir).find((c) => c.id === ids[1]));
  const out = callServer(root, [
    { name: "forge_ledger_retract", arguments: { id: ids[1], reason: "stale value" } },
    { name: "forge_ledger_query", arguments: { query: "a t1" } },
  ]);
  assert.match(out[1], /Proposed retraction/);
  assert.match(out[1], /stays live until a human confirms/);
  const target = loadClaims(dir).find((c) => c.id === ids[1]);
  assert.equal(target.tombstone, undefined, "no permanent tombstone from an agent-callable tool");
  assert.equal(val(target), before, "a proposal lowers nothing");
  const proposal = loadClaims(dir).find((c) => c.body?.retracts === ids[1]);
  assert.equal(proposal.provenance.author, "agent:mcp", "stamped as the agent, never the human");
  assert.equal(proposal.body.reason, "stale value");
  assert.equal(stats(dir).pendingRetractions, 1, "visible in ledger stats");
  const row = JSON.parse(out[2]).results.find((r) => r.id === ids[1]);
  assert.deepEqual(row.pendingRetraction, ["stale value"], "visible in ledger query output");
});

test("forge_ledger_ratify is stamped agent:mcp, changes no confidence, and says so (C2)", () => {
  const { root, dir, ids } = ledgerWithTwinPrefix();
  const before = val(loadClaims(dir).find((c) => c.id === ids[0]));
  const out = callServer(root, [
    { name: "forge_ledger_ratify", arguments: { id: ids[0].slice(0, 2) } },
    { name: "forge_ledger_ratify", arguments: { id: ids[0] } },
  ]);
  assert.match(out[1], /No claim matching|ambiguous/i, "an ambiguous prefix is refused");
  assert.match(out[2], /not a human ratification/i);
  const decision = loadClaims(dir).find((c) => c.kind === "decision");
  assert.equal(decision.body.ratifies, ids[0]);
  assert.equal(decision.provenance.author, "agent:mcp");
  assert.ok(
    decision.provenanceAll.every((p) => !/alice/i.test(p.author ?? "")),
    "the human's identity is never used",
  );
  assert.equal(val(loadClaims(dir).find((c) => c.id === ids[0])), before, "val unchanged");
  const tool = TOOLS.find((t) => t.name === "forge_ledger_ratify");
  assert.doesNotMatch(tool.description, /promote .*confidence/i, "no false promise in the schema");
});

test("forge_remember reports a refusal instead of claiming it remembered", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-refuse-"));
  const out = callServer(root, [
    { name: "forge_remember", arguments: { name: "gh", body: `GITHUB_TOKEN=${fakeGithubPat()}` } },
    { name: "forge_brain", arguments: {} },
  ]);
  assert.match(out[1], /Not remembered/);
  assert.match(out[1], /secret/i);
  assert.deepEqual(JSON.parse(out[2]).items, [], "and nothing was stored");
});
