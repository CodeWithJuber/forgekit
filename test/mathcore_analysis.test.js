import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClaims, impacted } from "../src/mathcore/closure.js";
import { mmdPermutationTest } from "../src/mathcore/drift.js";
import { suspiciousness } from "../src/mathcore/sbfl.js";
import { rng } from "./_prng.js";

// ---- impact closure -------------------------------------------------------------------
test("impacted walks the union of the old and new graphs", () => {
  const nodes = ["util", "api", "ui", "docs", "lonely"];
  // The change removes api's dependency on util. Walking only the new graph would miss api.
  const r = impacted({
    nodes,
    oldEdges: [
      ["util", "api"],
      ["api", "ui"],
    ],
    newEdges: [["api", "ui"]],
    changed: ["util"],
  });
  assert.deepEqual([...r].sort(), ["api", "ui", "util"]);
});

test("impacted returns everything when the graph cannot be trusted", () => {
  const nodes = ["a", "b", "c"];
  const edges = /** @type {[string, string][]} */ ([["a", "b"]]);
  const all = (r) => assert.deepEqual([...r].sort(), nodes);
  all(impacted({ nodes, oldEdges: edges, newEdges: edges, changed: ["a"], incomplete: true }));
  all(impacted({ nodes, oldEdges: edges, newEdges: edges, changed: ["ghost"] }));
  all(impacted({ nodes, oldEdges: [["a", "ghost"]], newEdges: [], changed: ["a"] }));
});

test("impacted equals brute-force reachability on random graphs", () => {
  const rand = rng(7);
  for (let round = 0; round < 300; round++) {
    const n = 2 + Math.floor(rand() * 9);
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const pick = () => nodes[Math.floor(rand() * n)];
    const mk = () =>
      /** @type {[string, string][]} */ (
        Array.from({ length: Math.floor(rand() * 2 * n) }, () => [pick(), pick()])
      );
    const oldEdges = mk();
    const newEdges = mk();
    const changed = [pick()];
    // Reference: repeated relaxation until nothing changes.
    const ref = new Set(changed);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [u, v] of [...oldEdges, ...newEdges])
        if (ref.has(u) && !ref.has(v)) {
          ref.add(v);
          grew = true;
        }
    }
    assert.deepEqual([...impacted({ nodes, oldEdges, newEdges, changed })].sort(), [...ref].sort());
  }
});

test("classifyClaims separates valid, stale and unresolved, and ignores a pure move", () => {
  const claims = [
    { id: "moved-only", sources: [{ symbol: "parse", hash: "h1" }] },
    { id: "body-changed", sources: [{ symbol: "render", hash: "old" }] },
    {
      id: "deleted",
      sources: [
        { symbol: "legacy", hash: "x" },
        { symbol: "parse", hash: "h1" },
      ],
    },
    { id: "downstream", sources: [{ symbol: "route", hash: "h3" }] },
    {
      id: "two-good",
      sources: [
        { symbol: "parse", hash: "h1" },
        { symbol: "format", hash: "h4" },
      ],
    },
  ];
  // `parse` moved to another file: same content, same hash, so nothing about it is recorded here.
  const hashes = { parse: "h1", render: "new", route: "h3", format: "h4" };
  const result = classifyClaims({ claims, hashes, affected: new Set(["route"]) });
  assert.deepEqual(
    result.map((r) => [r.id, r.state, r.because]),
    [
      ["moved-only", "valid", []],
      ["body-changed", "stale", ["render"]],
      ["deleted", "unresolved", ["legacy"]],
      ["downstream", "stale", ["route"]],
      ["two-good", "valid", []],
    ],
  );
});

// ---- drift ----------------------------------------------------------------------------
const gaussian = (rand) => {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};
const sample = (rand, n, shift) =>
  Array.from({ length: n }, () => [gaussian(rand) + shift, gaussian(rand) + shift, gaussian(rand)]);

test("the drift test keeps its level when nothing changed", (t) => {
  const rand = rng(11);
  const runs = 300;
  let rejected = 0;
  for (let i = 0; i < runs; i++) {
    const r = mmdPermutationTest(sample(rand, 12, 0), sample(rand, 12, 0), {
      permutations: 99,
      seed: i + 1,
    });
    assert.ok(r.pValue > 0 && r.pValue <= 1);
    if (r.pValue <= 0.05) rejected++;
  }
  const rate = rejected / runs;
  t.diagnostic(`false alarm rate at 0.05: ${rate.toFixed(3)} over ${runs} runs`);
  assert.ok(rate <= 0.05 + 3 * Math.sqrt((0.05 * 0.95) / runs), `rate ${rate}`);
});

test("the drift test finds a real shift", (t) => {
  const rand = rng(13);
  const runs = 100;
  let rejected = 0;
  for (let i = 0; i < runs; i++) {
    const r = mmdPermutationTest(sample(rand, 20, 0), sample(rand, 20, 1.5), {
      permutations: 99,
      seed: i + 1,
    });
    if (r.pValue <= 0.05) rejected++;
  }
  t.diagnostic(`power against a 1.5 sigma shift, n = 20: ${(rejected / runs).toFixed(2)}`);
  assert.ok(rejected / runs >= 0.8, `power ${rejected / runs}`);
  assert.throws(() => mmdPermutationTest([[0]], [[1], [2]]), RangeError);
});

// ---- fault ranking --------------------------------------------------------------------
test("suspiciousness reproduces hand-computed scores and ranks the faulty unit first", () => {
  const coverage = {
    t1: ["parse", "fmt"],
    t2: ["parse", "bug"],
    t3: ["bug", "fmt"],
    t4: ["parse"],
  };
  const failing = ["t2", "t3"];
  const by = (formula) =>
    Object.fromEntries(
      suspiciousness({ coverage, failing }, { formula }).map((r) => [r.unit, r.score]),
    );
  const ochiai = by("ochiai");
  // bug: ef=2 ep=0 nf=0 -> 2/sqrt(2*2) = 1. parse: ef=1 ep=2 nf=1 -> 1/sqrt(2*3).
  assert.equal(ochiai.bug, 1);
  assert.ok(Math.abs(ochiai.parse - 1 / Math.sqrt(6)) < 1e-12);
  assert.ok(Math.abs(ochiai.fmt - 1 / Math.sqrt(4)) < 1e-12);
  const dstar = by("dstar");
  assert.equal(dstar.bug, Number.POSITIVE_INFINITY);
  assert.equal(dstar.parse, 1 / 3);
  const tarantula = by("tarantula");
  assert.equal(tarantula.bug, 1);
  assert.equal(tarantula.parse, 0.5 / (0.5 + 1));
  for (const formula of /** @type {const} */ (["ochiai", "dstar", "tarantula"]))
    assert.equal(suspiciousness({ coverage, failing }, { formula })[0].unit, "bug", formula);
  // A unit no failing test ran scores zero under every formula.
  const cold = suspiciousness({ coverage: { a: ["x"], b: ["y"] }, failing: ["b"] });
  assert.deepEqual(
    cold.map((r) => [r.unit, r.score]),
    [
      ["y", 1],
      ["x", 0],
    ],
  );
  assert.throws(
    () => suspiciousness({ coverage, failing }, { formula: /** @type {any} */ ("nope") }),
    TypeError,
  );
});
