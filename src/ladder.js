// forge ladder — the equal-budget ladder (He et al., arXiv 2611.32606, §4.1). A team of agents
// spends many times the tokens of one agent, and a plain vote over independent answers already
// explains most reported team gains. So a team is graded against INDEPENDENT agents given the
// same budget, at three rising bars:
//
//   level 1   Y > V(1)      beats one agent
//   level 2   Y > V(n_B)    beats a compute-matched majority vote
//   level 3   Y > T(n_B)    beats compute-matched pass@n: n_B agents, solved if ANY is right
//
// n_B = the group's completion tokens / c₁, and c₁ = the mean completion tokens of one
// independent agent that answers. A level counts only when a one-sided paired test at α = 0.025,
// clustered by question, confirms it AND every level below it. For coding work level 3 is the
// bar that matters: a test suite IS the "any of them is right" oracle, so running n_B agents and
// keeping any passing patch is a real alternative a team has to beat.
//
// Pure: records in, a grade out. The test is a Student t on per-question differences, its
// p-value from the regularized incomplete beta already in mathcore/stats.js.
import { betaInc, logGamma } from "./mathcore/stats.js";

export const LADDER_ALPHA = 0.025;
/** Draws per question when a plurality vote over free-form answers is estimated. */
const PLURALITY_DRAWS = 4000;
const PLURALITY_SEED = 0x5eed;

/** mulberry32 — a deterministic PRNG, so a grade never depends on when it was computed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const logChoose = (n, k) =>
  k < 0 || k > n
    ? Number.NEGATIVE_INFINITY
    : logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/**
 * pass@n without replacement: P(at least one of n distinct draws from m members, k of them
 * correct, is correct) = 1 − ∏_{j<n}(m − k − j)/(m − j). Integer n ≤ m.
 */
export function passAtN(m, k, n) {
  if (n <= 0 || k <= 0) return 0;
  let q = 1;
  for (let j = 0; j < n; j++) {
    if (m - k - j <= 0) return 1;
    q *= (m - k - j) / (m - j);
  }
  return 1 - q;
}

/**
 * Majority vote of n distinct draws (without replacement) from m members, k correct, when the
 * only thing known is correct/incorrect: P(more than half correct) + ½·P(exactly half).
 * Hypergeometric, exact. Integer n ≤ m.
 */
export function majorityAtN(m, k, n) {
  if (n <= 0) return 0;
  const total = logChoose(m, n);
  let p = 0;
  for (let x = Math.max(0, n - (m - k)); x <= Math.min(k, n); x++) {
    const w = Math.exp(logChoose(k, x) + logChoose(m - k, n - x) - total);
    if (2 * x > n) p += w;
    else if (2 * x === n) p += w / 2;
  }
  return Math.min(1, p);
}

/**
 * Plurality vote of n distinct draws over free-form answers (ties split evenly), estimated by
 * seeded sampling. `members` are {answer, correct}.
 */
export function pluralityAtN(members, n, draws = PLURALITY_DRAWS, seed = PLURALITY_SEED) {
  if (n <= 0 || !members.length) return 0;
  const correctKey = new Set(members.filter((r) => r.correct).map((r) => r.answer));
  const idx = members.map((_, i) => i);
  const next = rng(seed);
  let sum = 0;
  for (let d = 0; d < draws; d++) {
    // Partial Fisher–Yates: the first n slots are a uniform draw without replacement.
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(next() * (idx.length - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    /** @type {Map<string, number>} */
    const tally = new Map();
    for (let i = 0; i < n; i++) {
      const a = members[idx[i]].answer;
      tally.set(a, (tally.get(a) ?? 0) + 1);
    }
    const top = Math.max(...tally.values());
    const winners = [...tally.entries()].filter(([, c]) => c === top).map(([a]) => a);
    sum += winners.filter((a) => correctKey.has(a)).length / winners.length;
  }
  return sum / draws;
}

/** f at a non-integer n: linear between ⌊n⌋ and ⌈n⌉ (App. B), never below n = 1. */
function atN(f, n) {
  const x = Math.max(1, n);
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return lo === hi ? f(lo) : f(lo) + (x - lo) * (f(hi) - f(lo));
}

/**
 * One-sided paired t-test of H1: mean(d) > 0, clustered by question (one d per question).
 * @param {number[]} d
 */
export function pairedOneSided(d) {
  const n = d.length;
  if (n < 2) return { n, mean: n ? d[0] : 0, se: null, t: null, p: null };
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  // No spread (identical differences, up to floating-point noise): the sign of the mean decides.
  if (se <= 1e-12 * Math.max(1, Math.abs(mean)))
    return { n, mean, se: 0, t: null, p: mean > 0 ? 0 : 1 };
  const t = mean / se;
  const df = n - 1;
  const tail = 0.5 * betaInc(df / 2, 0.5, df / (df + t * t)); // P(T > |t|)
  return { n, mean, se, t, p: t > 0 ? tail : 1 - tail };
}

const round = (x, k = 4) =>
  typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10 ** k) / 10 ** k : x;

/** A validated record, or an Error naming what is wrong. */
function row(r, arm) {
  if (!r || typeof r !== "object") throw new Error(`${arm} record must be an object`);
  if (typeof r.id !== "string" || !r.id.trim() || r.id.length > 200)
    throw new Error(`${arm} record needs a question id`);
  if (typeof r.correct !== "boolean")
    throw new Error(`${arm} record ${r.id}: correct must be true/false`);
  if (!(typeof r.tokens === "number" && Number.isFinite(r.tokens) && r.tokens >= 0))
    throw new Error(`${arm} record ${r.id}: tokens must be a non-negative number`);
  return {
    id: r.id.trim(),
    correct: r.correct,
    tokens: r.tokens,
    answered: r.answered !== false,
    ...(typeof r.answer === "string" ? { answer: r.answer } : {}),
  };
}

/**
 * Grade a group on the equal-budget ladder.
 * @param {{group: object[], pool: object[], alpha?: number}} input
 *   group: {id, correct, tokens} per group run (one or more per question);
 *   pool:  {id, correct, tokens, answered?, answer?} per INDEPENDENT single-agent run.
 */
export function gradeLadder({ group, pool, alpha = LADDER_ALPHA }) {
  if (!(alpha > 0 && alpha < 0.5)) throw new Error("alpha must be in (0, 0.5)");
  const g = (Array.isArray(group) ? group : []).map((r) => row(r, "group"));
  const p = (Array.isArray(pool) ? pool : []).map((r) => row(r, "pool"));
  if (!g.length) throw new Error("No group records");
  if (!p.length) throw new Error("No independent (pool) records");
  const warnings = [];

  // c₁: every pool run is paid for; only runs that answered are counted (§App. C).
  const answered = p.filter((r) => r.answered).length;
  if (!answered) throw new Error("No pool run answered — the unit cost c₁ is undefined");
  const c1 = p.reduce((s, r) => s + r.tokens, 0) / answered;
  if (!(c1 > 0)) throw new Error("Pool runs report zero tokens — the unit cost c₁ is undefined");

  /** @type {Map<string, typeof p>} */
  const poolBy = new Map();
  for (const r of p) poolBy.set(r.id, [...(poolBy.get(r.id) ?? []), r]);
  /** @type {Map<string, typeof g>} */
  const groupBy = new Map();
  for (const r of g) groupBy.set(r.id, [...(groupBy.get(r.id) ?? []), r]);
  const excluded = [...groupBy.keys()].filter((id) => !poolBy.has(id)).sort();
  if (excluded.length)
    warnings.push(`${excluded.length} question(s) have no independent runs and are left out`);
  const ids = [...groupBy.keys()].filter((id) => poolBy.has(id)).sort();
  if (!ids.length) throw new Error("No question has both group and independent runs");

  const kept = ids.flatMap((id) => groupBy.get(id) ?? []);
  const nB = kept.reduce((s, r) => s + r.tokens, 0) / kept.length / c1;
  if (nB < 1)
    warnings.push(
      `the group spent less than one agent (n_B = ${round(nB, 2)}); references use n = 1`,
    );
  const need = Math.ceil(Math.max(1, nB));
  const plurality = p.every((r) => typeof r.answer === "string");
  if (!plurality)
    warnings.push(
      "the vote V(n) is computed from correct/incorrect only — wrong answers count as one bloc, which can understate a real plurality vote (give pool rows an `answer` to fix)",
    );

  const per = ids.map((id) => {
    const members = poolBy.get(id) ?? [];
    const m = members.length;
    const k = members.filter((r) => r.correct).length;
    const rows = groupBy.get(id) ?? [];
    const y = rows.filter((r) => r.correct).length / rows.length;
    const vote = (n) =>
      n > m ? Number.NaN : plurality ? pluralityAtN(members, n) : majorityAtN(m, k, n);
    const fits = m >= need;
    return {
      id,
      y,
      v1: vote(1),
      vn: fits ? atN(vote, nB) : Number.NaN,
      tn: fits ? atN((n) => passAtN(m, k, n), nB) : Number.NaN,
      fits,
    };
  });
  const short = per.filter((q) => !q.fits).length;
  if (short)
    warnings.push(
      `${short} question(s) have fewer than ${need} independent runs, so levels 2 and 3 cannot be judged (capping n would understate the baseline)`,
    );

  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const y = mean(per.map((q) => q.y));
  const judge = (ref, indeterminate) => {
    if (indeterminate) return { reference: null, cleared: false, indeterminate: true };
    const test = pairedOneSided(per.map((q) => q.y - q[ref]));
    return {
      reference: round(mean(per.map((q) => q[ref]))),
      meanDiff: round(test.mean),
      se: round(test.se),
      t: round(test.t, 3),
      p: test.p == null ? null : round(test.p, 5),
      cleared: test.p != null && test.p < alpha,
      indeterminate: test.p == null,
    };
  };
  const tests = {
    1: judge("v1", false),
    2: judge("vn", short > 0),
    3: judge("tn", short > 0),
  };
  let level = 0;
  for (const l of [1, 2, 3]) {
    if (!tests[l].cleared) break;
    level = l;
  }
  const tn = short ? null : mean(per.map((q) => q.tn));
  return {
    questions: ids.length,
    excluded,
    alpha,
    c1: round(c1, 1),
    nB: round(nB, 3),
    y: round(y),
    v1: tests[1].reference,
    vn: tests[2].reference,
    tn: tn == null ? null : round(tn),
    margin: tn == null ? null : round(y - tn),
    level,
    vote: plurality ? "plurality" : "majority-of-correct",
    tests,
    warnings,
  };
}

/**
 * Records for the CLI: a JSON object {group:[…], pool:[…]}, or JSON Lines whose rows carry
 * `arm: "group" | "pool"`.
 * @param {string} text
 */
export function parseLadderRecords(text) {
  const s = String(text ?? "").trim();
  if (!s) throw new Error("Empty ladder input");
  if (s.startsWith("{") && !s.includes("\n{")) {
    const j = JSON.parse(s);
    if (Array.isArray(j.group) || Array.isArray(j.pool))
      return { group: j.group ?? [], pool: j.pool ?? [] };
  }
  const group = [];
  const pool = [];
  for (const [i, line] of s.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    if (r?.arm === "group") group.push(r);
    else if (r?.arm === "pool") pool.push(r);
    else throw new Error(`line ${i + 1}: arm must be "group" or "pool"`);
  }
  return { group, pool };
}
