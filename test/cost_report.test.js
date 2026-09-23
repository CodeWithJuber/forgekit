import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { EOL, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CACHE_PRICE_RATIO,
  composedReduction,
  estimateSpendFromLogs,
  recordGate,
  recordRoute,
  renderCostReport,
  report,
  stageFactors,
} from "../src/cost_report.js";
import { read as readMetrics } from "../src/metrics.js";
import { substrateCheck } from "../src/substrate.js";
import { ok, openRouterBody, stubTransport } from "./_catalog_stub.js";

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

test("renderCostReport: unmeasured stages print as no-data; the 62% figure prints only as REFUTED", () => {
  const out = renderCostReport(report(tmp()));
  assert.ok(out.includes("gate"));
  assert.ok((out.match(/no data/g) || []).length === 4, "all four stages show no data");
  // Regression (review E4): "the paper measured a 62% routing saving" printed as a result
  // although the empirical refutation measured −20.2% on total spend.
  const line = out.split("\n").find((l) => l.includes("62%"));
  assert.ok(line, "the paper figure is still cited");
  assert.match(line, /REFUTED/);
  assert.match(line, /−20\.2%/);
  assert.ok(!/measured a 62%/.test(out));
  assert.ok(out.includes("caveats:"));
});

test("composedReduction: a cost-raising stage LOWERS the figure — it is not a lower bound", () => {
  // Regression (review E4): the report called the composition a "lower bound" that "can only
  // grow" as stages are measured, but the route factor goes negative when routing prices
  // above the always-premium baseline (every event on the extreme tier here).
  const root = tmp();
  seed(root, [
    { stage: "cache", outcome: "hit_exact" },
    { stage: "cache", outcome: "miss" },
  ]);
  const before = composedReduction(stageFactors(root)).measuredReduction;
  seed(root, [
    { stage: "cache", outcome: "hit_exact" },
    { stage: "cache", outcome: "miss" },
    { stage: "route", tier: "fable", tokensIn: 1000, tokensOut: 1000 },
  ]);
  const f = stageFactors(root);
  assert.ok(f.route.value < 0, "routing cost more than the baseline");
  assert.ok(composedReduction(f).measuredReduction < before, "a measured stage lowered it");
  const r = report(root);
  const text = `${renderCostReport(r)}\n${r.caveats.join("\n")}`;
  assert.ok(!/lower bound/i.test(text), "no lower-bound claim survives");
  assert.match(text, /not a bound/);
});

// --- estimateSpendFromLogs: the ccusage-less fallback ----------------------------------

test("estimateSpendFromLogs: prices cache tokens and counts a repeated response once (E4)", () => {
  // test/_setup.js sandboxes $HOME, so this writes into a throwaway ~/.claude/projects.
  const dir = join(homedir(), ".claude", "projects", "cost-fixture");
  mkdirSync(dir, { recursive: true });
  // Claude Code logs ONE API response on several lines (one per content block) sharing
  // message.id + usage — and most of the input is cache reads/writes.
  const msg = {
    type: "assistant",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20000,
        cache_read_input_tokens: 180000,
        output_tokens: 500,
      },
    },
  };
  const hourly = {
    type: "assistant",
    message: {
      id: "msg_2",
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
        output_tokens: 0,
      },
    },
  };
  const lines = (...xs) => `${xs.map((x) => JSON.stringify(x)).join("\n")}\n`;
  writeFileSync(join(dir, "s1.jsonl"), lines(msg, msg, msg, hourly));
  writeFileSync(join(dir, "s2.jsonl"), lines(msg)); // a resumed session re-logs history
  const est = estimateSpendFromLogs();
  const opus = est.byModel.find((m) => m.model === "claude-opus-4-8");
  assert.equal(opus.inTokens, 10, "msg_1 counted once across lines and files");
  assert.equal(opus.cacheReadTokens, 180000);
  assert.equal(opus.cacheWriteTokens, 21000);
  // Opus 4.8: $5 in / $25 out per MTok; writes 1.25× (5m) / 2× (1h), reads 0.1× of input
  const expected =
    (10 * 5 +
      500 * 25 +
      20000 * 5 * CACHE_PRICE_RATIO.write5m +
      1000 * 5 * CACHE_PRICE_RATIO.write1h +
      180000 * 5 * CACHE_PRICE_RATIO.read) /
    1e6;
  assert.ok(Math.abs(opus.cost - expected) < 1e-12, `${opus.cost} vs ${expected}`);
  assert.ok(Math.abs(opus.cost - 0.23755) < 1e-9, "was $0.038 before (input+output only)");
});

test("estimateSpendFromLogs: live catalog price by id, family fallback, unknown models unpriced", () => {
  const dir = join(homedir(), ".claude", "projects", "cost-pricing-fixture");
  mkdirSync(dir, { recursive: true });
  const line = (id, model, input, output) =>
    JSON.stringify({
      message: { id, model, usage: { input_tokens: input, output_tokens: output } },
    });
  writeFileSync(
    join(dir, "s.jsonl"),
    [
      line("p1", "claude-3-opus-20240229", 1_000_000, 0),
      line("p2", "claude-opus-9-20300101", 1_000_000, 0),
      line("p3", "<synthetic>", 1_000_000, 0),
      "",
    ].join(EOL),
  );
  const t = stubTransport({
    "openrouter.ai": ok(openRouterBody([["anthropic/claude-3-opus", "0.000015", "0.000075"]])),
  });
  const est = estimateSpendFromLogs({ root: null, fetchImpl: t.fetchImpl });
  const by = Object.fromEntries(est.byModel.map((m) => [m.model, m]));
  assert.equal(by["claude-3-opus-20240229"].cost, 15, "OpenRouter's live $15/M input");
  assert.equal(by["claude-3-opus-20240229"].priceSource, "catalog");
  assert.equal(
    by["claude-opus-9-20300101"].priceSource,
    "snapshot:family",
    "an unknown Opus is priced as the Opus tier",
  );
  assert.equal(by["<synthetic>"].priced, false);
  assert.deepEqual(est.unpriced, ["<synthetic>"], "never billed at a guessed $3/$15");
  assert.equal(t.calls.length, 1, "one catalog request per estimate, not one per model");
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
  // P8 route metering rides the same explicit-only contract: the routing decision
  // lands as one "route" event carrying the chosen tier and a short task-hash ref.
  const routed = readMetrics(explicit, { stage: "route" });
  assert.equal(routed.length, 1);
  assert.ok(["simple", "medium", "complex", "extreme"].includes(routed[0].tier));
  assert.match(routed[0].ref, /^[0-9a-f]{12}$/);

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
