import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  composedReduction,
  recordGate,
  recordRoute,
  renderCostReport,
  report,
  stageFactors,
} from "../src/cost_report.js";
import { read as readMetrics } from "../src/metrics.js";
import { substrateCheck } from "../src/substrate.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-cost-"));

/** Write a fixture .forge/metrics.jsonl from entry objects. */
function seed(root, entries) {
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "metrics.jsonl"),
    `${entries.map((e) => JSON.stringify({ t: 1, ...e })).join("\n")}\n`,
  );
}

// --- stageFactors: the arithmetic is exact over fixture lines -------------------------

test("stageFactors: gate factor is the exact halt fraction", () => {
  const root = tmp();
  seed(root, [
    { stage: "gate", outcome: "halt" },
    { stage: "gate", outcome: "halt" },
    { stage: "gate", outcome: "pass" },
    { stage: "gate", outcome: "pass" },
    { stage: "gate", outcome: "pass" },
  ]);
  const f = stageFactors(root);
  assert.deepEqual(f.gate, { measured: true, value: 2 / 5, events: 5 });
});

test("stageFactors: cache factor is the tier-weighted hit rate (exact 1.0 / near 0.85 / adapt 0.5)", () => {
  const root = tmp();
  seed(root, [
    { stage: "cache", outcome: "hit_exact" },
    { stage: "cache", outcome: "hit_near" },
    { stage: "cache", outcome: "hit_adapt" },
    { stage: "cache", outcome: "miss" },
  ]);
  const f = stageFactors(root);
  assert.equal(f.cache.measured, true);
  assert.equal(f.cache.events, 4);
  assert.ok(Math.abs(f.cache.value - (1.0 + 0.85 + 0.5) / 4) < 1e-12);
});

test("stageFactors: route factor prices tokens vs the always-premium baseline; unpriceable events excluded", () => {
  const root = tmp();
  seed(root, [
    // haiku (in 1, out 5) vs opus baseline (in 5, out 25): 1000·1+1000·5=6000 vs 30000.
    { stage: "route", tier: "haiku", tokensIn: 1000, tokensOut: 1000 },
    // Tier names resolve too ("simple" is haiku's tier) — but no tokens ⇒ excluded, not estimated.
    { stage: "route", tier: "simple" },
    { stage: "route", tier: "nonsense", tokensIn: 50, tokensOut: 50 },
  ]);
  const f = stageFactors(root);
  assert.deepEqual(f.route, { measured: true, value: 1 - 6000 / 30000, events: 1 });
});

test("stageFactors: context factor is saved / (saved + actual) input tokens", () => {
  const root = tmp();
  seed(root, [
    { stage: "context", savedEstimate: 300, tokensIn: 700 },
    { stage: "context", savedEstimate: 0, tokensIn: 1000 },
  ]);
  const f = stageFactors(root);
  assert.equal(f.context.measured, true);
  assert.equal(f.context.events, 2);
  assert.ok(Math.abs(f.context.value - 300 / 2000) < 1e-12);
});

test("stageFactors: an empty store never invents a number — every stage is measured:false / null", () => {
  const root = tmp();
  const f = stageFactors(root);
  for (const name of ["gate", "cache", "route", "context"]) {
    assert.deepEqual(f[name], { measured: false, value: null, events: 0 }, name);
  }
});

// --- composedReduction: multiplicative over MEASURED stages only ----------------------

test("composedReduction: C = Π(1 − f) over measured factors only; missing stages named", () => {
  const c = composedReduction({
    gate: { measured: true, value: 0.1, events: 10 },
    cache: { measured: true, value: 0.5, events: 4 },
    route: { measured: false, value: null, events: 0 },
    context: { measured: false, value: null, events: 0 },
  });
  assert.ok(Math.abs(c.measuredReduction - (1 - 0.9 * 0.5)) < 1e-12);
  assert.deepEqual(c.stagesIncluded, ["gate", "cache"]);
  assert.deepEqual(c.stagesMissing, ["route", "context"]);
});

test("composedReduction: nothing measured composes to exactly 0 — never a target restated", () => {
  const c = composedReduction(stageFactors(tmp()));
  assert.equal(c.measuredReduction, 0);
  assert.deepEqual(c.stagesIncluded, []);
  assert.deepEqual(c.stagesMissing, ["gate", "cache", "route", "context"]);
});

// --- report: totals + a caveat for every unmeasured stage ------------------------------

test("report: empty store carries a caveat naming EVERY unmeasured stage plus workload dependence", () => {
  const r = report(tmp());
  assert.equal(r.totals.events, 0);
  assert.equal(r.totals.savedEstimateTokens, 0);
  for (const s of ["gate", "cache", "route", "context"]) {
    assert.ok(
      r.caveats.some((c) => c.includes(`"${s}"`)),
      `caveat names unmeasured stage ${s}`,
    );
  }
  assert.ok(r.caveats.some((c) => c.includes("workload-dependent")));
});

test("report: totals sum every event and savedEstimate across stages", () => {
  const root = tmp();
  seed(root, [
    { stage: "cache", outcome: "hit_exact", savedEstimate: 120 },
    { stage: "cache", outcome: "miss", savedEstimate: 0 },
    { stage: "gate", outcome: "halt" },
  ]);
  const r = report(root);
  assert.equal(r.totals.events, 3);
  assert.equal(r.totals.savedEstimateTokens, 120);
  assert.equal(r.composed.stagesIncluded.length, 2);
});

// --- renderCostReport: the honesty register -------------------------------------------

const assert90OnlyAsTarget = (text) => {
  for (let i = text.indexOf("90"); i !== -1; i = text.indexOf("90", i + 1)) {
    assert.ok(
      /target/i.test(text.slice(Math.max(0, i - 60), i)),
      `"90" at index ${i} not preceded by "target": …${text.slice(Math.max(0, i - 60), i + 2)}`,
    );
  }
};

test('renderCostReport: "90" appears ONLY behind the word "target" — never as achieved', () => {
  // Empty store, a mixed store, and a pathological store whose factors would round to 90 %.
  assert90OnlyAsTarget(renderCostReport(report(tmp())));
  const mixed = tmp();
  seed(mixed, [
    { stage: "gate", outcome: "halt" },
    { stage: "gate", outcome: "pass" },
    { stage: "cache", outcome: "hit_near", savedEstimate: 50 },
  ]);
  assert90OnlyAsTarget(renderCostReport(report(mixed)));
});

test("renderCostReport: unmeasured stages print as no-data; the 62% figure is labeled as paper context", () => {
  const out = renderCostReport(report(tmp()));
  assert.ok(out.includes("gate"));
  assert.ok((out.match(/no data/g) || []).length === 4, "all four stages show no data");
  assert.ok(/context \(not a local measurement\).*62%.*paper §9/.test(out));
  assert.ok(out.includes("caveats:"));
});

test("renderCostReport: measured factors print as percentages with event counts", () => {
  const root = tmp();
  seed(root, [
    { stage: "gate", outcome: "halt" },
    { stage: "gate", outcome: "pass" },
    { stage: "gate", outcome: "pass" },
    { stage: "gate", outcome: "pass" },
  ]);
  const out = renderCostReport(report(root));
  assert.ok(out.includes("25.0%"), "gate halt fraction rendered");
  assert.ok(out.includes("composed measured reduction: 25.0%"));
});

// --- emit-side helpers + substrate wiring ----------------------------------------------

test("recordGate / recordRoute: thin wrappers land stage-tagged lines in metrics.jsonl", () => {
  const root = tmp();
  recordGate(root, { halted: true, ref: "task-1" });
  recordGate(root, { halted: false });
  recordRoute(root, { tier: "haiku", tokensIn: 10, tokensOut: 20, ref: "task-2" });
  const gate = readMetrics(root, { stage: "gate" });
  assert.deepEqual(
    gate.map((e) => e.outcome),
    ["halt", "pass"],
  );
  assert.equal(gate[0].ref, "task-1");
  const route = readMetrics(root, { stage: "route" });
  assert.equal(route.length, 1);
  assert.equal(route[0].tokensOut, 20);
});

test("substrateCheck meters the gate on the explicit path only — ambient hooks stay write-free", () => {
  const specified =
    "Add a computeVat(rate) function to math.js next to computeTax; must return x*rate; add a unit test";
  const explicit = tmp();
  writeFileSync(join(explicit, "math.js"), "export function computeTax(x){ return x * 0.2 }\n");
  substrateCheck(explicit, specified, { allowBuild: true });
  const gate = readMetrics(explicit, { stage: "gate" });
  assert.equal(gate.length, 1);
  assert.equal(gate[0].outcome, "pass");

  const ambient = tmp();
  writeFileSync(join(ambient, "math.js"), "export function computeTax(x){ return x * 0.2 }\n");
  substrateCheck(ambient, specified, { allowBuild: false });
  assert.ok(!existsSync(join(ambient, ".forge", "metrics.jsonl")), "ambient path never writes");
});

test("substrateCheck meters a halt when the gate asks first", () => {
  const root = tmp();
  substrateCheck(root, "Fix it.", { allowBuild: true });
  const gate = readMetrics(root, { stage: "gate" });
  assert.equal(gate.length, 1);
  assert.equal(gate[0].outcome, "halt");
});
