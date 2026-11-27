// The cascade cost model conditioned on outcomes: a failed attempt costs more than a successful
// one, and a later attempt is reached only on the tasks the earlier ones failed. Checked against
// a simulation that never uses the formula, against the reference `choose`, and end to end.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseBySubsets } from "../src/router/cascade.js";
import { expectedCosts, failLogRatio, fitCost, meanFactor } from "../src/router/cost.js";
import { fitRouter, routeUniversal } from "../src/router/index.js";
import { cascadeStats, choose, nodeCosts, validRatio } from "../src/router/policy.js";
import { rng } from "./_prng.js";

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function instance(rand, nModels, nNodes) {
  const raw = Array.from({ length: nNodes }, () => rand() + 0.05);
  const total = raw.reduce((s, v) => s + v, 0);
  const weights = raw.map((v) => v / total);
  // Node q is a "difficulty": every model does worse at later nodes, so failures correlate.
  const P = Array.from({ length: nModels }, () => {
    const skill = rand();
    return weights.map((_, q) => Math.min(0.98, Math.max(0.02, skill + 0.4 - (q / nNodes) * 0.9)));
  });
  const costs = Array.from({ length: nModels }, () => 0.05 + rand() * 4);
  return { P, weights, costs };
}

test("node costs average to the fitted attempt cost, so a first attempt is charged as before", () => {
  const rand = rng(3);
  for (let i = 0; i < 200; i++) {
    const { P, weights, costs } = instance(rand, 1, 6);
    const ratio = 0.4 + rand() * 3;
    const k = nodeCosts(P[0], weights, costs[0], ratio);
    assert.ok(
      near(
        k.reduce((s, v, q) => s + weights[q] * v, 0),
        costs[0],
      ),
    );
    assert.ok(near(cascadeStats(P, weights, costs, [0], ratio).cost, costs[0]));
    // A harder node (lower success) costs more exactly when failures cost more.
    const hardest = P[0].indexOf(Math.min(...P[0]));
    const easiest = P[0].indexOf(Math.max(...P[0]));
    if (ratio > 1) assert.ok(k[hardest] >= k[easiest]);
    else assert.ok(k[hardest] <= k[easiest]);
  }
  assert.throws(() => validRatio(0), RangeError);
  assert.throws(() => validRatio(Number.NaN), RangeError);
  assert.throws(
    () =>
      cascadeStats([[0.5]], [1], [1], [0], 0) &&
      choose({ P: [[0.5]], weights: [1] }, [1], [0], { kind: "value", value: 1 }, 1, {
        failCostRatio: -1,
      }),
    RangeError,
  );
});

test("ratio 1 reproduces the unconditioned formula bit for bit", () => {
  const rand = rng(8);
  for (let i = 0; i < 100; i++) {
    const { P, weights, costs } = instance(rand, 4, 5);
    const seq = [2, 0, 3];
    let fail = weights.map(() => 1);
    let cost = 0;
    for (const m of seq) {
      cost += costs[m] * weights.reduce((s, w, q) => s + w * fail[q], 0);
      fail = fail.map((f, q) => f * (1 - P[m][q]));
    }
    const st = cascadeStats(P, weights, costs, seq);
    assert.equal(st.cost, cost);
    assert.equal(st.ifAllRun, costs[2] + costs[0] + costs[3]);
  }
});

test("the conditioned cost equals a simulation of attempts with outcome-dependent cost", (t) => {
  const rand = rng(21);
  const { P, weights, costs } = instance(rand, 3, 5);
  const seq = [1, 0, 2];
  const ratio = 1.7;
  // What one successful attempt costs for each model, from the identity the formula is built on.
  const successCost = seq.map((m) => {
    const mean = weights.reduce((s, w, q) => s + w * P[m][q], 0);
    return costs[m] / (mean + (1 - mean) * ratio);
  });
  const runs = 400000;
  let total = 0;
  let solved = 0;
  for (let r = 0; r < runs; r++) {
    let u = rand();
    let q = 0;
    while (q < weights.length - 1 && u > weights[q]) u -= weights[q++];
    for (let i = 0; i < seq.length; i++) {
      const ok = rand() < P[seq[i]][q];
      total += ok ? successCost[i] : successCost[i] * ratio;
      if (ok) {
        solved++;
        break;
      }
    }
  }
  const st = cascadeStats(P, weights, costs, seq, ratio);
  const flat = cascadeStats(P, weights, costs, seq);
  t.diagnostic(
    `simulated ${(total / runs).toFixed(4)}, conditioned formula ${st.cost.toFixed(4)}, unconditioned ${flat.cost.toFixed(4)}`,
  );
  assert.ok(Math.abs(total / runs - st.cost) < 0.01 * st.cost, "within 1% of the simulation");
  assert.ok(Math.abs(solved / runs - st.p) < 0.005);
  // The old formula is the one that is off, and in the direction the replay reported.
  assert.ok(flat.cost < st.cost);
  assert.ok(
    Math.abs(total / runs - st.cost) < Math.abs(total / runs - flat.cost) / 5,
    "the simulation sits far closer to the conditioned formula",
  );
});

test("chooseBySubsets returns what the reference choose returns under any cost ratio", () => {
  const rand = rng(34);
  const objectives = [
    { kind: "match-best-single" },
    { kind: "target", target: 0.8 },
    { kind: "value", value: 6 },
    { kind: "budget", budget: 1.5 },
  ];
  let compared = 0;
  for (let i = 0; i < 400; i++) {
    const n = 2 + Math.floor(rand() * 5);
    const { P, weights, costs } = instance(rand, n, 3 + Math.floor(rand() * 5));
    const ratio = [1, 0.6, 1.2, 1.6, 2.0][Math.floor(rand() * 5)];
    const depth = 1 + Math.floor(rand() * Math.min(4, n));
    const candidates = costs.map((_, m) => m);
    for (const objective of objectives) {
      const a = choose({ P, weights }, costs, candidates, objective, depth, {
        failCostRatio: ratio,
      });
      const b = chooseBySubsets({ P, weights }, costs, candidates, objective, depth, {
        failCostRatio: ratio,
      });
      assert.deepEqual(b.seq, a.seq, `round ${i} ${objective.kind} ratio ${ratio}`);
      assert.ok(near(a.p, b.p) && near(a.cost, b.cost));
      assert.ok(near(a.estimatedCostIfAllAttemptsRun, b.estimatedCostIfAllAttemptsRun));
      assert.equal(a.feasible, b.feasible);
      assert.ok(near(a.minimumExpectedCost, b.minimumExpectedCost));
      compared++;
    }
  }
  assert.equal(compared, 1600);
});

test("failLogRatio recovers a planted ratio within each model and ignores one-sided models", (t) => {
  const rand = rng(55);
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const beta = [0.3, -0.2];
  const s2 = 0.2;
  const planted = Math.log(1.6);
  const obs = [];
  // Model 0 is cheap and fails often; model 1 is dear and rarely fails. A pooled comparison of
  // failed against passed cost would read "failures are cheap". The within-model one does not.
  for (const [model, alpha, pFail] of [
    [0, Math.log(0.05), 0.7],
    [1, Math.log(2), 0.15],
  ]) {
    for (let i = 0; i < 600; i++) {
      const x = [gaussian(), gaussian()];
      const passed = rand() >= pFail;
      const log =
        alpha +
        beta[0] * x[0] +
        beta[1] * x[1] +
        (passed ? 0 : planted) +
        Math.sqrt(s2) * gaussian();
      obs.push({ model, x, cost: Math.exp(log), passed });
    }
  }
  // Model 2 only ever passed: it carries no information about the ratio.
  for (let i = 0; i < 50; i++) obs.push({ model: 2, x: [0, 0], cost: 1, passed: true });
  const fit = failLogRatio(obs, { beta, s2 });
  t.diagnostic(
    `planted ratio 1.6, estimated ${Math.exp(fit.delta).toFixed(3)} (se of log ${fit.se.toFixed(3)})`,
  );
  assert.ok(Math.abs(fit.delta - planted) < 4 * fit.se);
  assert.equal(fit.passed + fit.failed, 1200);
  const pooled =
    Math.log(
      obs.filter((o) => !o.passed).reduce((s, o) => s + o.cost, 0) /
        obs.filter((o) => !o.passed).length,
    ) -
    Math.log(
      obs.filter((o) => o.passed).reduce((s, o) => s + o.cost, 0) /
        obs.filter((o) => o.passed).length,
    );
  assert.ok(pooled < 0, "the naive pooled comparison points the wrong way on this data");
  assert.deepEqual(failLogRatio([{ model: 0, x: [0, 0], cost: 1, passed: true }], { beta, s2 }), {
    delta: null,
    weight: 0,
    se: null,
    passed: 0,
    failed: 0,
  });
});

test("recorded outcomes with dearer failures raise the cost of a cascade, not of a single model", () => {
  const prior = JSON.parse(
    readFileSync(new URL("../data/router_prior.json", import.meta.url), "utf8"),
  );
  const ids = prior.models.slice(0, 3);
  const features = prior.features.mean.slice();
  const outcomes = [];
  let n = 0;
  for (const model of ids)
    for (let i = 0; i < 40; i++) {
      const passed = i % 2 === 0;
      outcomes.push({
        model,
        task: `task-${n++}`,
        features,
        passed,
        cost: passed ? 0.1 : 0.2,
        provenance: "self-reported",
      });
    }
  const d = mkdtempSync(join(tmpdir(), "forge-router-cond-"));
  const fitted = fitRouter(d, { outcomes });
  const delta = fitted.cost.failLogRatio;
  // 20 passes and 20 failures per model at exactly 2x: paired weight 30, shrunk toward the
  // shipped prior's own ratio, which counts as one paired observation.
  const shipped = prior.cost.failLogRatio ?? 0;
  assert.ok(Math.abs(delta - (30 * Math.log(2) + shipped) / 31) < 1e-9, String(delta));
  assert.deepEqual(
    [
      fitted.cost.failLogRatioEvidence.passed,
      fitted.cost.failLogRatioEvidence.failed,
      fitted.cost.failLogRatioEvidence.pairedWeight,
    ],
    [60, 60, 30],
  );

  const TASK = "rename a helper and update its three call sites";
  const base = { objective: "target:0.999", maxDepth: 3, features };
  const pick = (r) => (r.ok ? r : r.fallback);
  const flat = pick(
    routeUniversal(d, TASK, {
      ...base,
      model: { ...fitted, cost: { ...fitted.cost, failLogRatio: 0 } },
    }),
  );
  const conditioned = pick(routeUniversal(d, TASK, { ...base, model: fitted }));
  assert.equal(flat.costModel.conditioned, false);
  assert.equal(flat.costModel.failCostRatio, 1);
  assert.equal(conditioned.costModel.conditioned, true);
  assert.ok(near(conditioned.costModel.failCostRatio, Math.exp(delta)));
  assert.ok(flat.cascade.length > 1, "the test needs a cascade of more than one model");
  // The same cascade costs more once later attempts are charged for the harder tasks they see.
  if (
    JSON.stringify(flat.cascade.map((c) => c.model)) ===
    JSON.stringify(conditioned.cascade.map((c) => c.model))
  )
    assert.ok(conditioned.expectedCost > flat.expectedCost);
  // A single model's expected cost does not move.
  assert.ok(near(conditioned.bestSingle.expectedCost, flat.bestSingle.expectedCost, 1e-12));
});

test("smearing: a heavy right tail raises the mean above the log-normal factor, for every model alike", () => {
  // Residuals with a point mass far out on the right: the mean of exp(ε) is well above exp(s²/2).
  const obs = [];
  let seed = 11;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 400; i++) {
    const model = i % 2;
    const x = [rand() * 2 - 1];
    const eps = rand() < 0.05 ? 2.2 : (rand() - 0.5) * 0.4;
    obs.push({ model, x, cost: Math.exp((model ? -1 : -3) + 0.3 * x[0] + eps) });
  }
  const fit = fitCost(obs, 2, 1, []);
  assert.equal(fit.method, "ols");
  assert.ok(
    fit.smear > Math.exp(fit.s2 / 2) * 1.05,
    "smearing sees the tail the normal formula misses",
  );
  assert.equal(meanFactor(fit), fit.smear);
  // The fitted mean reproduces the observed mean cost; the log-normal factor falls short.
  const observed = obs.reduce((s, o) => s + o.cost, 0) / obs.length;
  const predicted = (factor) =>
    obs.reduce((s, o) => s + Math.exp(fit.alpha[o.model] + fit.beta[0] * o.x[0]) * factor, 0) /
    obs.length;
  assert.ok(Math.abs(predicted(fit.smear) / observed - 1) < 0.03);
  assert.ok(predicted(Math.exp(fit.s2 / 2)) / observed < 0.97);
  // One factor: the ratio of two models' expected costs is what the regression says, exactly.
  const [c0, c1] = expectedCosts(fit, [0.4]);
  assert.ok(Math.abs(Math.log(c1 / c0) - (fit.alpha[1] - fit.alpha[0])) < 1e-12);
  // The per-model factors are reported, and average back to the shared one.
  assert.equal(fit.smearByModel.length, 2);
  assert.ok(Math.abs((fit.smearByModel[0] + fit.smearByModel[1]) / 2 - fit.smear) < 1e-9);
});

test("smearing: a sparse fit and a prior written before smearing keep the log-normal factor", () => {
  const sparse = fitCost([{ model: 0, x: [0], cost: 0.05 }], 1, 1, []);
  assert.equal(sparse.smear, null);
  assert.equal(meanFactor(sparse), Math.exp(sparse.s2 / 2));
  const old = { alpha: [-2], beta: [0], s2: 0.5 };
  assert.equal(meanFactor(old), Math.exp(0.25));
  assert.ok(Math.abs(expectedCosts(old, [0])[0] - Math.exp(-2 + 0.25)) < 1e-12);
});
