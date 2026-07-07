import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCalledSymbols, findUnknownSymbols } from "../src/verify.js";

test("extractCalledSymbols finds call sites, skips methods and builtins", () => {
  const src = [
    "const x = computeTax(income)",
    "obj.doThing(1)", // method call — skipped (preceded by '.')
    "console.log(x)", // builtin — skipped
    "return helper(a, b)",
  ].join("\n");
  const syms = extractCalledSymbols(src);
  assert.ok(syms.includes("computeTax"));
  assert.ok(syms.includes("helper"));
  assert.ok(!syms.includes("doThing"), "method call skipped");
  assert.ok(!syms.includes("log"), "builtin skipped");
});

test("findUnknownSymbols flags symbols absent from the atlas", () => {
  const atlas = { symbols: [{ name: "computeTax" }, { name: "helper" }] };
  const unknown = findUnknownSymbols(atlas, ["computeTax", "helper", "totallyMadeUpFn"]);
  assert.deepEqual(unknown, ["totallyMadeUpFn"]);
});

test("extractCalledSymbols dedupes", () => {
  const syms = extractCalledSymbols("foo()\nfoo()\nbar()");
  assert.equal(syms.filter((s) => s === "foo").length, 1);
});

test("shared extractor: atlas and verify use the same call-site extraction (no drift)", async () => {
  const { extractCalledSymbols, CALL_IGNORE } = await import("../src/extract.js");
  // Calls must be separated — the leading-boundary regex consumes the separator, so adjacent
  // calls like foo(bar()) only yield the outer one (shared, pre-existing behaviour).
  const syms = extractCalledSymbols("const x = foo(); bar(); baz.method(); JSON.parse(y)");
  assert.ok(syms.includes("foo") && syms.includes("bar"), "top-level calls captured");
  assert.ok(!syms.includes("method"), "member call .method( is skipped");
  assert.ok(!syms.includes("JSON"), "builtins ignored");
  assert.ok(CALL_IGNORE.has("console"));
});

// ---------------------------------------------------------------------------
// M6 — checkpoint cadence (optimal-stopping threshold rule, pure).
// ---------------------------------------------------------------------------

test("checkpointCadence computes n* = ceil(checkCost / (pErr·tokensPerStep·costPerToken))", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  // risk per step = 0.05 · 200 · 1 = 10 → n* = 100/10 = 10
  assert.equal(checkpointCadence({ pErr: 0.05, tokensPerStep: 200, checkCost: 100 }), 10);
  // non-integer ratio rounds UP — checking a step late is worse than a step early
  assert.equal(checkpointCadence({ pErr: 0.05, tokensPerStep: 200, checkCost: 105 }), 11);
  // costPerToken scales the at-risk side
  assert.equal(
    checkpointCadence({ pErr: 0.05, tokensPerStep: 200, costPerToken: 2, checkCost: 100 }),
    5,
  );
});

test("checkpointCadence: riskier (cheaper) tiers checkpoint more often", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  const haiku = checkpointCadence({ pErr: 0.2, tokensPerStep: 500, checkCost: 400 });
  const opus = checkpointCadence({ pErr: 0.01, tokensPerStep: 500, checkCost: 400 });
  assert.ok(haiku < opus, `higher hazard → smaller n* (${haiku} < ${opus})`);
});

test("checkpointCadence clamps to [1, 50]", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  // near-free check → never below every-step
  assert.equal(checkpointCadence({ pErr: 0.5, tokensPerStep: 1000, checkCost: 0 }), 1);
  // near-riskless run (or pErr measured at 0) → still checkpoints by the ceiling
  assert.equal(checkpointCadence({ pErr: 0, tokensPerStep: 1000, checkCost: 100 }), 50);
  assert.equal(checkpointCadence({ pErr: 1e-9, tokensPerStep: 1, checkCost: 100 }), 50);
});

test("checkpointCadence fails safe on degenerate inputs (check every step)", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  assert.equal(checkpointCadence({ pErr: Number.NaN, tokensPerStep: 100, checkCost: 100 }), 1);
  assert.equal(checkpointCadence({ pErr: 0, tokensPerStep: 100, checkCost: 0 }), 1);
});
