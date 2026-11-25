import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build as buildAtlas, has } from "../src/atlas.js";
import { BRAND } from "../src/brand.js";
import { processSession } from "../src/cortex_hook.js";
import { handle } from "../src/cortex_mcp.js";
import { mintClaim, val } from "../src/ledger.js";
import { loadClaims, putClaim, repoLedger, stats } from "../src/ledger_store.js";
import { TOOLS } from "../src/mcp_tools.js";
import { MCP_TOOL_GUIDE, mcpInstructions, ORIENT_TOOLS } from "../src/orient.js";
import { epochDay } from "../src/util.js";
import { fakeGithubPat } from "./_fixtures.js";

test("handle: initialize advertises the forge-cortex server", async () => {
  const r = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(r.result.serverInfo.name, "forge-cortex");
});

test("an unfamiliar MCP client sees the boundaries of its tool permissions", async () => {
  const session = { host: undefined };
  const reply = await handle(
    { id: 1, method: "initialize", params: { clientInfo: { name: "Local Research Planner" } } },
    session,
  );
  assert.equal(session.host, undefined);
  assert.match(reply.result.instructions, /client controls its native tools and permissions/);
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
    "forge_models",
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

test("MCP exposes offline model inventory and honors profile constraints in recommendations", async () => {
  const call = async (name, args) =>
    (await handle({ id: 2, method: "tools/call", params: { name, arguments: args } })).result;
  const listing = JSON.parse(
    (await call("forge_models", { profile: "anthropic" })).content[0].text,
  );
  assert.equal(listing.modelControl.nativeAgent, "host-managed");
  assert.equal(listing.profiles[0].status, "credential-missing");
  const routing = JSON.parse(
    (await call("route_task", { profile: "anthropic", task: "read docs", band: "high" })).content[0]
      .text,
  );
  assert.equal(routing.ok, false);
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

test("MCP preflight distinguishes partial, resolved and unreferenced tasks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = ["alphaSymbol", "betaSymbol"];
  for (const name of names)
    writeFileSync(join(root, name + ".js"), `export function ${name}() {}\n`);
  const partial = buildAtlas({ root, cap: 1 });
  const indexed = names.find((s) => has(partial, s));
  const unchecked = names.find((s) => !has(partial, s));
  assert.ok(indexed && unchecked);
  const call = (task) => {
    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "preflight_check", arguments: { task } },
    };
    const child = spawnSync(process.execPath, [SERVER], {
      input: JSON.stringify(req) + "\n",
      encoding: "utf8",
      env: { ...process.env, FORGE_ROOT: root },
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout).result.content[0].text;
  };
  const mixed = call(`Update \`${indexed}\` and \`${unchecked}\``);
  assert.match(mixed, /partial repository index/i);
  assert.match(mixed, /1 file.*indexed.*1 omitted/i);
  assert.ok(mixed.includes(unchecked));
  assert.doesNotMatch(mixed, /all clear/i);
  assert.match(call(`Update \`${indexed}\``), /all clear/i);
  assert.match(call("continue"), /no named code references/i);
  buildAtlas({ root });
  assert.match(call(`Update \`${indexed}\` and \`${unchecked}\``), /all clear/i);
});

test("live server over stdio returns learned lessons for a repo", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-"));
  const session = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, session(), epochDay() - 1, { sessionId: "first-session" });
  processSession(root, session(), epochDay(), { sessionId: "second-session" }); // → active lesson

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

test("forge_remember makes a private proposal and only human approval publishes it", async () => {
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
  const id = /Private proposal ([0-9a-f]{64})/.exec(call.result.content[0].text)?.[1];
  assert.ok(id);
  assert.equal(existsSync(join(root, ".forge", "brain", "facts", "test-fact.md")), false);
  assert.deepEqual(loadClaims(repoLedger(root)), []);
  const { listProposals, reviewProposal, proposeMemory } = await import(
    "../src/memory_proposals.js"
  );
  assert.equal(listProposals(root)[0].id, id);
  reviewProposal(root, id, true);
  assert.equal(
    loadClaims(repoLedger(root)).find((c) => c.kind === "fact")?.body.text,
    "testing MCP write",
  );
  const other = proposeMemory(root, "test-fact", "different value");
  assert.throws(() => reviewProposal(root, other.id, true), /Conflict/);
  reviewProposal(root, other.id, false);
  assert.deepEqual(listProposals(root), []);
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
    env: { ...process.env, FORGE_ROOT: root, FORGE_HOME: root },
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

test("malformed MCP frame gets parse error and next request succeeds", () => {
  const r = spawnSync("node", [SERVER], {
    input: '{broken\n{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n',
    encoding: "utf8",
  });
  const replies = r.stdout
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.equal(replies.find((x) => x.id === null)?.error.code, -32700);
  assert.ok(replies.find((x) => x.id === 3)?.result.tools.length);
});
