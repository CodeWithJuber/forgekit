// Universal router: registry as data, provider filtering, outcome recording and Bayesian refit.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { readVerifyEvents, VERIFY_EVENT_VERSION, verifyEventMac } from "../src/verify.js";

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

// Review N06/N07: provenance is earned from an AUTHENTICATED verifier event, never read from a
// label. Events are written here directly — MAC'd under a throwaway evidence key — so the
// tests control authenticity without spawning a test run.
const withEvidenceHome = (home, fn) => {
  const old = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = old;
  }
};
/** Append a verifier event to `d`'s log, MAC'd under the current key unless `sign` is false. */
const logEvent = (d, event, { sign = true } = {}) => {
  const e = { v: VERIFY_EVENT_VERSION, verifier: "forge verify", ...event };
  const mac = sign ? verifyEventMac(e) : null;
  appendFileSync(
    join(d, ".forge", "verify-events.jsonl"),
    `${JSON.stringify(mac ? { ...e, mac } : e)}\n`,
  );
};
const outcome = (d, extra = {}) => ({
  task: "t",
  model: loadRegistry(d).models[0].id,
  features: new Array(12).fill(0),
  ...extra,
});

test("N06: with no evidence key, an unsigned event is reported but never authenticated", () => {
  const d = project();
  const noKey = join(d, "not-a-dir");
  writeFileSync(noKey, "a regular file: no key can be read or created below it");
  withEvidenceHome(noKey, () => {
    logEvent(d, { runId: "invented-run", status: "PASS" }, { sign: false });
    const [e] = readVerifyEvents(d);
    assert.equal(e.runId, "invented-run", "the event exists…");
    assert.equal(e.authenticated, false, "…but it is not authenticated");
    const row = recordOutcome(d, outcome(d, { passed: true, verifyRunId: "invented-run" }));
    assert.equal(row.provenance, "self-reported", "degraded mode continues, unauthenticated");
    assert.match(row.provenanceNote, /not authenticated/);
    assert.equal(readOutcomes(d)[0].provenance, "self-reported");
  });
});

test("N06: a signed event with a matching verdict still earns verify-event, and survives reload", () => {
  const d = project();
  withEvidenceHome(mkdtempSync(join(tmpdir(), "forge-key-")), () => {
    logEvent(d, { runId: "run-1", status: "PASS" });
    logEvent(d, { runId: "unsigned", status: "PASS" }, { sign: false });
    const events = readVerifyEvents(d);
    assert.deepEqual(
      events.map((e) => [e.runId, e.authenticated, e.authScope]),
      [
        ["run-1", true, "event"],
        ["unsigned", false, null],
      ],
    );
    const row = recordOutcome(d, outcome(d, { passed: true, verifyRunId: "run-1" }));
    assert.equal(row.provenance, "verify-event");
    assert.equal(
      recordOutcome(d, outcome(d, { passed: true, verifyRunId: "unsigned" })).provenance,
      "self-reported",
    );
    const read = readOutcomes(d);
    assert.deepEqual(
      read.map((o) => o.provenance),
      ["verify-event", "self-reported"],
    );
    assert.equal(fitRouter(d).provenance.local.verifiedOutcomes, 1);
  });
});

test("N07: forged labels, missing runs, verdict mismatch and replay never count as verified", () => {
  const d = project();
  withEvidenceHome(mkdtempSync(join(tmpdir(), "forge-key-")), () => {
    logEvent(d, { runId: "pass-run", status: "PASS" });
    logEvent(d, { runId: "fail-run", status: "FAIL" });
    const honest = recordOutcome(
      d,
      outcome(d, { passed: true, verifyRunId: "pass-run", attemptId: "honest" }),
    );
    assert.equal(honest.provenance, "verify-event");
    assert.throws(
      () =>
        recordOutcome(d, outcome(d, { passed: true, verifyRunId: "pass-run", attemptId: "again" })),
      /already backs attempt honest/,
      "one verifier run backs one outcome",
    );
    // Hand-written rows claiming the trusted label (the file is user-editable).
    const path = join(d, ".forge", "route_outcomes.jsonl");
    const forged = (over) => `${JSON.stringify({ ...honest, ...over })}\n`;
    appendFileSync(
      path,
      forged({ attemptId: "no-run", verifyRunId: "does-not-exist" }) +
        forged({ attemptId: "mismatch", verifyRunId: "fail-run" }) + // FAIL run, row says pass
        forged({ attemptId: "replay" }), // a second attempt citing pass-run
    );
    const read = readOutcomes(d);
    assert.deepEqual(
      read.map((o) => [o.attemptId, o.provenance]),
      [
        ["honest", "verify-event"],
        ["no-run", "self-reported"],
        ["mismatch", "self-reported"],
        ["replay", "self-reported"],
      ],
    );
    assert.equal(readOutcomes.lastDowngraded, 3);
    assert.match(read[3].provenanceNote, /already backs attempt honest/);
    assert.equal(
      fitRouter(d).provenance.local.verifiedOutcomes,
      1,
      "the fitter counts derived labels",
    );
    assert.deepEqual(fitRouter(d).provenance.local.verifiedFields, ["passed"]);
  });
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
  assert.ok(r.fallback.estimatedCostIfAllAttemptsRun >= r.fallback.expectedCost);
  assert.equal(r.fallback.maxPossibleCost, undefined, "the misleading name is gone");
});

test("A07: a recommended model no provider serves is labeled advice only, never presented as callable", () => {
  const d = project();
  const reg = loadRegistry(d);
  const unserved = reg.models.filter((m) => Object.keys(m.providers ?? {}).length === 0);
  assert.ok(unserved.length >= 1, "the shipped registry has models with no provider id");
  const only = routeUniversal(d, TASK, { candidates: [unserved[0].id] });
  const rec = only.ok ? only : only.fallback;
  assert.equal(rec.applicable, false);
  assert.deepEqual(rec.unmapped, [unserved[0].id]);
  assert.deepEqual(rec.cascade[0].providers, []);
  // Routing within one provider only ever returns models that provider can serve.
  const served = routeUniversal(d, TASK, { provider: "anthropic" });
  assert.equal(served.applicable, true);
  assert.ok(served.cascade.every((c) => c.providers.includes("anthropic")));
  assert.ok(served.cascade.every((c) => typeof c.costSource === "string"));
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
