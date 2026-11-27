import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/brand.js";
import { processSession } from "../src/cortex_hook.js";
import { handle, LEGACY_VERSIONS, MODERN_VERSIONS, SUPPORTED_VERSIONS } from "../src/cortex_mcp.js";
import { mintClaim, val } from "../src/ledger.js";
import { loadClaims, putClaim, repoLedger, stats } from "../src/ledger_store.js";
import { TOOLS } from "../src/mcp_tools.js";
import { MCP_TOOL_GUIDE, mcpInstructions, ORIENT_TOOLS } from "../src/orient.js";
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

test("handle: initialize carries instructions that say when to use the listed tools", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const text = r.result.instructions;
  assert.equal(typeof text, "string");
  assert.ok(text.startsWith(BRAND.brand), "leads with the brand");
  // A host cuts server instructions at 4,096 characters; these stay well under it.
  assert.ok(text.length <= 2000, `instructions are ${text.length} characters`);
  for (const [when, names] of MCP_TOOL_GUIDE) {
    assert.ok(text.includes(`${when}: `), when);
    for (const n of names) assert.ok(text.includes(n), `names ${n}`);
  }
});

test("the MCP tool guide says when to use every registered tool, once", () => {
  const guided = MCP_TOOL_GUIDE.flatMap(([, names]) => names);
  assert.deepEqual([...guided].sort(), TOOLS.map((t) => t.name).sort());
  assert.equal(new Set(guided).size, guided.length, "no tool sits in two groups");
  // The orientation's short list is part of the guide, under the same words.
  const guide = new Map(MCP_TOOL_GUIDE.map(([when, names]) => [when, names]));
  for (const [when, names] of ORIENT_TOOLS)
    for (const n of names) assert.ok(guide.get(when)?.includes(n), `${when}: ${n}`);
  // Tools that install, propose a ledger change or start a run are never in the "without
  // waiting to be asked" part.
  const onRequest = MCP_TOOL_GUIDE.filter(([, , mode]) => mode === "ask").flatMap(([, n]) => n);
  for (const n of ["forge_tool_install", "forge_ledger_ratify", "forge_ledger_retract"])
    assert.ok(onRequest.includes(n), n);
  for (const n of ["forge_harness_run", "forge_harness_status"])
    assert.ok(onRequest.includes(n), n);
});

test("mcpInstructions: a tool the server does not list is never advertised", () => {
  assert.equal(mcpInstructions([]), "");
  // A supervised workspace lists only the harness pair, and only that pair is named.
  const supervised = mcpInstructions(["forge_harness_run", "forge_harness_status"]);
  assert.match(supervised, /supervised runs: forge_harness_run, forge_harness_status/);
  assert.doesNotMatch(supervised, /substrate_check|forge_ledger_query|without waiting/);
  const one = mcpInstructions(["forge_diagnose"]);
  assert.match(one, /repeat failure: forge_diagnose/);
  assert.doesNotMatch(one, /substrate_check|forge_ledger_query|forge_harness_run/);
});

test("initialize still answers when the harness activation is unreadable — no instructions", () => {
  // The handshake must not depend on harness state: a broken binding used to surface only at
  // tools/list, and a host that gets an error from initialize never connects at all.
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-init-"));
  const state = mkdtempSync(join(tmpdir(), "forge-mcp-state-"));
  const digest = createHash("sha256").update(realpathSync.native(root)).digest("hex");
  mkdirSync(join(state, "harness-activation"), { recursive: true });
  writeFileSync(join(state, "harness-activation", `${digest}.json`), "{}");
  const r = spawnSync("node", [SERVER], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    encoding: "utf8",
    env: { ...process.env, FORGE_ROOT: root, FORGE_HOME: state },
    timeout: 10000,
  });
  const reply = JSON.parse(r.stdout.trim().split("\n")[0]);
  assert.equal(reply.error, undefined, "initialize answers with a result");
  assert.equal(reply.result.serverInfo.name, "forge-cortex");
  assert.equal("instructions" in reply.result, false);
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

// ---- protocol revisions -------------------------------------------------------------
// From 2026-07-28 MCP has no handshake: each request names its revision in `_meta`. The
// specification lists "modern client, legacy server" as a failure, so both are served.
const modernMeta = (version = MODERN_VERSIONS[0], client = "ExampleClient") => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: client, version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

test("server/discover answers a modern client without a handshake", async () => {
  const r = await handle({
    jsonrpc: "2.0",
    id: "discover-1",
    method: "server/discover",
    params: { _meta: modernMeta() },
  });
  assert.equal(r.error, undefined);
  assert.equal(r.result.resultType, "complete");
  assert.deepEqual(r.result.supportedVersions, SUPPORTED_VERSIONS);
  assert.equal(r.result.supportedVersions[0], "2026-07-28", "the modern revision leads");
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result._meta["io.modelcontextprotocol/serverInfo"].name, "forge-cortex");
  assert.equal(typeof r.result.instructions, "string");
  // Every discovery result must carry cache hints; this server can only promise "stale".
  assert.equal(r.result.ttlMs, 0);
  assert.equal(r.result.cacheScope, "private");
});

test("a modern request for a revision this server does not speak is refused with the list", async () => {
  for (const method of ["server/discover", "tools/list", "tools/call"]) {
    const r = await handle({
      jsonrpc: "2.0",
      id: 7,
      method,
      params: { _meta: modernMeta("1900-01-01"), name: "cortex_status", arguments: {} },
    });
    assert.equal(r.result, undefined, method);
    assert.equal(r.error.code, -32022, method);
    assert.deepEqual(r.error.data, { supported: SUPPORTED_VERSIONS, requested: "1900-01-01" });
  }
  // A handshake-era revision named in `_meta` is not a modern revision either.
  const legacyInMeta = await handle({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/list",
    params: { _meta: modernMeta(LEGACY_VERSIONS[0]) },
  });
  assert.equal(legacyInMeta.error.code, -32022);
});

test("modern tools/list carries result type and cache hints; the handshake-era shape is unchanged", async () => {
  const ask = () =>
    handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernMeta() } });
  const modern = await ask();
  assert.equal(modern.result.resultType, "complete");
  assert.equal(modern.result.ttlMs, 0);
  assert.equal(modern.result.cacheScope, "private");
  // The same order on every call, so a host's prompt cache survives a re-list.
  const again = await ask();
  assert.deepEqual(
    modern.result.tools.map((t) => t.name),
    again.result.tools.map((t) => t.name),
  );
  const legacy = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(Object.keys(legacy.result), ["tools"]);
  assert.deepEqual(
    legacy.result.tools.map((t) => t.name),
    modern.result.tools.map((t) => t.name),
  );
});

test("modern tools/call marks its result complete; a handshake-era call does not gain the field", async () => {
  const call = (params) => handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params });
  const modern = await call({ _meta: modernMeta(), name: "cortex_status", arguments: {} });
  assert.equal(modern.result.resultType, "complete");
  assert.equal(modern.result.content[0].type, "text");
  const legacy = await call({ name: "cortex_status", arguments: {} });
  assert.deepEqual(Object.keys(legacy.result), ["content"]);
  assert.equal(legacy.result.content[0].text, modern.result.content[0].text);
});

test("initialize answers with the revision asked for when it is one this server speaks", async () => {
  const negotiated = async (protocolVersion) =>
    (await handle({ jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion } }))
      .result.protocolVersion;
  for (const v of LEGACY_VERSIONS) assert.equal(await negotiated(v), v);
  // 2025-03-26 obliges a server to accept batches, which this one does not: fall back.
  for (const v of ["2025-03-26", "2099-01-01", undefined, 7])
    assert.equal(await negotiated(v), "2024-11-05", String(v));
  // The modern revision is never agreed through a handshake it does not have.
  assert.equal(await negotiated("2026-07-28"), "2024-11-05");
});

test("ping is answered for handshake-era clients and is an unknown method for modern ones", async () => {
  const legacy = await handle({ jsonrpc: "2.0", id: 6, method: "ping" });
  assert.deepEqual(legacy.result, {});
  const modern = await handle({
    jsonrpc: "2.0",
    id: 6,
    method: "ping",
    params: { _meta: modernMeta() },
  });
  assert.equal(modern.error.code, -32601);
});

test("a modern exchange over stdio needs no initialize first", () => {
  const frames = [
    { jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: modernMeta() } },
    { jsonrpc: "2.0", id: "l", method: "tools/list", params: { _meta: modernMeta() } },
  ];
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/cortex_mcp.js", import.meta.url))],
    {
      input: `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`,
      encoding: "utf8",
      env: { ...process.env, FORGE_ROOT: mkdtempSync(join(tmpdir(), "forge-mcp-modern-")) },
    },
  );
  const replies = r.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const byId = Object.fromEntries(replies.map((x) => [x.id, x]));
  assert.equal(byId.d.result.supportedVersions[0], "2026-07-28");
  assert.equal(byId.l.result.resultType, "complete");
  assert.ok(byId.l.result.tools.length > 0);
});
