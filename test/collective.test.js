// A seeded simulation of the paper's central contrast (He et al., arXiv 2611.32606, §5,
// HiddenBench-like): four agents, four decisive facts SPLIT one per agent, and a shared decoy
// that points to a wrong answer. It checks that the equal-budget ladder separates the setups the
// paper separates — it does NOT reproduce any LLM's behaviour; the agents here are coin flips
// with the information structure of the benchmark.
//
//   independent agent   sees one fact + the decoy → right only by guessing (ε)
//   fact forwarding     every member forwards its private fact; the hub sees all four → right
//                       unless it slips (5%)
//   shared-context debate  members exchange ANSWERS, not facts; every member still sees one
//                       fact + the decoy, so the majority follows the decoy
import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeLadder, passAtN } from "../src/ladder.js";
import { rng } from "./_prng.js";

const QUESTIONS = 80;
const POOL = 12; // independent single-agent runs per question (≥ ⌈n_B⌉ for every setup below)
const GUESS = 0.15; // an agent with one fact and the decoy is right only by chance
const SLIP = 0.05; // the hub, holding all four facts, still errs sometimes
const AGENT = 100; // completion tokens of one independent agent

function simulate(seed) {
  const next = rng(seed);
  const pool = [];
  const forward = [];
  const debate = [];
  for (let q = 0; q < QUESTIONS; q++) {
    const id = `q${String(q).padStart(3, "0")}`;
    for (let j = 0; j < POOL; j++) pool.push({ id, correct: next() < GUESS, tokens: AGENT });
    // Forwarding: four members each forward one fact (~30 tokens) to the hub, which reads them
    // all (~50 tokens) — the designed-hub organization, n_B ≈ 5.7.
    forward.push({ id, correct: next() >= SLIP, tokens: 4 * AGENT + 4 * 30 + 50 });
    // Debate: two rounds of answers (~60 tokens per member per round) on top of four solo
    // attempts — n_B ≈ 8.8. Each member's answer is still a guess; the group takes the majority.
    const votes = [0, 1, 2, 3].map(() => next() < GUESS);
    debate.push({ id, correct: votes.filter(Boolean).length >= 3, tokens: 4 * AGENT + 2 * 4 * 60 });
  }
  return { pool, forward, debate };
}

test("fact forwarding over split facts clears level 3 of the equal-budget ladder", () => {
  const { pool, forward } = simulate(2611);
  const r = gradeLadder({ group: forward, pool });
  assert.equal(r.level, 3, JSON.stringify(r.tests));
  assert.ok(r.nB > 5 && r.nB < 6.5, `n_B ${r.nB}`);
  assert.ok(r.margin > 0.25, `margin over pass@n ${r.margin}`);
  // The reference really is pass@n at the group's budget: 1 − (1 − ε)^n_B, to sampling noise.
  const expected = 1 - (1 - GUESS) ** r.nB;
  assert.ok(Math.abs(r.tn - expected) < 0.08, `T(n_B) ${r.tn} vs ${expected}`);
});

test("a debate that exchanges answers, not facts, does not clear level 3 — and costs more", () => {
  const { pool, forward, debate } = simulate(2611);
  const d = gradeLadder({ group: debate, pool });
  const f = gradeLadder({ group: forward, pool });
  assert.ok(d.level < 3, `debate reached level ${d.level}`);
  assert.equal(d.tests[1].cleared, false, "it does not even beat one agent");
  assert.ok(d.nB > f.nB, "the debate spends more tokens than forwarding");
  assert.ok(d.margin < 0);
});

test("the contrast is stable across seeds (not one lucky draw)", () => {
  for (const seed of [1, 7, 42, 99, 2026]) {
    const { pool, forward, debate } = simulate(seed);
    assert.equal(gradeLadder({ group: forward, pool }).level, 3, `forward, seed ${seed}`);
    assert.ok(gradeLadder({ group: debate, pool }).level < 3, `debate, seed ${seed}`);
  }
});

test("more identical agents only buy pass@n — a bigger budget raises the bar a team must clear", () => {
  // The same forwarding team graded at a quarter of its tokens faces a lower bar.
  const { pool, forward } = simulate(5);
  const cheap = gradeLadder({ group: forward.map((r) => ({ ...r, tokens: r.tokens / 4 })), pool });
  const full = gradeLadder({ group: forward, pool });
  assert.ok(full.tn > cheap.tn, "pass@n grows with n_B");
  assert.ok(Math.abs(passAtN(POOL, 2, 3) - (1 - (10 / 12) * (9 / 11) * (8 / 10))) < 1e-12);
});
