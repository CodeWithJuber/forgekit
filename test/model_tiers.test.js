import assert from "node:assert/strict";
import { test } from "node:test";
import { allPricePairs, priceOf } from "../src/model_tiers.js";

test("priceOf resolves the active pricing window by date (P0-12)", () => {
  // Sonnet 5 introductory pricing runs through 2026-08-31, then the standard rate.
  assert.deepEqual(priceOf("sonnet", "2026-07-17"), { inCost: 2, outCost: 10 }, "intro window");
  assert.deepEqual(priceOf("sonnet", "2026-08-31"), { inCost: 2, outCost: 10 }, "intro boundary");
  assert.deepEqual(priceOf("sonnet", "2026-09-01"), { inCost: 3, outCost: 15 }, "standard window");
});

test("priceOf falls back to flat cost for a model with no schedule", () => {
  assert.deepEqual(priceOf("haiku", "2026-07-17"), { inCost: 1, outCost: 5 });
  assert.equal(priceOf("nope"), null);
});

test("allPricePairs includes both scheduled and flat prices", () => {
  const pairs = allPricePairs();
  const has = (i, o) => pairs.some((p) => p.inCost === i && p.outCost === o);
  assert.ok(has(2, 10), "intro sonnet price present");
  assert.ok(has(3, 15), "standard sonnet price present");
  assert.ok(has(1, 5), "haiku flat price present");
});
