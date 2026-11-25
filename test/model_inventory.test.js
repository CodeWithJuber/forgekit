import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultHarnessRouting } from "../src/harness_router.js";
import { selectHarnessRoute } from "../src/harness_runtime.js";
import { buildHttpRunner } from "../src/llm.js";
import { inventoryRoute, modelInventory, workloadRatings } from "../src/model_inventory.js";
import { modelScope } from "../src/model_scope.js";
import { activeProvider, addProvider, setProfileModel } from "../src/providers.js";

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function env(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const prev = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    });
  }
}
const response = (data) => ({
  status: 200,
  headers: { "cache-control": "max-age=60" },
  body: JSON.stringify(data),
});

test("private model cache identifiers bind the installation, purpose and account", (t) => {
  const root = repo(t);
  const state = repo(t);
  env(t, { FORGE_HOME: state });
  const fields = ["fixture-provider"];
  const id = modelScope(root, "inventory", fields, "fixture-account");
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(modelScope(root, "inventory", fields, "fixture-account"), id);
  assert.notEqual(modelScope(root, "model-call", fields, "fixture-account"), id);
  assert.notEqual(modelScope(root, "inventory", fields, "rotated"), id);
  process.env.FORGE_HOME = repo(t);
  assert.notEqual(modelScope(root, "inventory", fields, "fixture-account"), id);
  writeFileSync(join(process.env.FORGE_HOME, "model-scope.key"), "invalid");
  assert.equal(modelScope(root, "inventory", fields), null);
});

test("inventory spans profiles, follows provider pagination and preserves offline account boundaries", (t) => {
  const root = repo(t);
  env(t, { OPENAI_API_KEY: "fixture-a", GEMINI_API_KEY: "fixture-b" });
  let calls = 0;
  const fetchImpl = ({ url, headers }) => {
    calls++;
    const target = new URL(url);
    if (target.origin === "https://api.openai.com") {
      assert.equal(headers.authorization, "Bearer fixture-a");
      return response({ data: [{ id: "shared" }] });
    }
    assert.equal(target.origin, "https://generativelanguage.googleapis.com");
    assert.equal(headers["x-goog-api-key"], "fixture-b");
    return target.searchParams.get("pageToken") === "two"
      ? response({ models: [{ name: "models/new" }] })
      : response({
          models: [{ name: "models/shared", supportedGenerationMethods: ["generateContent"] }],
          nextPageToken: "two",
        });
  };
  const inv = modelInventory(root, { refresh: true, fetchImpl, now: 1000 });
  assert.equal(calls, 3);
  assert.equal(inv.profiles.length, 2);
  const g = inv.profiles.find((p) => p.profile === "gemini");
  assert.deepEqual(
    g.models.map((m) => m.id),
    ["new", "shared"],
  );
  assert.equal(g.models[0].rating.band, "unrated");
  const off = () =>
    modelInventory(root, {
      profile: "gemini",
      refresh: false,
      fetchImpl: () => assert.fail("offline fetch"),
      now: 2000,
    }).profiles[0];
  assert.equal(off().status, "cached");
  process.env.GEMINI_API_KEY = "rotated-key";
  assert.equal(off().status, "offline");
  process.env.GEMINI_API_KEY = "fixture-b";
  const refused = modelInventory(root, {
    profile: "gemini",
    refresh: true,
    fetchImpl: () => ({ status: 403 }),
  }).profiles[0];
  assert.equal(refused.status, "denied");
  assert.deepEqual(refused.models, []);
  assert.equal(off().status, "denied");
  assert.deepEqual(off().models, []);
  const restored = modelInventory(root, {
    profile: "gemini",
    refresh: true,
    fetchImpl,
  }).profiles[0];
  assert.equal(restored.status, "complete");
  assert.equal(restored.models.length, 2);
});

test("custom endpoint edits need a matching private binding; incomplete pagination keeps previous snapshot", (t) => {
  const root = repo(t);
  addProvider(root, "lab", { format: "openai", baseUrl: "http://localhost:8701/v1", models: {} });
  const opts = { profile: "lab", refresh: true };
  const first = modelInventory(root, {
    ...opts,
    fetchImpl: () => response({ data: [{ id: "previous" }] }),
  }).profiles[0];
  assert.equal(first.status, "complete");
  const result = modelInventory(root, {
    ...opts,
    fetchImpl: ({ url }) =>
      new URL(url).searchParams.get("after") === "next"
        ? null
        : response({ data: [{ id: "partial" }], has_more: true, last_id: "next" }),
  }).profiles[0];
  assert.equal(result.status, "partial");
  assert.equal(result.models[0].id, "previous");
  const f = join(root, ".forge", "providers.json");
  const c = JSON.parse(readFileSync(f, "utf8"));
  c.providers.lab.baseUrl = "http://localhost:8702/v1";
  writeFileSync(f, JSON.stringify(c));
  assert.equal(
    modelInventory(root, { ...opts, fetchImpl: () => assert.fail("untrusted fetch") }).profiles[0]
      .status,
    "untrusted",
  );
});

test("real HTTP child serializes explicit and fallback model IDs on the selected provider wire", (t) => {
  const root = repo(t);
  env(t, {
    OPENAI_API_KEY: "fixture",
    GEMINI_API_KEY: "fixture",
    ANTHROPIC_MODEL: "foreign-override",
  });
  const spawn = (binary, argv, options) =>
    spawnSync(
      binary,
      [
        "-e",
        `globalThis.fetch=async(url,req)=>{ const body=JSON.parse(req.body),id=body.model; if(url.startsWith("https://api.openai.com/") && body.max_completion_tokens!==1024) throw Error("OpenAI completion limit"); return {ok:true,json:async()=>({model:"returned-"+id,choices:[{message:{content:id}}]})}};\n${argv[1]}`,
      ],
      options,
    );
  let receipt;
  const run = (profile, model) =>
    buildHttpRunner({
      root,
      profile,
      model,
      spawn,
      onReceipt: (r) => {
        receipt = r;
      },
    })("task");
  for (const profile of ["openai", "gemini"]) {
    assert.equal(run(profile, "my-exact-id"), "my-exact-id");
    assert.equal(receipt.sent, "my-exact-id");
    assert.equal(receipt.returned, "returned-my-exact-id");
    assert.equal(receipt.profile, profile);
  }
  assert.equal(run("openai", "haiku"), "gpt-5-nano");
  setProfileModel(root, "openai", "chosen");
  assert.equal(activeProvider(root).name, "openai");
  assert.equal(run("openai", "haiku"), "chosen");
  assert.equal(run("openai", "explicit"), "explicit");
  assert.equal(run("gemini", "haiku"), "gemini-2.5-flash-lite");
});

test("model filters use advertised capabilities and timestamped calls scoped to the credential", (t) => {
  const root = repo(t);
  env(t, { OPENAI_API_KEY: "inventory-filter-fixture" });
  const now = Date.now();
  const result = (options = {}) =>
    modelInventory(root, {
      profile: "openai",
      refresh: false,
      ...options,
    }).profiles[0];
  const list = result({
    now,
    refresh: true,
    capability: "input:image",
    availability: "listed",
    maxAge: "1h",
    fetchImpl: () =>
      response({
        data: [
          { id: "vision-fixture", architecture: { input_modalities: ["image"] } },
          { id: "plain-fixture" },
        ],
      }),
  });
  assert.deepEqual(
    list.models.map((m) => m.id),
    ["vision-fixture"],
  );
  assert.deepEqual(
    result({ capability: "unknown" }).models.map((m) => m.id),
    ["plain-fixture"],
  );
  const recent = { availability: "recently-callable", maxAge: "1h" };
  assert.equal(result(recent).models.length, 0);
  assert.throws(() => result({ availability: "recently-callable" }), /max-age/);
  const dispatch = (reply) =>
    buildHttpRunner({
      root,
      profile: "openai",
      model: "vision-fixture",
      spawn: () => reply,
    })("local fixture");
  dispatch({ status: 0, stdout: JSON.stringify({ text: "done", model: "observed-revision" }) });
  const called = result(recent).models;
  assert.equal(called.length, 1);
  assert.equal(called[0].lastCall.returned, "observed-revision");
  assert.equal(called[0].lastCall.costUsd, null);
  assert.equal(result({ ...recent, now: now + 7200000 }).models.length, 0);
  assert.throws(() => dispatch({ status: 1, stderr: "llm: http 403" }), /403/);
  assert.equal(result(recent).models.length, 0);
  assert.deepEqual(
    result({ availability: "denied" }).models.map((m) => m.id),
    ["vision-fixture"],
  );
  process.env.OPENAI_API_KEY = "different-inventory-fixture";
  assert.equal(result({ availability: "denied" }).models.length, 0);
  assert.ok(
    result({ availability: "unknown" }).models.some(
      (row) => row.availability === "configured-only",
    ),
  );
  assert.equal(result({ availability: "unknown", maxAge: "1h" }).models.length, 0);
  assert.throws(() => result({ maxAge: "999999999999d" }), /too large/);
});

test("bands require separated scores on the same verified first-attempt workload", () => {
  const rows = [];
  for (let n = 0; n < 100; n++)
    for (const [model, passed] of [
      ["a", false],
      ["b", n % 2 === 0],
      ["c", true],
    ])
      rows.push({
        model,
        task: `task${n}`,
        passed,
        provenance: "verify-event",
        workload: "repair",
      });
  rows.push(
    { ...rows[0], passed: true },
    { ...rows[0], model: "unknown", provenance: "self-reported" },
  );
  const r = workloadRatings(rows, "repair");
  assert.deepEqual(
    [...r.values()].map((x) => x.band),
    ["low", "medium", "high"],
  );
  assert.equal(r.get("a").n, 100);
  assert.equal(r.get("a").score, 0);
  assert.equal(workloadRatings(rows).size, 0);
  assert.equal(workloadRatings(rows.slice(0, 3), "repair").get("a").band, "unrated");
});

test("offline profile routing uses a fresh account listing and refuses stale or unrated candidates", (t) => {
  const root = repo(t);
  env(t, { ANTHROPIC_API_KEY: "fixture-route" });
  const options = { profile: "anthropic" };
  const id = "claude-haiku-4-5-20251001";
  const fetchImpl = () => response({ data: [{ id }, { id: "no-registry-binding" }] });
  const task = "Update the parser tests";
  modelInventory(root, { ...options, refresh: true, fetchImpl });
  const result = inventoryRoute(root, task, options);
  assert.equal(result.ok, true);
  assert.equal(result.listing, "cached");
  assert.ok("cascade" in result);
  assert.deepEqual(
    result.cascade.map((r) => r.model),
    ["claude-haiku-4.5"],
  );
  assert.equal(inventoryRoute(root, task, { ...options, band: "high" }).ok, false);
  modelInventory(root, { ...options, now: 1000, refresh: true, fetchImpl });
  assert.equal(inventoryRoute(root, task, options).ok, false);
});

test("harness selection intersects exact ID, operator provider binding, and route configuration", (t) => {
  const root = repo(t);
  addProvider(root, "lab", {
    format: "openai",
    baseUrl: "http://localhost:8081/v1",
    envKey: "LAB_SLOT",
  });
  const record = { ...defaultHarnessRouting().routes[0], model: "shared", apiKeyEnv: "LAB_SLOT" };
  const routing = {
    routes: [
      { ...record, id: "a", baseUrl: "http://localhost:8081/v1" },
      { ...record, id: "b", baseUrl: "http://localhost:8082/v1" },
    ],
  };
  assert.throws(() => selectHarnessRoute(root, routing, { model: "shared" }), /one configured/);
  assert.equal(selectHarnessRoute(root, routing, { model: "shared", modelProfile: "lab" }).id, "a");
  assert.throws(
    () => selectHarnessRoute(root, routing, { route: "b", modelProfile: "lab" }),
    /one configured/,
  );
  assert.throws(
    () => selectHarnessRoute(root, routing, { route: "a", model: "typo" }),
    /one configured/,
  );
  assert.equal(selectHarnessRoute(root, routing), null);
});
