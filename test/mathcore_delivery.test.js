// Merge-queue batch size, flaky-test inference and evidence packing, each compared with an
// exhaustive enumeration or a numeric integration.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseEvidence } from "../src/mathcore/contextpack.js";
import { failuresNeeded, flakyMoment, regressionPosterior } from "../src/mathcore/flaky.js";
import {
  bestBatch,
  dorfmanPerItem,
  halvingBuilds,
  halvingExpected,
} from "../src/mathcore/grouptest.js";
import { rng } from "./_prng.js";

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test("grouptest: expected builds equal enumeration over every failure pattern", () => {
  for (const p of [0.01, 0.05, 0.1, 0.3, 0.6])
    for (let b = 1; b <= 11; b++) {
      let dorfman = 0;
      let halving = 0;
      for (let mask = 0; mask < 1 << b; mask++) {
        const bits = Array.from({ length: b }, (_, i) => Boolean(mask & (1 << i)));
        const bad = bits.filter(Boolean).length;
        const prob = p ** bad * (1 - p) ** (b - bad);
        dorfman += prob * (b === 1 || !bad ? 1 : 1 + b);
        halving += prob * halvingBuilds(bits);
      }
      assert.ok(near(dorfman / b, dorfmanPerItem(b, p), 1e-12), `dorfman b=${b} p=${p}`);
      assert.ok(near(halving, halvingExpected(b, p), 1e-12), `halving b=${b} p=${p}`);
    }
});

test("grouptest: best batch sizes", () => {
  // Dorfman's published optimum at a one percent rate.
  assert.equal(bestBatch(0.01, { strategy: "dorfman" }).size, 11);
  for (const p of [0.01, 0.02, 0.05, 0.1, 0.2]) {
    const d = bestBatch(p, { strategy: "dorfman" });
    const h = bestBatch(p, { strategy: "halving" });
    assert.ok(h.perItem <= d.perItem + 1e-12, "halving is never worse");
    assert.ok(h.perItem < 1, "batching beats building each change alone");
  }
  // The table in docs/MATH-CORE.md.
  const table = [
    [0.01, 11, 0.196, 53, 0.098],
    [0.05, 5, 0.426, 13, 0.323],
    [0.2, 3, 0.821, 3, 0.749],
  ];
  for (const [p, dSize, dCost, hSize, hCost] of table) {
    const d = bestBatch(p, { strategy: "dorfman" });
    const h = bestBatch(p, { strategy: "halving" });
    assert.deepEqual([d.size, h.size], [dSize, hSize]);
    assert.ok(near(d.perItem, dCost, 5e-4) && near(h.perItem, hCost, 5e-4));
  }
  // When most changes break the build, batching stops paying.
  assert.equal(bestBatch(0.7).size, 1);
  assert.throws(() => dorfmanPerItem(0, 0.1), /positive integer/);
  assert.throws(() => halvingExpected(4, 1.5), /0 <= p <= 1/);
});

test("flaky: Beta moments match numeric integration", () => {
  for (const [a, b] of [
    [1, 1],
    [2, 30],
    [1, 99],
    [3, 7],
  ])
    for (const k of [0, 1, 2, 5, 9]) {
      const steps = 100000;
      let top = 0;
      let bottom = 0;
      for (let i = 0; i < steps; i++) {
        const f = (i + 0.5) / steps;
        const w = f ** (a - 1) * (1 - f) ** (b - 1);
        top += f ** k * w;
        bottom += w;
      }
      assert.ok(near(top / bottom, flakyMoment(a, b, k), 1e-6), `a=${a} b=${b} k=${k}`);
    }
});

test("flaky: posterior rises with consecutive failures and yields a rerun count", () => {
  // A test that failed 2 of 100 same-input reruns; 1 failing run in 20 is a real regression.
  const example = { prior: 0.05, a: 1 + 2, b: 1 + 98 };
  const curve = [1, 2, 3, 4].map((failures) => regressionPosterior({ ...example, failures }));
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i] > curve[i - 1]);
  assert.ok(near(curve[0], 0.6415, 1e-4));
  assert.ok(near(curve[1], 0.9788, 1e-4) && near(curve[2], 0.999, 1e-4));
  assert.equal(failuresNeeded({ ...example, eps: 0.01 }), 3);
  // A test that almost always fails on identical inputs cannot be settled by reruns.
  assert.equal(failuresNeeded({ prior: 0.05, a: 50, b: 1, eps: 0.01, max: 20 }), null);
  assert.throws(() => regressionPosterior({ prior: 1, a: 1, b: 1, failures: 1 }), /prior/);
});

test("contextpack: selection equals brute force when token cost is not additive", () => {
  const random = rng(31337);
  let naiveLost = 0;
  for (let trial = 0; trial < 300; trial++) {
    const nRec = 3 + Math.floor(random() * 5);
    const kappa = trial % 3 === 0 ? 0 : 1 + Math.floor(random() * 3);
    const ids = Array.from({ length: nRec }, (_, i) => `r${i}`);
    const single = Object.fromEntries(
      ids.map((id) => [id, 2 * kappa + 1 + Math.floor(random() * 6)]),
    );
    const merge = new Map();
    const saving = (a, b) => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!merge.has(key)) merge.set(key, Math.floor(random() * (kappa + 1)));
      return merge.get(key);
    };
    // Monotone and near-additive by construction: each record costs at least 2 * kappa and
    // each adjacent pair saves at most kappa.
    const costOf = (set) => {
      const sorted = [...set].sort();
      let cost = sorted.reduce((acc, id) => acc + single[id], 0);
      for (let i = 1; i < sorted.length; i++) cost -= saving(sorted[i - 1], sorted[i]);
      return cost;
    };
    const questions = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
      weight: Math.floor(random() * 5),
      options: Array.from({ length: 1 + Math.floor(random() * 2) }, () => {
        const picked = new Set();
        const size = 1 + Math.floor(random() * 2);
        while (picked.size < size) picked.add(ids[Math.floor(random() * nRec)]);
        return [...picked];
      }),
    }));
    const budget = Math.floor(random() * 25);
    const covered = (set) =>
      questions.reduce(
        (acc, q) => acc + (q.options.some((o) => o.every((id) => set.has(id))) ? q.weight : 0),
        0,
      );
    let bestWeight = -1;
    let bestCost = Infinity;
    let naiveWeight = -1;
    for (let mask = 0; mask < 1 << nRec; mask++) {
      const set = new Set(ids.filter((_, i) => mask & (1 << i)));
      const cost = costOf(set);
      if (cost > budget) continue;
      const weight = covered(set);
      if (weight > bestWeight || (weight === bestWeight && cost < bestCost)) {
        bestWeight = weight;
        bestCost = cost;
      }
      const additive = [...set].reduce((acc, id) => acc + single[id], 0);
      if (additive <= budget) naiveWeight = Math.max(naiveWeight, weight);
    }
    const got = chooseEvidence({ questions, single, costOf, kappa, budget });
    assert.equal(got.weight, bestWeight);
    assert.equal(got.cost, bestCost);
    if (naiveWeight < bestWeight) naiveLost++;
  }
  // Pruning by the sum of single costs is not admissible: it loses real optima.
  assert.ok(naiveLost > 0);
});

test("contextpack: the classic two-record witness", () => {
  // Two records costing two units each prove a claim only together.
  const problem = {
    questions: [{ weight: 5, options: [["a", "b"]] }],
    single: { a: 2, b: 2 },
    costOf: (set) => 2 * set.size,
  };
  assert.deepEqual(chooseEvidence({ ...problem, budget: 3 }).ids, []);
  assert.deepEqual(chooseEvidence({ ...problem, budget: 4 }).ids, ["a", "b"]);
  assert.throws(() => chooseEvidence({ ...problem, budget: -1 }), /budget/);
});
