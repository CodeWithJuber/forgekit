import assert from "node:assert/strict";
import { test } from "node:test";
import { firstAttempts, measuredRoute, wilson } from "../src/router/measured.js";

const bindings = new Map(
  ["a", "b", "c"].map((id) => [id, { id: `provider/${id}`, rating: { band: "unrated" } }]),
);
const rows = [];
for (let i = 0; i < 20; i++) {
  rows.push({
    task: `work-${i}`,
    model: "a",
    passed: i % 2 === 0,
    cost: 1,
    workload: "repair",
    provenance: "verify-event",
  });
  rows.push({
    task: `work-${i}`,
    model: "b",
    passed: i % 2 === 1,
    cost: 4,
    workload: "repair",
    provenance: "verify-event",
  });
}
const evidence = firstAttempts(rows, "repair");

test("a budget compares the exact reported decimal total against budget times task count", () => {
  const route = (costs, budget, alternative = false) => {
    const trials = costs.flatMap((cost, i) => {
      const row = { ...rows[0], task: String(i), passed: true, cost };
      return alternative ? [row, { ...row, model: "b", passed: i === 0, cost: 0 }] : [row];
    });
    return measuredRoute(firstAttempts(trials, "repair"), bindings, "unseen", {
      objective: `budget:${budget}`,
    });
  };
  for (const [costs, budget] of [
    [[0.1, 0.1, 0.1], 0.1],
    [[0.05, 0.1, 0.15], 0.1],
    [[2e-8, 1e-8, 3e-8], 2e-8],
  ]) {
    const best = route(costs, budget, true);
    assert.equal(best.ok, true);
    assert.equal(best.cascade[0].model, "a");
    assert.equal(best.expectedCost, budget);
    assert.equal(best.budgetMet, true);
    assert.doesNotThrow(() => JSON.stringify(best));
  }
  assert.equal(route([0.1, 0.1, 0.1], 0.09).ok, false);
  const over = [0.1, 0.1, 0.10000000000000002];
  assert.equal(route(over, 0.1).budgetMet, false);
  assert.equal(route(over, 0.1, true).cascade[0].model, "b");
});

test("paired replay prices only reached attempts and captures complementary failures", () => {
  const single = measuredRoute(evidence, bindings, "unseen");
  assert.deepEqual(
    single.cascade.map((s) => s.wireId),
    ["provider/a"],
  );
  assert.equal(single.interval.n, 20);
  assert.equal(single.pSuccess, 0.5);
  assert.equal(single.expectedCost, 1);
  const combined = measuredRoute(evidence, bindings, "unseen", {
    objective: "target:0.80",
    maxDepth: 2,
  });
  assert.deepEqual(
    combined.cascade.map((s) => s.model),
    ["a", "b"],
  );
  assert.equal(combined.pSuccess, 1);
  assert.equal(combined.expectedCost, 3);
  assert.equal(combined.interval.low, wilson(20, 20).low);
  assert.ok(combined.interval.low < 1);
  assert.equal(combined.fit.cohort, "shared-workload");
});

test("budgets, lower confidence targets, and exact repeats produce distinct decisions", () => {
  const fail = measuredRoute(evidence, bindings, "unseen", { objective: "budget:0.5" });
  assert.equal(fail.ok, false);
  assert.equal(fail.budgetMet, false);
  assert.equal(fail.minimumExpectedCost, 1);
  const uncertain = measuredRoute(evidence, bindings, "work-1", {
    objective: "target:0.9",
    maxDepth: 2,
  });
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.targetMet, false);
  assert.equal(uncertain.fallback.interval.n, 1);
  const odd = measuredRoute(evidence, bindings, "work-1");
  assert.equal(odd.cascade[0].model, "b");
  assert.equal(odd.fit.cohort, "exact-task");
  assert.equal(
    measuredRoute(evidence, bindings, "unseen", { objective: "value:2" }).cascade[0].model,
    "a",
  );
});

test("first attempts, comparable tasks and complete prices bound the evidence", () => {
  const more = [
    ...rows,
    { ...rows[0], passed: false, cost: 0 },
    { ...rows[1], model: "c", provenance: "self-reported" },
    { ...rows[1], model: "c", workload: "different" },
    { ...rows[1], model: "c", cost: null },
  ];
  const route = measuredRoute(firstAttempts(more, "repair"), bindings, "unseen");
  assert.equal(route.candidates, 2);
  assert.equal(route.cascade[0].interval.score, 0.5);
  const disjoint = firstAttempts([rows[0], { ...rows[1], task: "separate" }], "repair");
  assert.equal(measuredRoute(disjoint, bindings, "unseen").ok, false);
  assert.equal(measuredRoute(new Map(), bindings, "unseen").ok, false);
  assert.throws(() => measuredRoute(evidence, bindings, "unseen", { maxDepth: 0 }), /depth/i);
});

test("an all-failing cohort abstains even when attempts are free", () => {
  const failures = firstAttempts(
    rows.map((r) => ({ ...r, passed: false, cost: 0 })),
    "repair",
  );
  assert.equal(measuredRoute(failures, bindings, "unseen").ok, false);
});
