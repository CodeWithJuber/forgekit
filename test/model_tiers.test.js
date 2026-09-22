import assert from "node:assert/strict";
import { test } from "node:test";
import { allPricePairs, priceOf } from "../src/model_tiers.js";

// A synthetic table, so the window logic stays tested whether or not a real model currently
// carries a schedule.
const SCHEDULED = {
  intro: {
    inCost: 3,
    outCost: 15,
    prices: [
      { effectiveFrom: "2026-06-30", effectiveUntil: "2026-08-31", inCost: 2, outCost: 10 },
      { effectiveFrom: "2026-09-01", inCost: 3, outCost: 15 },
    ],
  },
  flat: { inCost: 1, outCost: 5 },
};

test("priceOf resolves the active pricing window by date (P0-12)", () => {
  assert.deepEqual(priceOf("intro", "2026-07-17", SCHEDULED), { inCost: 2, outCost: 10 });
  assert.deepEqual(
    priceOf("intro", "2026-08-31", SCHEDULED),
    { inCost: 2, outCost: 10 },
    "boundary",
  );
  assert.deepEqual(priceOf("intro", "2026-09-01", SCHEDULED), { inCost: 3, outCost: 15 });
  assert.deepEqual(
    priceOf("intro", "2026-06-01", SCHEDULED),
    { inCost: 3, outCost: 15 },
    "before any window → flat",
  );
});

test("priceOf falls back to flat cost for a model with no schedule", () => {
  assert.deepEqual(priceOf("haiku", "2026-07-17"), { inCost: 1, outCost: 5 });
  assert.deepEqual(priceOf("flat", "2026-07-17", SCHEDULED), { inCost: 1, outCost: 5 });
  assert.equal(priceOf("nope"), null);
});

// Anthropic made Sonnet 5's launch price of $2/$10 the standard price; the increase to $3/$15
// scheduled for 2026-09-01 was cancelled (platform.claude.com pricing page, checked 2026-09-22).
test("Sonnet 5 stays at $2/$10 after 2026-09-01 (the scheduled increase was cancelled)", () => {
  assert.deepEqual(priceOf("sonnet", "2026-07-17"), { inCost: 2, outCost: 10 });
  assert.deepEqual(priceOf("sonnet", "2026-09-22"), { inCost: 2, outCost: 10 });
});

test("allPricePairs includes both scheduled and flat prices", () => {
  const has = (pairs, i, o) => pairs.some((p) => p.inCost === i && p.outCost === o);
  const synthetic = allPricePairs(SCHEDULED);
  assert.ok(has(synthetic, 2, 10), "a scheduled window's price is included");
  assert.ok(has(synthetic, 3, 15), "the flat price is included");
  const real = allPricePairs();
  assert.ok(has(real, 1, 5), "haiku flat price present");
  assert.ok(has(real, 2, 10), "sonnet price present");
});
