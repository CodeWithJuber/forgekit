import assert from "node:assert/strict";
import { test } from "node:test";
import { LinUCB } from "../src/mathcore/bandit.js";
import { checkCommand, echoMatches } from "../src/mathcore/interlock.js";
import { promotionDecision } from "../src/mathcore/promotion.js";
import { anytimeLower } from "../src/mathcore/sequential.js";
import { solve } from "../src/router/linalg.js";
import { rng } from "./_prng.js";

// ---- bandit ---------------------------------------------------------------------------
test("LinUCB's estimate equals the ridge solution computed directly", () => {
  const rand = rng(5);
  const d = 4;
  const lambda = 0.7;
  const bandit = new LinUCB({ arms: ["a", "b"], dimension: d, lambda });
  const A = Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => (i === j ? lambda : 0)),
  );
  const b = new Array(d).fill(0);
  for (let t = 0; t < 60; t++) {
    const x = Array.from({ length: d }, () => rand() * 2 - 1);
    const reward = rand() * 3 - 1;
    bandit.update("a", x, reward);
    for (let i = 0; i < d; i++) {
      b[i] += reward * x[i];
      for (let j = 0; j < d; j++) A[i][j] += x[i] * x[j];
    }
  }
  const direct = solve(A, b);
  const learnt = bandit.theta("a");
  for (let i = 0; i < d; i++) assert.ok(Math.abs(learnt[i] - direct[i]) < 1e-9, `coef ${i}`);
  // The untouched arm still holds the prior: zero estimate, width from lambda alone.
  assert.deepEqual(bandit.theta("b"), [0, 0, 0, 0]);
  const s = bandit.score("b", [1, 0, 0, 0]);
  assert.ok(Math.abs(s.width - Math.sqrt(1 / lambda)) < 1e-12);
});

test("LinUCB earns more than a random policy on a linear problem and respects `allowed`", (t) => {
  const rand = rng(17);
  const truth = { cheap: [0.9, -0.6, 0.1], mid: [0.2, 0.5, 0.2], strong: [-0.3, 0.8, 0.6] };
  const arms = Object.keys(truth);
  const payoff = (arm, x) => truth[arm].reduce((s, w, i) => s + w * x[i], 0);
  const bandit = new LinUCB({ arms, dimension: 3, alpha: 0.6 });
  let learned = 0;
  let random = 0;
  let oracle = 0;
  const rounds = 1500;
  for (let i = 0; i < rounds; i++) {
    const x = [rand(), rand(), 1];
    const noise = (rand() - 0.5) * 0.4;
    const pick = bandit.choose(x).arm;
    bandit.update(pick, x, payoff(pick, x) + noise);
    learned += payoff(pick, x);
    random += payoff(arms[Math.floor(rand() * arms.length)], x);
    oracle += Math.max(...arms.map((a) => payoff(a, x)));
  }
  t.diagnostic(
    `mean payoff: learned ${(learned / rounds).toFixed(3)}, random ${(random / rounds).toFixed(3)}, oracle ${(oracle / rounds).toFixed(3)}`,
  );
  assert.ok(
    learned > random + 0.5 * (oracle - random),
    "closes at least half the gap to the oracle",
  );
  assert.equal(bandit.choose([1, 1, 1], { allowed: ["mid"] }).arm, "mid");
  assert.throws(() => bandit.choose([1, 1, 1], { allowed: [] }), RangeError);
  assert.throws(() => bandit.update("ghost", [1, 1, 1], 1), RangeError);
  assert.throws(() => bandit.update("mid", [1, 1], 1), RangeError);
  assert.throws(() => bandit.update("mid", [1, 1, 1], Number.NaN), RangeError);
});

// ---- promotion ------------------------------------------------------------------------
test("promotionDecision keeps an artefact only on held-out evidence", () => {
  const base = { expectedReuse: 20, regenCost: 10, invokeCost: 1, verifyCost: 8, contextCost: 2 };
  const none = promotionDecision({ ...base, heldOutPass: 0, heldOutFail: 0 });
  assert.equal(none.keep, false);
  assert.equal(none.passLower, 0);
  assert.match(none.reason, /no held-out runs/);

  const few = promotionDecision({ ...base, heldOutPass: 2, heldOutFail: 0 });
  const many = promotionDecision({ ...base, heldOutPass: 40, heldOutFail: 0 });
  assert.equal(many.passLower, anytimeLower(40, 0, 0.05));
  assert.ok(many.passLower > few.passLower);
  assert.equal(many.keep, true);
  // saving = reuse * (regen - invoke) * L, overhead = verify + context
  assert.ok(Math.abs(many.saving - 20 * 9 * many.passLower) < 1e-12);
  assert.equal(many.overhead, 10);
  assert.ok(Math.abs(many.breakEvenReuse - 10 / (9 * many.passLower)) < 1e-12);

  // The same count of passes with failures mixed in is worth less.
  const mixed = promotionDecision({ ...base, heldOutPass: 40, heldOutFail: 20 });
  assert.ok(mixed.saving < many.saving);
  // Never worth keeping when invoking costs as much as regenerating.
  const pointless = promotionDecision({
    ...base,
    invokeCost: 10,
    heldOutPass: 500,
    heldOutFail: 0,
  });
  assert.equal(pointless.keep, false);
  assert.equal(pointless.breakEvenReuse, Number.POSITIVE_INFINITY);
  assert.match(pointless.reason, /at least as much/);
  // A rarely reused artefact names the reuse count it would need.
  const rare = promotionDecision({ ...base, expectedReuse: 1, heldOutPass: 40, heldOutFail: 0 });
  assert.equal(rare.keep, false);
  assert.match(rare.reason, /needs more than/);
  assert.throws(() => promotionDecision({ ...base, heldOutPass: -1, heldOutFail: 0 }), RangeError);
});

// ---- interlock ------------------------------------------------------------------------
test("checkCommand enforces range, step, rate, a fresh reading and confirmation", () => {
  const heater = { min: 0, max: 80, maxStep: 10, maxRatePerSecond: 2, requiresConfirmation: true };
  const ok = checkCommand(heater, { value: 44, confirmed: true }, { value: 40, ageSeconds: 3 });
  assert.deepEqual(ok, { allow: true, reasons: [] });

  const out = checkCommand(heater, { value: 95, confirmed: true }, { value: 90, ageSeconds: 60 });
  assert.equal(out.allow, false);
  assert.match(out.reasons[0], /outside \[0, 80\]/);

  const jump = checkCommand(heater, { value: 60, confirmed: true }, { value: 40, ageSeconds: 60 });
  assert.deepEqual(jump.reasons, ["step 20 exceeds the limit 10"]);

  const fast = checkCommand(heater, { value: 48, confirmed: true }, { value: 40, ageSeconds: 1 });
  assert.deepEqual(fast.reasons, ["step 8 exceeds 2/s over 1s"]);

  // A step limit cannot be checked without the device's own reading.
  const blind = checkCommand(heater, { value: 44, confirmed: true }, null);
  assert.deepEqual(blind.reasons, ["no device reading to measure the step from"]);

  const unconfirmed = checkCommand(heater, { value: 44 }, { value: 40, ageSeconds: 3 });
  assert.deepEqual(unconfirmed.reasons, ["a person has not confirmed this command"]);

  // Every violated rule is reported, not just the first.
  const many = checkCommand(heater, { value: 120 }, { value: 40, ageSeconds: 1 });
  assert.equal(many.reasons.length, 4);

  assert.equal(checkCommand({ min: 5, max: 1 }, { value: 2 }, null).allow, false);
  assert.equal(checkCommand(heater, { value: Number.NaN, confirmed: true }, null).allow, false);
  // A channel with a range only needs no reading.
  assert.equal(checkCommand({ min: 0, max: 1 }, { value: 0.5 }, null).allow, true);
});

test("echoMatches compares the device's reading with the command", () => {
  assert.equal(echoMatches({ tolerance: 0.5 }, 44, 44.4), true);
  assert.equal(echoMatches({ tolerance: 0.5 }, 44, 44.6), false);
  assert.equal(echoMatches({}, 44, 44), true);
  assert.equal(echoMatches({}, 44, 44.01), false);
  assert.equal(echoMatches({ tolerance: 1 }, 44, Number.NaN), false);
});
