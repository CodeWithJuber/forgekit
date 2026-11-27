// Anytime-valid evidence. The simulations are seeded; each asserts a guarantee the mathematics
// states (a false-activation rate, a run length), not a tuned expectation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anytimeLower,
  anytimeUpper,
  BettingTest,
  CanaryTest,
  EDetector,
  logWealthAtMost,
  minAnytimeStreak,
} from "../src/mathcore/sequential.js";
import { binomTailGE, cpLower, logGamma } from "../src/mathcore/stats.js";
import { rng } from "./_prng.js";

// A guarantee "rate <= alpha" is checked on a finite number of seeded runs, so the assertion
// allows three standard errors of a proportion at alpha. It is a sanity bound, not a tuning knob.
const within = (rate, alpha, runs) => rate <= alpha + 3 * Math.sqrt((alpha * (1 - alpha)) / runs);

test("sequential: the anytime bound never exceeds the observed rate or the exact fixed-n bound", () => {
  for (let n = 1; n <= 80; n++)
    for (let s = 0; s <= n; s++) {
      const any = anytimeLower(s, n - s, 0.05);
      assert.ok(any >= 0 && any <= s / n + 1e-12);
      assert.ok(any <= cpLower(s, n, 0.05) + 1e-9, `looser than exact at ${s}/${n}`);
      assert.ok(
        Math.abs(anytimeUpper(s, n - s, 0.05) - (1 - anytimeLower(n - s, s, 0.05))) < 1e-12,
      );
    }
  assert.equal(anytimeLower(0, 12, 0.05), 0);
});

test("sequential: streak of successes needed before the anytime bound reaches a requirement", () => {
  assert.equal(minAnytimeStreak(0.5, 0.05), 5);
  assert.equal(minAnytimeStreak(0.9, 0.05), 34);
  assert.equal(minAnytimeStreak(0.99, 0.05), 348);
  assert.ok(anytimeLower(34, 0, 0.05) >= 0.9 && anytimeLower(33, 0, 0.05) < 0.9);
});

test("sequential: re-reading an exact bound inflates false activation; the anytime bound does not", (t) => {
  // The true success rate sits exactly at the requirement, so every activation is a false one.
  const p = 0.9;
  const alpha = 0.05;
  const horizon = 600;
  const runs = 2000;
  // kStar[n] = smallest k whose exact 95% lower bound exceeds p, i.e. P(X >= k | n, p) < alpha.
  const kStar = new Array(horizon + 1).fill(Infinity);
  for (let n = 1; n <= horizon; n++) {
    let tail = 0;
    let k = n + 1;
    while (k > 0) {
      const pmf = Math.exp(
        logGamma(n + 1) -
          logGamma(k) -
          logGamma(n - k + 2) +
          (k - 1) * Math.log(p) +
          (n - k + 1) * Math.log1p(-p),
      );
      if (tail + pmf >= alpha) break;
      tail += pmf;
      k--;
    }
    if (k <= n) kStar[n] = k;
  }
  assert.ok(binomTailGE(kStar[200], 200, p) < alpha);
  assert.ok(binomTailGE(kStar[200] - 1, 200, p) >= alpha);
  const random = rng(20261127);
  const need = -Math.log(alpha);
  let fixed = 0;
  let anytime = 0;
  for (let r = 0; r < runs; r++) {
    let s = 0;
    let fixedHit = false;
    let anyHit = false;
    for (let n = 1; n <= horizon; n++) {
      if (random() < p) s++;
      if (s >= kStar[n]) fixedHit = true;
      if (logWealthAtMost(s, n - s, p) >= need) anyHit = true;
    }
    fixed += Number(fixedHit);
    anytime += Number(anyHit);
  }
  t.diagnostic(
    `false activation over ${runs} runs of ${horizon} looks: exact bound re-read ${fixed / runs}, anytime bound ${anytime / runs} (nominal ${alpha})`,
  );
  assert.ok(within(anytime / runs, alpha, runs), `anytime false activation ${anytime / runs}`);
  assert.ok(fixed / runs > 3 * alpha, `expected visible inflation, saw ${fixed / runs}`);
});

test("sequential: BettingTest rejects a false null and keeps a true one", () => {
  const random = rng(11);
  const high = new BettingTest({ nullMean: 0.5, direction: "atMost", alpha: 0.01 });
  for (let i = 0; i < 400 && !high.rejected; i++) high.update(random() < 0.8 ? 1 : 0);
  assert.equal(high.rejected, true);
  const low = new BettingTest({ nullMean: 0.5, direction: "atLeast", alpha: 0.01 });
  for (let i = 0; i < 400 && !low.rejected; i++) low.update(random() < 0.2 ? 1 : 0);
  assert.equal(low.rejected, true);
  let falseRejects = 0;
  for (let r = 0; r < 600; r++) {
    const t = new BettingTest({ nullMean: 0.5, direction: "atMost", alpha: 0.05 });
    for (let i = 0; i < 300 && !t.rejected; i++) t.update(random() < 0.5 ? 1 : 0);
    falseRejects += Number(t.rejected);
  }
  assert.ok(within(falseRejects / 600, 0.05, 600), `false rejections ${falseRejects / 600}`);
  assert.throws(() => high.update(1.5), /\[0, 1\]/);
  assert.throws(() => new BettingTest({ nullMean: 0.5, direction: "sideways", alpha: 0.05 }));
});

test("sequential: the change detector's mean run to a false alarm is at least 1/alpha", (t) => {
  const floor = 0.9;
  const alpha = 0.01;
  const random = rng(7);
  const runs = 800;
  let total = 0;
  for (let r = 0; r < runs; r++) {
    const d = new EDetector({ floor, alpha });
    let n = 1;
    while (n < 50000 && !d.update(random() < floor ? 1 : 0)) n++;
    total += n;
  }
  assert.ok(total / runs >= 1 / alpha, `run length ${total / runs}`);
  // After a real drop to 50% success the alarm comes within a handful of observations.
  let delay = 0;
  for (let r = 0; r < runs; r++) {
    const d = new EDetector({ floor, alpha });
    let n = 1;
    while (!d.update(random() < 0.5 ? 1 : 0)) n++;
    delay += n;
  }
  t.diagnostic(
    `mean run to a false alarm ${total / runs} (guaranteed at least ${1 / alpha}); mean delay after a drop to 50% success ${delay / runs}`,
  );
  assert.ok(delay / runs < 15, `detection delay ${delay / runs}`);
});

test("sequential: paired canary test decides both ways and holds its error rate at the boundary", (t) => {
  const alpha = 0.05;
  const delta = 0.05;
  const base = 0.05;
  const random = rng(99);
  const simulate = (canaryRate, runs, horizon) => {
    const out = { promote: 0, rollback: 0, continue: 0 };
    for (let r = 0; r < runs; r++) {
      const t = new CanaryTest({ delta, alpha });
      let decision = "continue";
      for (let i = 0; i < horizon && decision === "continue"; i++)
        decision = t.update(random() < canaryRate ? 1 : 0, random() < base ? 1 : 0);
      out[decision]++;
    }
    return out;
  };
  const boundary = simulate(base + delta, 800, 2000);
  assert.ok(within(boundary.promote / 800, alpha, 800), `promotions ${boundary.promote / 800}`);
  assert.ok(within(boundary.rollback / 800, alpha, 800), `rollbacks ${boundary.rollback / 800}`);
  const same = simulate(base, 200, 6000);
  assert.ok(same.promote >= 180 && same.rollback === 0);
  const worse = simulate(base + 4 * delta, 200, 6000);
  t.diagnostic(
    `at the tolerance: ${JSON.stringify(boundary)} of 800; canary equal to baseline: ${JSON.stringify(same)} of 200; four times worse: ${JSON.stringify(worse)} of 200`,
  );
  assert.ok(worse.rollback >= 198 && worse.promote === 0);
});

test("sequential: missing canary data causes no update and no decision", () => {
  const t = new CanaryTest({ delta: 0.05, alpha: 0.05 });
  assert.equal(t.update(Number.NaN, 0), "continue");
  assert.equal(t.update(undefined, 1), "continue");
  assert.equal(t.update(Number.POSITIVE_INFINITY, 0), "continue");
  assert.equal(t.pairs, 0);
});
