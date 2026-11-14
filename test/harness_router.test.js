import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createHarnessModel,
  defaultHarnessRouting,
  describeHarnessRoutes,
  harnessRouteFingerprint,
} from "../src/harness_router.js";
import { harnessSpend, reserveHarnessSpend } from "../src/harness_spend.js";

const area = mkdtempSync(join(tmpdir(), "forge-harness-router-"));
const work = join(area, "work");
mkdirSync(work);
const original = process.env.FORGE_HOME;
process.env.FORGE_HOME = join(area, "state");
after(() => {
  if (original === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = original;
  rmSync(area, { recursive: true, force: true });
});
const ledger = { root: work, ceilings: { dailyUsd: 5, projectUsd: 5 } };
const local = defaultHarnessRouting().routes[0];
const paid = {
  ...local,
  id: "remote",
  baseUrl: "https://provider.example/v1",
  model: "frontier",
  apiKeyEnv: "HARNESS_TEST_KEY",
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 12,
  strength: 3,
};
const call = {
  messages: [{ role: "user", content: "Find the line." }],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
  maxTokens: 5000,
  maxCostUsd: 0.02,
  step: "code",
};
const reply = (message, usage = { prompt_tokens: 27, completion_tokens: 9 }) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
      usage,
    }),
    { headers: { "content-type": "application/json" } },
  );

test("a real OpenAI-compatible loopback service receives the capped tool schema and returns an actionable tool call", async (t) => {
  let observed;
  const server = createServer(async (req, res) => {
    const bytes = [];
    for await (const ch of req) bytes.push(ch);
    observed = { url: req.url, ...JSON.parse(Buffer.concat(bytes).toString()) };
    res.setHeader("content-type", "application/json");
    res.end(
      await reply({
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
        ],
      }).text(),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const r = { ...local, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const model = createHarnessModel(
    { routes: [r] },
    { trustedFingerprints: [harnessRouteFingerprint(r)] },
  );
  const output = await model(call);
  assert.equal(observed.url, "/v1/chat/completions");
  assert.deepEqual(observed.tools[0].function.parameters, call.tools[0].inputSchema);
  assert.equal(observed.max_tokens, 1024);
  assert.deepEqual(output.toolCalls, [{ id: "c1", name: "read_file", args: { path: "a.txt" } }]);
  assert.equal(output.tokens, 36);
  model.recordVerification(true, [r.id]);
  assert.deepEqual(model.statistics().local.verified, 1);
});

test("budget preflight skips untrusted/overbudget endpoints before a network call; redirects disabled", async () => {
  let seen = 0;
  const trusted = harnessRouteFingerprint(paid);
  const env = { HARNESS_TEST_KEY: "fixture-value" };
  const fetchImpl = async (_url, opts) => {
    seen++;
    assert.equal(opts.headers.authorization, "Bearer fixture-value");
    assert.equal(opts.redirect, "error");
    return reply({ content: "ok" });
  };
  const cfg = { routes: [paid] };
  await assert.rejects(createHarnessModel(cfg, { env, fetchImpl })(call), {
    code: "route_not_trusted",
  });
  env.FORGE_HARNESS_TRUSTED_ROUTES = trusted;
  const model = createHarnessModel(cfg, { ...ledger, env, fetchImpl });
  await assert.rejects(model({ ...call, maxCostUsd: 0 }), { code: "model_budget_exhausted" });
  await assert.rejects(model({ ...call, maxTokens: 1 }), { code: "model_budget_exhausted" });
  const tampered = { ...paid, baseUrl: "https://evil.example/v1" };
  await assert.rejects(createHarnessModel({ routes: [tampered] }, { env, fetchImpl })(call), {
    code: "route_not_trusted",
  });
  assert.equal(seen, 0);
  const answer = await model(call);
  assert.equal(answer.finalText, "ok");
  assert.equal(answer.costUsd, (27 * 3 + 9 * 12) / 1e6);
  assert.equal(seen, 1);
  assert.equal(describeHarnessRoutes(cfg)[0].fingerprint, trusted);
});

test("route pins bind the public credential selector independently of rotating secret values", async () => {
  const original = harnessRouteFingerprint(paid);
  const swapped = { ...paid, apiKeyEnv: "OTHER_SLOT" };
  assert.match(original, /^[a-f0-9]{64}@HARNESS_TEST_KEY$/);
  assert.notEqual(harnessRouteFingerprint(swapped), original);
  assert.match(harnessRouteFingerprint(local), /^[a-f0-9]{64}$/);
  assert.throws(() => harnessRouteFingerprint({ ...paid, apiKeyEnv: ["HARNESS_TEST_KEY"] }));

  let seen;
  const options = {
    ...ledger,
    env: { HARNESS_TEST_KEY: "rotated-fixture", OTHER_SLOT: "unused-fixture" },
    trustedFingerprints: [original],
    fetchImpl: async (_url, request) => {
      seen = request.headers.authorization;
      return reply({ content: "ok" });
    },
  };
  await assert.rejects(createHarnessModel({ routes: [swapped] }, options)(call), {
    code: "route_not_trusted",
  });
  assert.equal(seen, undefined);
  await createHarnessModel({ routes: [paid] }, options)(call);
  assert.equal(seen, "Bearer rotated-fixture");
});

test("declared fallback counts failed requests and malformed responses; missing usage consumes full reservation", async () => {
  const c = { ...paid, id: "other", model: "other-model" };
  for (const first of [
    new Response(null, { status: 429 }),
    reply({
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "bad" } },
      ],
    }),
    reply({ content: "   " }),
  ]) {
    const rs = [first, reply({ content: "fallback" }, null)];
    const model = createHarnessModel(
      { routes: [paid, c], chains: { code: ["remote", "other"] } },
      {
        ...ledger,
        env: { HARNESS_TEST_KEY: "test" },
        trustedFingerprints: [paid, c].map(harnessRouteFingerprint),
        fetchImpl: async () => rs.shift(),
      },
    );
    const outcome = await model({ ...call, maxCostUsd: 1 });
    assert.equal(outcome.route, "other");
    assert.equal(outcome.usageEstimated, true);
    assert.equal(outcome.routeAttempts.length, 2);
    assert.ok(outcome.tokens > 1024);
    assert.ok(outcome.costUsd > 0);
    assert.equal(rs.length, 0);
  }
});

test("model-independent security reviews retain strongest route; malformed usage cannot hide cost", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(null, { status: 429 });
  };
  const opts = {
    ...ledger,
    env: { HARNESS_TEST_KEY: "test" },
    trustedFingerprints: [harnessRouteFingerprint(paid)],
    fetchImpl,
  };
  const cfg = {
    routes: [local, paid],
    chains: { security: ["remote", "local"], review: ["remote", "local"] },
  };
  const model = createHarnessModel(cfg, opts);
  await assert.rejects(model({ ...call, authorRoute: "remote", step: "review" }), {
    code: "no_eligible_route",
  });
  await assert.rejects(model({ ...call, step: "security" }), { code: "http_429" });
  assert.deepEqual(calls, [`${paid.baseUrl}/chat/completions`]);
  const over = createHarnessModel(
    { routes: [paid] },
    {
      ...opts,
      fetchImpl: async () =>
        reply({ content: "ok" }, { prompt_tokens: 100000, completion_tokens: 3 }),
    },
  );
  await assert.rejects(
    over(call),
    (err) => err.code === "provider_usage_exceeded_reservation" && err.usage.tokens === 100003,
  );
});

test("unknown transport outcome consumes reservation before fallback", async () => {
  let requests = 0;
  const q = { ...paid, id: "fallback" };
  const model = createHarnessModel(
    { routes: [paid, q] },
    {
      ...ledger,
      env: { HARNESS_TEST_KEY: "test" },
      trustedFingerprints: [paid, q].map(harnessRouteFingerprint),
      fetchImpl: async () => {
        requests++;
        throw new Error("internal provider error potentially sensitive");
      },
    },
  );
  await assert.rejects(
    model({ ...call, maxTokens: 600 }),
    (e) =>
      e.code === "model_budget_exhausted" &&
      e.usage.tokens === 600 &&
      e.usage.costUsd > 0 &&
      !JSON.stringify(e).includes("potentially sensitive"),
  );
  assert.equal(requests, 1);
});

test("route pin needs a reason, normalized request never leaks the execute function or a secret URL", async () => {
  const model = createHarnessModel(undefined, {
    fetchImpl: async (_url, opts) => {
      assert.ok(!opts.body.includes("unsafeExecution"));
      return reply({ content: "OK" });
    },
  });
  await assert.rejects(model({ ...call, pin: "local" }), { code: "model_pin_needs_reason" });
  const output = await model({
    ...call,
    pin: "local",
    pinReason: "long refactor",
    tools: [{ name: "lookup", execute: () => "unsafeExecution" }],
  });
  assert.equal(output.pinReason, "long refactor");
  for (const baseUrl of [
    "https://someone:pass@provider.example/v1",
    "http://provider.example/v1",
    "https://provider.example/v1?api_key=A",
  ]) {
    assert.throws(() => createHarnessModel({ routes: [{ ...paid, baseUrl }] }));
  }
});

test("paid routing without project ceilings fails before dispatch", async () => {
  const model = createHarnessModel(
    { routes: [paid] },
    {
      trustedFingerprints: [harnessRouteFingerprint(paid)],
      env: { HARNESS_TEST_KEY: "test" },
      fetchImpl: () => assert.fail("must not dispatch"),
    },
  );
  await assert.rejects(model(call), { code: "project_spend_ceiling" });
});

test("independent processes share the same reservation across linked worktrees", async () => {
  const main = join(area, "main"),
    linked = join(area, "linked");
  execFileSync("git", ["init", "-q", main]);
  execFileSync("git", [
    "-C",
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "seed",
  ]);
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "--detach", linked, "HEAD"]);
  const childScript = `import {reserveHarnessSpend} from ${JSON.stringify(new URL("../src/harness_spend.js", import.meta.url).href)};
    const r=reserveHarnessSpend(process.argv[1],{dailyUsd:10,projectUsd:0.1},0.075); console.log(r.reason ?? "reserved");`;
  const run = (cwd) =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", childScript, cwd], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        error = "";
      c.stdout.on("data", (s) => (out += s));
      c.stderr.on("data", (s) => (error += s));
      c.on("error", reject);
      c.on("close", (code) => (code ? reject(new Error(error)) : resolve(out.trim())));
    });
  assert.deepEqual((await Promise.all([run(main), run(linked)])).sort(), [
    "project_spend_ceiling",
    "reserved",
  ]);
  for (const tree of [main, linked]) {
    const totals = harnessSpend(tree);
    assert.equal(totals.outstanding, 1);
    assert.equal(totals.projectUsd, 0.075);
  }
});

test("unbilled rejection refunds a reservation while uncertain calls remain charged against the UTC-day limit", () => {
  const a = join(area, "spend-a"),
    b = join(area, "spend-b");
  mkdirSync(a);
  mkdirSync(b);
  const initial = harnessSpend(a).dailyUsd;
  const ceilings = { projectUsd: 10, dailyUsd: initial + 0.4 };
  const r = reserveHarnessSpend(a, ceilings, 0.3);
  assert.equal(reserveHarnessSpend(b, ceilings, 0.3).reason, "daily_spend_ceiling");
  r.settle(0, false);
  const next = reserveHarnessSpend(b, ceilings, 0.3);
  next.settle(0.3, true);
  assert.equal(reserveHarnessSpend(a, ceilings, 0.3).reason, "daily_spend_ceiling");
  assert.equal(harnessSpend(a).projectUsd, 0);
  assert.equal(harnessSpend(b).projectUsd, 0.3);
});

test("a redirect from a pinned loopback model never forwards task data or its credential to the target", async (t) => {
  let reached = 0;
  const sink = createServer((_q, s) => {
    reached++;
    s.end("unexpected");
  });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const front = createServer((q, s) => {
    assert.equal(q.headers.authorization, "Bearer synthetic-test-auth");
    s.writeHead(307, { Location: `http://127.0.0.1:${sink.address().port}/target` });
    s.end();
  });
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all(
      [sink, front].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });
  const r = {
    ...local,
    baseUrl: `http://127.0.0.1:${front.address().port}/v1`,
    apiKeyEnv: "FIXTURE_KEY",
  };
  const model = createHarnessModel(
    { routes: [r] },
    {
      env: { FIXTURE_KEY: "synthetic-test-auth" },
      trustedFingerprints: [harnessRouteFingerprint(r)],
    },
  );
  await assert.rejects(
    model(call),
    (e) => e.code === "invalid_reply_or_transport" && e.usage.tokens > 0,
  );
  assert.equal(reached, 0);
});

test("even named loopback variants cannot read a credential before the operator pins their route", async () => {
  for (const change of [
    { apiKeyEnv: "TEST_TOKEN" },
    { baseUrl: "http://localhost:11435/v1", apiKeyEnv: "TEST_TOKEN" },
    { model: "billable-cloud-alias" },
  ]) {
    const route = { ...local, ...change };
    const env = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "TEST_TOKEN" ? assert.fail("read unapproved credentials") : undefined,
      },
    );
    const model = createHarnessModel(
      { routes: [route] },
      { env, fetchImpl: () => assert.fail("unapproved route was contacted") },
    );
    await assert.rejects(model(call), { code: "route_not_trusted" });
  }
});

test("provider completion with empty, zero, divergent or missing reported usage books its full reservation", async () => {
  for (const u of [
    null,
    {},
    { prompt_tokens: 0, completion_tokens: 1 },
    { prompt_tokens: 2, completion_tokens: 0 },
    { prompt_tokens: 2, completion_tokens: 3, total_tokens: 4 },
  ]) {
    const model = createHarnessModel(
      { routes: [paid] },
      {
        ...ledger,
        env: { HARNESS_TEST_KEY: "test" },
        trustedFingerprints: [harnessRouteFingerprint(paid)],
        fetchImpl: async () => reply({ content: "text" }, u),
      },
    );
    const output = await model(call);
    assert.equal(output.usageEstimated, true);
    assert.ok(output.tokens > paid.maxOutputTokens);
    assert.ok(output.costUsd > 0);
  }
});

test("only a coding final answer can carry bounded memory proposals for the proof gate", async () => {
  const proposal = { text: "Fixture observation", level: "L2", layer: "episodic", verified: true };
  const content = JSON.stringify({ answer: "Check output attached", memoryProposals: [proposal] });
  const model = createHarnessModel(undefined, { fetchImpl: async () => reply({ content }) });
  const out = await model(call);
  assert.equal(out.finalText, "Check output attached");
  assert.deepEqual(out.proposals, [{ text: proposal.text, level: "L2", layer: "episodic" }]);
  assert.equal((await model({ ...call, step: "checkpoint" })).finalText, content);
  const bad = createHarnessModel(undefined, {
    fetchImpl: async () =>
      reply({
        content: JSON.stringify({ answer: "ok", memoryProposals: Array(13).fill(proposal) }),
      }),
  });
  await assert.rejects(bad(call), { code: "invalid_memory_proposals" });
});
