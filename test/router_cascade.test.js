// The subset programme against two independent references: brute force over every ordered
// cascade, and the router's own `choose` in policy.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestCascade,
  chooseBySubsets,
  expectedCost,
  independentModel,
  nodeModel,
  ratioOrder,
} from "../src/router/cascade.js";
import { cascadeStats, choose, parseObjective } from "../src/router/policy.js";
import { rng } from "./_prng.js";

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function orderedSubsets(n) {
  const out = [];
  const walk = (order, used) => {
    if (order.length) out.push(order.slice());
    for (let i = 0; i < n; i++)
      if (!(used & (1 << i))) {
        order.push(i);
        walk(order, used | (1 << i));
        order.pop();
      }
  };
  walk([], 0);
  return out;
}

function instance(random, n, nodes) {
  const P = Array.from({ length: n }, () => Array.from({ length: nodes }, () => random()));
  const raw = Array.from({ length: nodes }, () => 0.1 + random());
  const total = raw.reduce((a, b) => a + b, 0);
  return {
    P,
    weights: raw.map((w) => w / total),
    costs: Array.from({ length: n }, () => 0.05 + random() * 5),
  };
}

test("cascade: the subset programme equals brute force over every ordered cascade", (t) => {
  const random = rng(4242);
  let ratioLost = 0;
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(random() * 5);
    const correlated = trial % 2 === 1;
    const { P, weights, costs } = instance(random, n, correlated ? 3 : 1);
    const model = nodeModel(
      P,
      weights,
      costs.map((_, i) => i),
    );
    const penalty = random() * 20;
    let brute = Infinity;
    for (const order of orderedSubsets(n))
      brute = Math.min(brute, expectedCost(order, costs, model, penalty));
    const got = bestCascade({ costs, failAll: model, failurePenalty: penalty });
    assert.ok(near(got.cost, brute), `cascade ${got.cost} vs brute ${brute}`);
    assert.ok(near(expectedCost(got.order, costs, model, penalty), got.cost));
    // Ordering a fixed set: cost / success is optimal exactly when attempts are independent.
    const full = (1 << n) - 1;
    const forced = bestCascade({ costs, failAll: model, allowed: (mask) => mask === full });
    const marginal = P.map((row) => row.reduce((acc, v, q) => acc + weights[q] * v, 0));
    const byRatio = expectedCost(ratioOrder(costs, marginal), costs, model);
    if (!correlated) assert.ok(near(byRatio, forced.cost), "ratio rule, independent attempts");
    else if (byRatio > forced.cost + 1e-9) ratioLost++;
  }
  t.diagnostic(`cost/success ordering was not optimal in ${ratioLost} of 150 correlated instances`);
  assert.ok(ratioLost > 0, "with correlated failures the ratio rule must lose somewhere");
});

test("cascade: cheapest-first is not the cheapest order", () => {
  const costs = [1, 2];
  const p = [0.1, 0.9];
  const model = independentModel(p);
  assert.ok(near(expectedCost([0, 1], costs, model), 2.8, 1e-12));
  const best = bestCascade({ costs, failAll: model, allowed: (mask) => mask === 3 });
  assert.deepEqual(best.order, [1, 0]);
  assert.ok(near(best.cost, 2.1, 1e-12));
});

test("cascade: constraints, penalties and invalid input", () => {
  const model = independentModel([0.5, 0.5]);
  assert.equal(bestCascade({ costs: [1, 1], failAll: model, allowed: () => false }), null);
  // A large penalty for total failure makes the longer cascade worth its cost.
  assert.equal(bestCascade({ costs: [1, 1], failAll: model, failurePenalty: 0 }).order.length, 1);
  assert.equal(bestCascade({ costs: [1, 1], failAll: model, failurePenalty: 10 }).order.length, 2);
  assert.throws(() => bestCascade({ costs: [], failAll: model }), /between 1 and 20/);
  assert.throws(() => bestCascade({ costs: [-1], failAll: model }), /nonnegative/);
});

test("cascade: chooseBySubsets returns what policy.choose returns", (t) => {
  const random = rng(808);
  const objectives = (best, cheapest) => [
    "match-best-single",
    `target:${Math.min(0.999, Math.max(0.001, best * 0.9)).toFixed(4)}`,
    "target:0.9999", // usually infeasible
    `value:${(0.5 + random() * 20).toFixed(3)}`,
    `budget:${(cheapest * (0.5 + random() * 3)).toFixed(4)}`,
    `budget:${(cheapest * 0.5).toFixed(6)}`, // infeasible
  ];
  let compared = 0;
  for (let trial = 0; trial < 150; trial++) {
    const n = 1 + Math.floor(random() * 6);
    const { P, weights, costs } = instance(random, n, 1 + Math.floor(random() * 4));
    const nodes = { P, weights };
    const withUnknown = costs.map((c) => (random() < 0.1 ? null : c));
    if (withUnknown.every((c) => c === null)) withUnknown[0] = costs[0];
    const candidates = costs.map((_, i) => i).filter(() => random() < 0.9);
    if (!candidates.length) candidates.push(0);
    const usable = candidates.filter((m) => withUnknown[m] !== null);
    if (!usable.length) {
      assert.equal(
        chooseBySubsets(nodes, withUnknown, candidates, { kind: "value", value: 1 }, 3),
        null,
      );
      continue;
    }
    const singles = usable.map((m) => cascadeStats(P, weights, withUnknown, [m]));
    const bestP = Math.max(...singles.map((s) => s.p));
    const cheapest = Math.min(...singles.map((s) => s.cost));
    for (const spec of objectives(bestP, cheapest))
      for (const depth of [1, 2, 3, n]) {
        const objective = parseObjective(spec);
        const want = choose(nodes, withUnknown, candidates, objective, depth);
        const got = chooseBySubsets(nodes, withUnknown, candidates, objective, depth);
        assert.deepEqual(got.seq, want.seq, `${spec} depth ${depth}`);
        for (const key of ["p", "cost", "minimumExpectedCost", "estimatedCostIfAllAttemptsRun"])
          assert.ok(near(got[key], want[key], 1e-12), `${key} for ${spec}`);
        for (const key of ["target", "targetMet", "budgetMet", "feasible", "reason"])
          assert.deepEqual(got[key], want[key], `${key} for ${spec}`);
        assert.equal(got.bestSingle.model, want.bestSingle.model);
        assert.ok(got.evaluated <= want.evaluated);
        compared++;
      }
  }
  t.diagnostic(`${compared} decisions compared with policy.choose`);
  assert.ok(compared > 2000);
});
