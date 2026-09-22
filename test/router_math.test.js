// Universal router: the numerical pieces (quadrature, optimiser, MIRT, cost, cascade policy).
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedCosts, fitCost } from "../src/router/cost.js";
import { minimize } from "../src/router/lbfgs.js";
import {
  fitMirt,
  heldOutLogLik,
  marginals,
  nodeProbabilities,
  objective,
  sigmoid,
} from "../src/router/mirt.js";
import { cascadeStats, cascades, choose, parseObjective } from "../src/router/policy.js";
import { normalGrid, normalNodes } from "../src/router/quadrature.js";

// Deterministic PRNG so every run sees the same synthetic data.
function rng(seed) {
  let s = seed >>> 0;
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return { u, g: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

test("quadrature: Gauss–Hermite nodes reproduce standard-normal moments exactly", () => {
  const { x, w } = normalNodes(12);
  const m = (p) => x.reduce((s, xi, i) => s + w[i] * xi ** p, 0);
  assert.ok(Math.abs(m(0) - 1) < 1e-12);
  assert.ok(Math.abs(m(1)) < 1e-12);
  assert.ok(Math.abs(m(2) - 1) < 1e-12);
  assert.ok(Math.abs(m(4) - 3) < 1e-10);
  assert.ok(Math.abs(m(6) - 15) < 1e-8);
  const g = normalGrid(2, 4);
  assert.equal(g.points.length, 16);
  assert.ok(Math.abs(g.weights.reduce((s, v) => s + v, 0) - 1) < 1e-12);
});

test("lbfgs: finds the Rosenbrock minimum", () => {
  const f = ([a, b]) => ({
    value: (1 - a) ** 2 + 100 * (b - a * a) ** 2,
    grad: [-2 * (1 - a) - 400 * a * (b - a * a), 200 * (b - a * a)],
  });
  const r = minimize(f, [-1.2, 1]);
  assert.ok(Math.abs(r.x[0] - 1) < 1e-4 && Math.abs(r.x[1] - 1) < 1e-4, JSON.stringify(r.x));
});

function synthetic(seed, { M = 5, J = 600, missing = 0.3 } = {}) {
  const { u, g } = rng(seed);
  const a = [1.5, 0.8, 0.2, -0.4, 2].slice(0, M);
  const w = [0.9, -0.6];
  const L = [[1.2], [1.0], [0.9], [1.1], [1.3]].slice(0, M);
  const tasks = [];
  for (let j = 0; j < J; j++) {
    const x = [g(), g()];
    const th = g();
    const obs = [];
    for (let m = 0; m < M; m++) {
      if (u() < missing) continue;
      const z = a[m] - (w[0] * x[0] + w[1] * x[1]) + L[m][0] * th;
      obs.push([m, u() < sigmoid(z) ? 1 : 0]);
    }
    tasks.push({ x, obs });
  }
  return { truth: { a, w, L }, data: { nModels: M, nFeatures: 2, tasks } };
}

test("mirt: analytic gradient matches finite differences (sparse observations)", () => {
  const { data } = synthetic(3, { J: 60 });
  const grid = normalGrid(2, 5);
  const prior = {
    a: [0, 0, 0, 0, 0],
    w: [0, 0],
    L: [
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
    ],
    scaleA: 2,
    scaleW: 1,
    scaleL: 1,
  };
  const v = [
    0.5, 0.1, -0.2, 0.3, 0.9, 0.4, -0.3, 1.1, 0.2, 0.9, -0.1, 1.2, 0.3, 0.8, 0.1, 1.0, -0.2,
  ];
  const { grad } = objective(v, data, 2, grid, prior);
  for (let i = 0; i < v.length; i++) {
    const h = 1e-5;
    const up = v.slice();
    const dn = v.slice();
    up[i] += h;
    dn[i] -= h;
    const num =
      (objective(up, data, 2, grid, prior).value - objective(dn, data, 2, grid, prior).value) /
      (2 * h);
    assert.ok(
      Math.abs(num - grad[i]) < 1e-5 * Math.max(1, Math.abs(num)),
      `param ${i}: ${num} vs ${grad[i]}`,
    );
  }
});

test("mirt: recovers abilities and difficulty weights from synthetic outcomes", () => {
  const { truth, data } = synthetic(11);
  const { params } = fitMirt(data, 1);
  // Order of abilities is what routing depends on.
  const order = (v) =>
    v
      .map((x, i) => [x, i])
      .sort((p, q) => p[0] - q[0])
      .map(([, i]) => i);
  assert.deepEqual(order(params.a), order(truth.a));
  assert.ok(Math.sign(params.w[0]) === 1 && Math.sign(params.w[1]) === -1);
  // Predicted marginal success at x = 0 is close to the true marginal.
  const p = marginals(nodeProbabilities(params, [0, 0]));
  const { g } = rng(5);
  truth.a.forEach((am, m) => {
    let s = 0;
    for (let i = 0; i < 20000; i++) s += sigmoid(am + truth.L[m][0] * g());
    assert.ok(Math.abs(p[m] - s / 20000) < 0.06, `model ${m}: ${p[m]} vs ${s / 20000}`);
  });
  assert.ok(Number.isFinite(heldOutLogLik(params, data)));
});

test("policy: cascade success and cost integrate correlated failures (matches Monte Carlo)", () => {
  const params = { k: 1, a: [0.5, 1.0], w: [0], L: [[2], [2]] };
  const nodes = nodeProbabilities(params, [0]);
  const costs = [1, 3];
  const st = cascadeStats(nodes.P, nodes.weights, costs, [0, 1]);
  const { g, u } = rng(9);
  let solved = 0;
  let spent = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) {
    const th = g();
    spent += 1;
    if (u() < sigmoid(0.5 + 2 * th)) {
      solved++;
      continue;
    }
    spent += 3;
    if (u() < sigmoid(1 + 2 * th)) solved++;
  }
  assert.ok(Math.abs(st.p - solved / n) < 0.005, `${st.p} vs ${solved / n}`);
  assert.ok(Math.abs(st.cost - spent / n) < 0.02, `${st.cost} vs ${spent / n}`);
  // Treating the two models as independent would overstate what the cascade buys.
  const m = marginals(nodes);
  assert.ok(1 - (1 - m[0]) * (1 - m[1]) > st.p + 0.02);
});

test("policy: objectives choose as specified and enumerate every ordered cascade", () => {
  assert.equal([...cascades([0, 1, 2], 2)].length, 3 + 6);
  const nodes = { P: [[0.5], [0.8], [0.9]], weights: [1] };
  const costs = [0.1, 1, 5];
  // match-best-single: at least model 2's 0.9, as cheap as possible → 0 then 1 (0.9 at 0.6).
  const m = choose(nodes, costs, [0, 1, 2], parseObjective("match-best-single"), 3);
  assert.deepEqual(m.seq, [0, 1]);
  assert.ok(m.targetMet && Math.abs(m.p - 0.9) < 1e-12);
  const t = choose(nodes, costs, [0, 1, 2], parseObjective("target:0.99"), 3);
  assert.equal(t.targetMet, true);
  assert.ok(t.p >= 0.99);
  const b = choose(nodes, costs, [0, 1, 2], parseObjective("budget:0.2"), 3);
  assert.deepEqual(b.seq, [0]);
  const v = choose(nodes, costs, [0, 1, 2], parseObjective("value:1"), 3);
  assert.ok(v.seq.length >= 1);
  assert.throws(() => parseObjective("target:2"));
  // A model with unknown cost is never chosen.
  assert.deepEqual(choose(nodes, [null, 1, 5], [0, 1, 2], parseObjective("budget:2"), 1).seq, [1]);
});

test("cost: fitted per model; a model with only a price enters from the price ratio", () => {
  const { g } = rng(21);
  const obs = [];
  for (let i = 0; i < 300; i++) {
    const x = [g()];
    obs.push({ model: 0, x, cost: Math.exp(-2 + 0.5 * x[0] + 0.1 * g()) });
    obs.push({ model: 1, x, cost: Math.exp(-1 + 0.5 * x[0] + 0.1 * g()) });
  }
  const prices = [
    { priceIn: 1, priceOut: 5 },
    { priceIn: Math.E, priceOut: 5 * Math.E },
    { priceIn: 2, priceOut: 10 },
  ];
  const c = fitCost(obs, 3, 1, prices);
  assert.ok(Math.abs(c.alpha[0] + 2) < 0.05 && Math.abs(c.alpha[1] + 1) < 0.05);
  assert.ok(Math.abs(c.beta[0] - 0.5) < 0.05);
  assert.equal(c.source[2], "price");
  // Price 2x the first model's → about 2x its cost (log 2 ≈ 0.693 above α₀).
  assert.ok(Math.abs(c.alpha[2] - (c.alpha[0] + Math.log(2))) < 0.05);
  const e = expectedCosts(c, [0]);
  assert.ok(e[1] > e[0] && e.every((v) => v > 0));
});
