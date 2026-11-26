// Anytime-valid inference for a stream of outcomes in [0, 1].
//
// A test martingale for H0: E[x_t | past] <= m is W_t = prod_i (1 + (g/m)(x_i - m)), 0 <= g <= 1.
// Under H0 every factor has conditional mean at most 1 and is nonnegative, so W is a nonnegative
// supermartingale and Ville's inequality gives P(sup_t W_t >= 1/alpha) <= alpha. A fixed mixture
// over g keeps the property. Nothing here assumes a fixed number of looks.

/** Fixed mixture over the bet fraction g. Any prior chosen before seeing data is valid. */
export const DEFAULT_MIX = Object.freeze([
  Object.freeze({ g: 1, w: 1 / 2 }),
  Object.freeze({ g: 3 / 4, w: 1 / 6 }),
  Object.freeze({ g: 1 / 2, w: 1 / 6 }),
  Object.freeze({ g: 1 / 4, w: 1 / 6 }),
]);

function logSumExp(values) {
  const top = Math.max(...values);
  if (top === -Infinity) return -Infinity;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - top);
  return top + Math.log(sum);
}

function logPow(base, exponent) {
  if (exponent === 0) return 0;
  return base <= 0 ? -Infinity : exponent * Math.log(base);
}

/** Log wealth against H0: p <= m after s successes and f failures of a 0/1 stream. */
export function logWealthAtMost(s, f, m, mix = DEFAULT_MIX) {
  if (!(m > 0 && m < 1)) throw new Error("need 0 < m < 1");
  return logSumExp(
    mix.map(({ g, w }) => Math.log(w) + logPow(1 + g * (1 / m - 1), s) + logPow(1 - g, f)),
  );
}

/**
 * Anytime-valid lower confidence bound for a success probability from running counts.
 * P(exists t: bound_t > p) <= alpha, however often and whenever the bound is inspected.
 */
export function anytimeLower(s, f, alpha, mix = DEFAULT_MIX) {
  if (!(s >= 0) || !(f >= 0)) throw new Error("counts must be nonnegative");
  if (!(alpha > 0 && alpha < 1)) throw new Error("need 0 < alpha < 1");
  const need = -Math.log(alpha);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (logWealthAtMost(s, f, mid, mix) >= need) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Anytime-valid upper confidence bound for a success probability from running counts. */
export function anytimeUpper(s, f, alpha, mix = DEFAULT_MIX) {
  return 1 - anytimeLower(f, s, alpha, mix);
}

/** Smallest number of consecutive successes after which anytimeLower reaches q. */
export function minAnytimeStreak(q, alpha, mix = DEFAULT_MIX) {
  if (!(q > 0 && q < 1)) throw new Error("need 0 < q < 1");
  let n = 1;
  while (anytimeLower(n, 0, alpha, mix) < q) {
    n++;
    if (n > 1e6) throw new Error("streak does not converge");
  }
  return n;
}

/** Sequential one-sided test for a stream in [0, 1]. direction "atMost" tests H0: mean <= m. */
export class BettingTest {
  constructor({ nullMean, direction = "atMost", alpha, mix = DEFAULT_MIX }) {
    if (!(nullMean > 0 && nullMean < 1)) throw new Error("need 0 < nullMean < 1");
    if (!(alpha > 0 && alpha < 1)) throw new Error("need 0 < alpha < 1");
    if (direction !== "atMost" && direction !== "atLeast") throw new Error("unknown direction");
    this.flip = direction === "atLeast";
    this.m = this.flip ? 1 - nullMean : nullMean;
    this.alpha = alpha;
    this.mix = mix;
    this.logW = mix.map(({ w }) => Math.log(w));
    this.rejected = false;
    this.n = 0;
  }

  update(x) {
    if (!(x >= 0 && x <= 1)) throw new Error("observation must lie in [0, 1]");
    const y = this.flip ? 1 - x : x;
    this.mix.forEach(({ g }, j) => {
      const factor = 1 + (g / this.m) * (y - this.m);
      this.logW[j] = factor <= 0 ? -Infinity : this.logW[j] + Math.log(factor);
    });
    this.n++;
    if (this.logWealth() >= -Math.log(this.alpha)) this.rejected = true;
    return this.rejected;
  }

  logWealth() {
    return logSumExp(this.logW);
  }
}

/**
 * Change detector for a stream whose conditional mean is supposed to stay at least `floor`.
 * Shiryaev-Roberts form: M_t = (M_{t-1} + 1) * L_t, alarm when M_t >= 1/alpha. The guarantee is on
 * the average run length: with no change, the expected time to a false alarm is at least 1/alpha
 * observations. It is not a bound on the probability of ever alarming.
 */
export class EDetector {
  constructor({ floor, alpha, mix = DEFAULT_MIX }) {
    if (!(floor > 0 && floor < 1)) throw new Error("need 0 < floor < 1");
    if (!(alpha > 0 && alpha < 1)) throw new Error("need 0 < alpha < 1");
    this.m = 1 - floor; // null: failure rate <= 1 - floor
    this.alpha = alpha;
    this.mix = mix;
    this.parts = mix.map(() => 0);
    this.alarm = false;
    this.n = 0;
  }

  update(x) {
    if (!(x >= 0 && x <= 1)) throw new Error("observation must lie in [0, 1]");
    const y = 1 - x;
    let total = 0;
    this.mix.forEach(({ g, w }, j) => {
      const factor = Math.max(0, 1 + (g / this.m) * (y - this.m));
      this.parts[j] = (this.parts[j] + 1) * factor;
      total += w * this.parts[j];
    });
    this.n++;
    this.value = total;
    if (total >= 1 / this.alpha) this.alarm = true;
    return this.alarm;
  }
}

/**
 * Paired canary analysis without a fixed schedule of looks. Each observation is a matched pair of
 * failure indicators (canary, baseline). Let d = canary - baseline and delta the largest tolerated
 * increase in failure rate. Two tests run together:
 *   harm:  H0 E[d] <= delta. Rejecting means the canary is worse than tolerated: roll back.
 *   safe:  H0 E[d] >= delta. Rejecting means the canary is within tolerance: promote.
 * Each wrong decision has probability at most alpha at any stopping time, provided the pairs
 * satisfy the conditional mean condition. Missing data means no update.
 */
export class CanaryTest {
  constructor({ delta, alpha, mix = DEFAULT_MIX }) {
    if (!(delta > 0 && delta < 1)) throw new Error("need 0 < delta < 1");
    const nullMean = (delta + 1) / 2;
    this.harm = new BettingTest({ nullMean, direction: "atMost", alpha, mix });
    this.safe = new BettingTest({ nullMean, direction: "atLeast", alpha, mix });
    this.pairs = 0;
    this.decision = "continue";
  }

  update(canaryFailed, baselineFailed) {
    const numeric = [canaryFailed, baselineFailed].map(Number);
    if (numeric.some((v) => v !== 0 && v !== 1)) return this.decision; // missing or non-finite
    if (this.decision !== "continue") return this.decision;
    const y = (numeric[0] - numeric[1] + 1) / 2;
    this.pairs++;
    if (this.harm.update(y)) this.decision = "rollback";
    else if (this.safe.update(y)) this.decision = "promote";
    return this.decision;
  }
}
