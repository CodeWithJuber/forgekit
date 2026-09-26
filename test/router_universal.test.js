// Universal router: registry as data, provider filtering, outcome recording and Bayesian refit.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fitRouter,
  loadRouterModel,
  readOutcomes,
  recordOutcome,
  routeUniversal,
} from "../src/router/index.js";
import { loadRegistry, servableBy } from "../src/router/registry.js";

const project = () => {
  const d = mkdtempSync(join(tmpdir(), "forge-router-"));
  mkdirSync(join(d, ".forge"), { recursive: true });
  return d;
};
const TASK = "Fix the off-by-one error in the pagination helper so the last page is included.";

test("router code names no vendor, model or tier: they all come from data", () => {
  for (const f of [
    "index.js",
    "policy.js",
    "mirt.js",
    "cost.js",
    "features.js",
    "registry.js",
    "prior.js",
  ]) {
    const src = readFileSync(new URL(`../src/router/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /claude|haiku|sonnet|opus|gpt-|gemini|kimi|minimax|deepseek|glm/i, f);
  }
});

test("registry: shipped models load; .forge/models.json adds, overrides and disables", () => {
  const d = project();
  const base = loadRegistry(d);
  assert.ok(base.models.length >= 11);
  const [first, second] = base.models;
  writeFileSync(
    join(d, ".forge", "models.json"),
    JSON.stringify({
      models: [
        {
          id: "local-model",
          label: "Local",
          price_in: 0.1,
          price_out: 0.2,
          providers: { mygw: "local/x" },
        },
        { id: first.id, providers: { mygw: "gw/first" } },
        { id: second.id, enabled: false },
      ],
    }),
  );
  const reg = loadRegistry(d);
  assert.ok(reg.models.some((m) => m.id === "local-model"));
  assert.ok(!reg.models.some((m) => m.id === second.id));
  assert.deepEqual(servableBy(reg, "mygw").sort(), [first.id, "local-model"].sort());
  assert.ok(reg.sources.includes(".forge/models.json"));
});

test("routeUniversal: returns a cascade within the provider's models, with probabilities and costs", () => {
  const d = project();
  const reg = loadRegistry(d);
  const anthropic = servableBy(reg, "anthropic");
  assert.ok(anthropic.length >= 1);
  const r = routeUniversal(d, TASK, { provider: "anthropic" });
  assert.equal(r.ok, true);
  assert.ok(r.cascade.every((c) => anthropic.includes(c.model)));
  assert.ok(r.pSuccess > 0 && r.pSuccess <= 1 && r.expectedCost > 0);
  assert.ok(r.targetMet, "match-best-single always reaches the best single model");
  const any = routeUniversal(d, TASK, { objective: "target:0.95" });
  // A target this task cannot reach is INFEASIBLE (F12): the least-bad cascade is returned
  // only as an explicit fallback, never as a recommendation that meets the target.
  const got = any.ok ? any : any.fallback;
  if (!any.ok) {
    assert.equal(any.feasible, false);
    assert.equal(any.targetMet, false);
    assert.match(any.reason, /infeasible/);
  }
  assert.ok(got.cascade.length <= 3);
  // A model the fit has never seen enters cold, at the population mean.
  const cold = routeUniversal(d, TASK, {
    candidates: reg.models.filter((m) => !m.evidence).map((m) => m.id),
  });
  assert.ok(!cold.ok || cold.cascade.every((c) => c.status === "cold"));
});

test("recordOutcome stores features and a hash, never the task text", () => {
  const d = project();
  const model = loadRegistry(d).models[0].id;
  recordOutcome(d, {
    task: "secret project name zeta",
    model,
    passed: true,
    cost: 0.12,
    features: new Array(12).fill(0),
  });
  const raw = readFileSync(join(d, ".forge", "route_outcomes.jsonl"), "utf8");
  assert.doesNotMatch(raw, /zeta/);
  assert.equal(readOutcomes(d).length, 1);
  assert.throws(() => recordOutcome(d, { task: "x", model }));
});

// Review 2026-09-26 — A04/A01: outcomes are validated at the boundary, idempotent per attempt,
// and self-reported unless tied to a verifier event.
test("A04: recordOutcome refuses unknown models, bad costs and wrong feature dimensions", () => {
  const d = project();
  const model = loadRegistry(d).models[0].id;
  const feats = new Array(12).fill(0);
  const base = { task: "t", model, passed: true, features: feats };
  assert.throws(() => recordOutcome(d, { ...base, model: "no-such-model" }), /unknown model/);
  assert.throws(() => recordOutcome(d, { ...base, cost: -1 }), /cost/);
  assert.throws(() => recordOutcome(d, { ...base, cost: Number.NaN }), /cost/);
  assert.throws(() => recordOutcome(d, { ...base, features: [1, 2, 3] }), /features/);
  assert.throws(() => recordOutcome(d, { ...base, verifyRunId: "not-a-run" }), /no verify run/);
  const row = recordOutcome(d, { ...base, cost: 0.1 });
  assert.equal(row.provenance, "self-reported", "a caller's boolean is self-reported evidence");
  assert.match(row.attemptId, /^[0-9a-f-]{36}$/);
});

test("A01: an attempt id makes recording idempotent; replayed/corrupt rows never multiply evidence", () => {
  const d = project();
  const model = loadRegistry(d).models[0].id;
  const feats = new Array(12).fill(0);
  const first = recordOutcome(d, {
    task: "t",
    model,
    passed: false,
    features: feats,
    attemptId: "a1",
  });
  const again = recordOutcome(d, {
    task: "t",
    model,
    passed: false,
    features: feats,
    attemptId: "a1",
  });
  assert.equal(again.duplicate, true);
  assert.equal(readOutcomes(d).length, 1);
  // Replay the whole file (a bad merge, a copied log) plus garbage lines.
  const path = join(d, ".forge", "route_outcomes.jsonl");
  const text = readFileSync(path, "utf8");
  writeFileSync(
    path,
    `${text}${text}not json\n${JSON.stringify({ ...first, attemptId: "a2", cost: -5 })}\n`,
  );
  assert.equal(readOutcomes(d).length, 1, "replayed rows dedupe by attempt id; invalid rows skip");
  assert.equal(readOutcomes.lastInvalid, 2);
});

test("F12: an unreachable budget is INFEASIBLE, with the cheapest cost and an explicit fallback", () => {
  const d = project();
  const r = routeUniversal(d, TASK, { objective: "budget:0.0000001" });
  assert.equal(r.ok, false);
  assert.equal(r.feasible, false);
  assert.equal(r.budgetMet, false);
  assert.ok(r.minimumExpectedCost > 0.0000001);
  assert.match(r.reason, /budget/);
  assert.ok(r.fallback.cascade.length >= 1, "the least-bad cascade is still available, labeled");
  assert.ok(r.fallback.maxPossibleCost >= r.fallback.expectedCost);
});

test("fitRouter: local outcomes move a model's ability in their direction (Bayesian update)", () => {
  const d = project();
  const prior = loadRouterModel(d);
  const target = prior.models[0];
  const before = prior.mirt.a[0];
  const feats = new Array(prior.features.mean.length).fill(0).map((_, i) => prior.features.mean[i]);
  for (let i = 0; i < 40; i++)
    recordOutcome(d, {
      task: `task ${i}`,
      model: target,
      passed: false,
      cost: 0.2,
      features: feats,
    });
  const fitted = fitRouter(d);
  const after = fitted.mirt.a[fitted.models.indexOf(target)];
  assert.ok(
    after < before - 0.3,
    `ability should fall after 40 verified failures: ${before} -> ${after}`,
  );
  assert.equal(loadRouterModel(d).origin, ".forge/router_model.json");
  assert.equal(fitted.provenance.local.outcomes, 40);
});
