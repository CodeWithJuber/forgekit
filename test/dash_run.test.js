// Exercise the real browser transport and durable executor with one synthetic,
// loopback-only provider. The provider waits so concurrency is deterministic.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../src/dash.js";
import { initHarness, trustHarness } from "../src/harness_config.js";
import { defaultHarnessRouting, harnessRouteFingerprint } from "../src/harness_router.js";
import { pruneHarnessRuns, readHarnessRun } from "../src/harness_trace.js";

async function address(server) {
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function dashboard(t, root, host = "127.0.0.1") {
  const server = serve(root, { port: 0, host });
  t.after(() => server.close());
  const base = await address(server);
  const page = await (await fetch(base)).text();
  const token = /name="forge-dash-token" content="([0-9a-f]+)"/.exec(page)?.[1];
  assert.ok(token);
  return {
    snapshot: async () => (await fetch(`${base}/api/harness`)).json(),
    post: (payload, key, headers = {}) =>
      fetch(`${base}/api/harness/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forge-token": token,
          "idempotency-key": key,
          ...headers,
        },
        body: JSON.stringify(payload),
      }),
  };
}

test("dashboard intake requires an authorized local origin and a trusted worktree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-dash-post-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = await dashboard(t, root),
    remote = await dashboard(t, root, "0.0.0.0");
  const key = randomUUID(),
    task = { task: "Review the fixture." };
  assert.equal((await local.post(task, key, { "x-forge-token": "bad" })).status, 403);
  assert.equal((await local.post(task, key, { origin: "https://example.invalid" })).status, 403);
  assert.equal((await local.post(task, key, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await remote.post(task, key)).status, 403);
  assert.equal((await local.post(task, key, { "content-type": "text/plain" })).status, 415);
  assert.equal((await local.post(task, key)).status, 409);
  assert.equal((await local.snapshot()).runs.length, 0);
});

test("browser starts a durable run from a subdirectory and retries without duplicating work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-dash-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const nested = join(root, "src");
  mkdirSync(nested);
  initHarness(root, { hosts: ["generic"], supervised: true });
  let requests = 0,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const provider = createServer(async (req, res) => {
    requests++;
    req.resume();
    await held;
    // Return a provider failure to exercise a controlled terminal state.
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "private provider canary" }));
  });
  provider.listen(0, "127.0.0.1");
  t.after(() => {
    release();
    provider.close();
  });
  const routing = defaultHarnessRouting();
  routing.routes[0].baseUrl = `${await address(provider)}/v1`;
  writeFileSync(join(root, "harness", "routing.yaml"), JSON.stringify(routing));
  trustHarness(root);
  const before = process.env.FORGE_HARNESS_TRUSTED_ROUTES;
  process.env.FORGE_HARNESS_TRUSTED_ROUTES = harnessRouteFingerprint(routing.routes[0]);
  t.after(() => {
    if (before === undefined) delete process.env.FORGE_HARNESS_TRUSTED_ROUTES;
    else process.env.FORGE_HARNESS_TRUSTED_ROUTES = before;
  });
  const browser = await dashboard(t, nested);
  const file = join(root, "harness", "policy.yaml");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.hosts.push("kimi");
  writeFileSync(file, JSON.stringify(policy));
  assert.equal((await browser.post({ task: "Inspect fixture" }, randomUUID())).status, 409);
  trustHarness(root);
  const payload = { task: "Read fixture auth=demo-canary", acceptance: ["Read the file"] },
    key = randomUUID();
  assert.equal((await browser.snapshot()).state, "active");
  assert.equal((await browser.post({ ...payload, profile: "admin" }, key)).status, 400);
  const first = await browser.post(payload, key);
  assert.equal(first.status, 202);
  const { id, status } = await first.json();
  assert.equal(status, "accepted");
  assert.equal(readHarnessRun(root, id).id, id, "202 follows a durable checkpoint");
  const second = await browser.post(payload, key);
  assert.equal(second.status, 202);
  assert.equal((await second.json()).id, id);
  assert.equal(
    (await browser.post({ ...payload, acceptance: ["Changed criterion"] }, key)).status,
    409,
  );
  assert.equal((await browser.post(payload, randomUUID())).status, 409);
  const secondWindow = await dashboard(t, root);
  assert.equal(
    (await secondWindow.post(payload, key)).status,
    409,
    "the durable writer owns this run",
  );
  release();
  let row;
  for (let i = 0; i < 200; i++) {
    row = (await browser.snapshot()).runs.find((run) => run.id === id);
    if (row && row.status !== "running") break;
    await delay(25);
  }
  assert.equal(row?.status, "provider_failed");
  assert.equal(row.verified, false);
  assert.doesNotMatch(JSON.stringify(row), /demo-canary|private provider canary|tracePath/);
  // Retention removes the original task and criteria but preserves the idempotency binding.
  assert.equal(pruneHarnessRuns(root, { now: Date.now() + 31 * 86400000 }).pruned, 1);
  assert.equal((await browser.snapshot()).runs[0].task, null);
  // Another dashboard process reuses the recorded run even after the first process completes.
  const reopened = await dashboard(t, root);
  const replay = await reopened.post(payload, key);
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), { id, status: "accepted" });
  assert.equal(
    (await reopened.post({ ...payload, acceptance: ["New after restart"] }, key)).status,
    409,
  );
  assert.equal(requests, 1);
  assert.equal((await reopened.snapshot()).runs.length, 1);
});
