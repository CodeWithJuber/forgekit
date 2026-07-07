// Smoke tests for bench/bench.mjs's PURE helpers only. Importing the module must not
// start a benchmark run (it is main-module guarded), and this file never runs one —
// the full bench is `npm run bench`, on demand, never in CI's test pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fmtMs,
  fmtRate,
  formatTable,
  makeSpec,
  median,
  mulberry32,
  p95,
  timeIt,
} from "../bench/bench.mjs";

test("median: odd, even, single, empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([7]), 7);
  assert.ok(Number.isNaN(median([])));
  const xs = [3, 1, 2];
  median(xs);
  assert.deepEqual(xs, [3, 1, 2], "input is not mutated");
});

test("p95: nearest-rank — max for small n, 95th value at n=100", () => {
  assert.equal(p95([5, 1, 9]), 9, "n<20 → the max, not a smoothed estimate");
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(p95(hundred), 95);
  assert.ok(Number.isNaN(p95([])));
});

test("fmtMs/fmtRate: precision scales with magnitude", () => {
  assert.equal(fmtMs(0.042), "0.042 ms");
  assert.equal(fmtMs(1.234), "1.23 ms");
  assert.equal(fmtMs(42.1), "42.1 ms");
  assert.equal(fmtMs(1503.4), "1503 ms");
  assert.equal(fmtMs(Number.NaN), "n/a");
  assert.equal(fmtRate(7121.4), "7,121/s");
  assert.equal(fmtRate(Number.POSITIVE_INFINITY), "n/a");
});

test("formatTable: aligned columns, markdown separator variant", () => {
  const t = formatTable(["a", "long-header"], [["x", "1"]], { markdown: true });
  const lines = t.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith("|---"), "markdown separator row");
  assert.ok(
    lines.every((l) => l.length === lines[0].length),
    "all rows share one width",
  );
  assert.ok(lines[2].includes("| x "), "cells padded to column width");
});

test("timeIt: runs warmup + measured runs, reports median/p95 of samples", () => {
  let calls = 0;
  const r = timeIt(
    () => {
      calls += 1;
    },
    { runs: 4, warmup: 2 },
  );
  assert.equal(calls, 6, "2 warmup + 4 measured");
  assert.equal(r.samples.length, 4);
  assert.equal(r.median, median(r.samples));
  assert.equal(r.p95, p95(r.samples));
});

test("mulberry32/makeSpec: deterministic fixtures — same seed, same spec, every run", () => {
  const a = makeSpec(mulberry32(42), 40);
  const b = makeSpec(mulberry32(42), 40);
  assert.equal(a, b);
  assert.equal(a.split(" ").length, 40);
  assert.notEqual(a, makeSpec(mulberry32(43), 40), "different seed diverges");
  assert.match(a, /^[a-z ]+$/, "prose-only tokens (no idents/paths/numbers/secrets)");
});
