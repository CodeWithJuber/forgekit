// guard_eval tests — the harness must score its own adversarial suite honestly.

import assert from "node:assert/strict";
import { test } from "node:test";
import { evalGuards, GUARD_EVAL_CASES, runCase } from "../src/guard_eval.js";

test("guard_eval: every built-in case has the required shape", () => {
  for (const c of GUARD_EVAL_CASES) {
    assert.ok(c.id, "case needs an id");
    assert.ok(["semantic_guard", "secrets", "skillgate"].includes(c.guard), `bad guard ${c.guard}`);
    assert.equal(typeof c.expect, "boolean", `${c.id}: expect must be boolean`);
    assert.ok(c.why, `${c.id}: why must name the trick`);
  }
});

test("guard_eval: runCase rejects unknown guard/fn", () => {
  assert.throws(
    () =>
      runCase({
        id: "x",
        guard: "nope",
        fn: "nope",
        input: {},
        expect: true,
        why: "x",
      }),
    /unknown guard\/fn/,
  );
});

test("guard_eval: the suite runs and reports honestly", () => {
  const r = evalGuards(GUARD_EVAL_CASES);
  assert.equal(r.n, GUARD_EVAL_CASES.length);
  // The harness must surface every case with its verdict — no silent drops.
  assert.equal(r.results.length, GUARD_EVAL_CASES.length);
  assert.equal(r.passed + r.failed, r.n);
});

// Known guard gaps, documented as findings (not hidden): hasSecret is deliberately
// conservative — it trips on `<redacted>` placeholders and on code that merely names
// a `token` variable. The eval harness exists to keep these VISIBLE so a future
// precision fix can be measured against this baseline.
const KNOWN_GAPS = ["sec-02", "sec-04"];

test("guard_eval: known gaps are exactly the documented ones — no new regressions", () => {
  const r = evalGuards(GUARD_EVAL_CASES);
  const failing = r.results
    .filter((x) => !x.pass)
    .map((f) => f.id)
    .sort();
  assert.deepEqual(
    failing,
    [...KNOWN_GAPS].sort(),
    `unexpected failures: ${JSON.stringify(failing)}`,
  );
});

test("guard_eval: per-guard breakdown covers all three guards", () => {
  const r = evalGuards(GUARD_EVAL_CASES);
  assert.deepEqual(Object.keys(r.perGuard).sort(), ["secrets", "semantic_guard", "skillgate"]);
  for (const g of Object.values(r.perGuard)) assert.ok(g.n > 0);
});

test("guard_eval: a deliberately wrong expectation is caught", () => {
  const bad = [
    {
      id: "neg-01",
      guard: "semantic_guard",
      fn: "sameSemantics",
      input: { a: "Enable auth", b: "Disable auth" },
      expect: true, // wrong on purpose — these conflict
      why: "negative control",
    },
  ];
  const r = evalGuards(bad);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 1);
  assert.equal(r.score, 0);
});
