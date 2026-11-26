// Exact binomial bounds, checked against direct summation of the binomial tail — a calculation
// that shares no code with the incomplete-beta routine the bounds are computed from.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  betaInc,
  betaQuantile,
  binomTailGE,
  cpLower,
  cpUpper,
  minZeroFailureTrials,
} from "../src/mathcore/stats.js";

test("stats: Clopper-Pearson bounds satisfy the binomial tail identity", () => {
  let worst = 0;
  let cases = 0;
  for (const alpha of [0.1, 0.05, 0.01])
    for (let n = 1; n <= 40; n++)
      for (let k = 0; k <= n; k++) {
        if (k > 0) {
          worst = Math.max(worst, Math.abs(binomTailGE(k, n, cpLower(k, n, alpha)) - alpha));
          cases++;
        }
        if (k < n) {
          worst = Math.max(
            worst,
            Math.abs(1 - binomTailGE(k + 1, n, cpUpper(k, n, alpha)) - alpha),
          );
          cases++;
        }
      }
  assert.equal(cases, 4920);
  assert.ok(worst < 1e-9, `binomial identity off by ${worst}`);
});

test("stats: the beta quantile inverts the incomplete beta function", () => {
  assert.ok(Math.abs(betaQuantile(0.5, 1, 1) - 0.5) < 1e-12);
  for (const [a, b] of [
    [0.5, 0.5],
    [2, 5],
    [30, 3],
    [1, 299],
  ])
    for (const p of [0.01, 0.05, 0.5, 0.95])
      assert.ok(Math.abs(betaInc(a, b, betaQuantile(p, a, b)) - p) < 1e-9, `a=${a} b=${b} p=${p}`);
  assert.throws(() => betaQuantile(1.2, 1, 1), /probability/);
});

test("stats: edge counts and invalid input", () => {
  assert.equal(cpLower(0, 10, 0.05), 0);
  assert.equal(cpUpper(10, 10, 0.05), 1);
  assert.equal(betaInc(2, 3, 0), 0);
  assert.equal(betaInc(2, 3, 1), 1);
  assert.throws(() => cpLower(5, 4, 0.05), /0 <= k <= n/);
  assert.throws(() => cpLower(1, 4, 1), /alpha/);
  assert.throws(() => minZeroFailureTrials(1, 0.05), /0 < q/);
});

test("stats: zero-failure trials needed for a requirement at 95%", () => {
  assert.equal(minZeroFailureTrials(0.5, 0.05), 5);
  assert.equal(minZeroFailureTrials(0.9, 0.05), 29);
  assert.equal(minZeroFailureTrials(0.99, 0.05), 299);
  assert.equal(minZeroFailureTrials(0.995, 0.05), 598);
  // The defining property: n is enough and n - 1 is not.
  for (const q of [0.5, 0.9, 0.99]) {
    const n = minZeroFailureTrials(q, 0.05);
    assert.ok(cpLower(n, n, 0.05) >= q);
    assert.ok(cpLower(n - 1, n - 1, 0.05) < q);
  }
});
