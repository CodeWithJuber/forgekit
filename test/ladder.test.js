// The equal-budget ladder (src/ladder.js; He et al., arXiv 2611.32606 §4.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gradeLadder,
  majorityAtN,
  pairedOneSided,
  parseLadderRecords,
  passAtN,
  pluralityAtN,
} from "../src/ladder.js";
import { rng } from "./_prng.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("pass@n without replacement matches the product formula by hand", () => {
  close(passAtN(4, 1, 1), 0.25);
  close(passAtN(4, 1, 2), 1 - (3 / 4) * (2 / 3));
  close(passAtN(4, 1, 4), 1, 0);
  close(passAtN(10, 0, 5), 0);
  close(passAtN(10, 10, 1), 1);
});

test("majority of correct is exact hypergeometric, ties count one half", () => {
  // 3 of 4 drawn, 2 correct: P(≥2 correct) = C(2,2)·C(2,1)/C(4,3) = 0.5
  close(majorityAtN(4, 2, 3), 0.5);
  // 2 of 4 drawn, 2 correct: P(2) = 1/6, P(1) = 4/6 (tie → ½) → 1/6 + 1/3 = 0.5
  close(majorityAtN(4, 2, 2), 0.5);
  close(majorityAtN(5, 2, 1), 2 / 5);
});

test("Proposition 1 holds on 200 seeded random pools: T(n) ≥ max{V(1), V(n)}, T(n) ≤ min{1, n·V(1)}", () => {
  const next = rng(11);
  for (let i = 0; i < 200; i++) {
    const m = 2 + Math.floor(next() * 14);
    const k = Math.floor(next() * (m + 1));
    const n = 1 + Math.floor(next() * m);
    const t = passAtN(m, k, n);
    const v1 = majorityAtN(m, k, 1);
    const vn = majorityAtN(m, k, n);
    assert.ok(t >= Math.max(v1, vn) - 1e-9, `T < V at m=${m} k=${k} n=${n}`);
    assert.ok(t <= Math.min(1, n * v1) + 1e-9, `T > n·V(1) at m=${m} k=${k} n=${n}`);
  }
});

test("a plurality vote over split wrong answers beats lumping them into one bloc", () => {
  // 2 correct "A", 3 wrong but all different: a plurality of 5 picks A, a majority-of-correct does not.
  const members = [
    { answer: "A", correct: true },
    { answer: "A", correct: true },
    { answer: "B", correct: false },
    { answer: "C", correct: false },
    { answer: "D", correct: false },
  ];
  close(pluralityAtN(members, 5), 1);
  close(majorityAtN(5, 2, 5), 0);
  assert.equal(pluralityAtN(members, 3), pluralityAtN(members, 3), "seeded: identical on rerun");
});

test("the paired one-sided t-test matches the t table (df = 19, t = 2.093 → p ≈ 0.025)", () => {
  // 20 differences with mean 2.093·se: build them as ±s around the mean.
  const target = 2.093;
  const d = Array.from({ length: 20 }, (_, i) => (i % 2 ? 1 : -1));
  const sd = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / 19);
  const shift = (target * sd) / Math.sqrt(20);
  const r = pairedOneSided(d.map((x) => x + shift));
  close(r.t, target, 1e-9);
  close(r.p, 0.025, 1e-4);
  assert.equal(pairedOneSided([0.5]).p, null, "one question cannot be tested");
  assert.equal(pairedOneSided([0.2, 0.2, 0.2]).p, 0, "no spread, positive mean");
});

/** n questions; the pool has `poolSize` independent runs per question with `kCorrect` correct. */
function suite({
  n = 30,
  poolSize = 8,
  kCorrect = 2,
  groupCorrect,
  groupTokens = 400,
  unit = 100,
}) {
  const group = [];
  const pool = [];
  for (let q = 0; q < n; q++) {
    const id = `q${String(q).padStart(2, "0")}`;
    group.push({ id, correct: groupCorrect(q), tokens: groupTokens });
    for (let j = 0; j < poolSize; j++) pool.push({ id, correct: j < kCorrect, tokens: unit });
  }
  return { group, pool };
}

test("c₁ counts only pool runs that answered; n_B = group tokens / c₁", () => {
  const r = gradeLadder({
    group: [{ id: "a", correct: true, tokens: 600 }],
    pool: [
      { id: "a", correct: true, tokens: 100 },
      { id: "a", correct: false, tokens: 100 },
      { id: "a", correct: false, tokens: 100, answered: false },
    ],
  });
  assert.equal(r.c1, 150, "300 tokens paid, 2 runs answered");
  assert.equal(r.nB, 4);
});

test("a group that always solves what one agent solves 25% of the time clears all three levels", () => {
  const r = gradeLadder(suite({ groupCorrect: () => true, groupTokens: 300 })); // n_B = 3
  assert.equal(r.nB, 3);
  assert.equal(r.level, 3);
  assert.ok(r.margin > 0);
  close(r.tn, passAtN(8, 2, 3), 1e-4);
});

test("levels are monotone: beating one agent but not pass@n stops at the right rung", () => {
  // Group right 60% of the time; one agent 25%; pass@3 of 8-with-2 ≈ 0.64.
  const r = gradeLadder(suite({ n: 60, groupCorrect: (q) => q % 5 < 3, groupTokens: 300 }));
  assert.ok(r.tests[1].cleared, "beats one agent");
  assert.equal(r.tests[3].cleared, false, "does not beat pass@n");
  assert.ok(r.level < 3);
  assert.ok(r.level >= 1);
});

test("a group below one agent is level 0", () => {
  const r = gradeLadder(suite({ groupCorrect: () => false }));
  assert.equal(r.level, 0);
});

test("non-integer n_B interpolates between the neighbouring integer budgets", () => {
  const r = gradeLadder(suite({ groupCorrect: () => true, groupTokens: 250 })); // n_B = 2.5
  close(r.tn, (passAtN(8, 2, 2) + passAtN(8, 2, 3)) / 2, 1e-4);
});

test("a pool smaller than the budget leaves levels 2 and 3 indeterminate, never claimed", () => {
  const r = gradeLadder(suite({ poolSize: 3, groupCorrect: () => true, groupTokens: 500 })); // n_B = 5 > 3
  assert.equal(r.tests[2].indeterminate, true);
  assert.equal(r.tests[3].indeterminate, true);
  assert.equal(r.level, 1, "only the one-agent bar can be judged");
  assert.equal(r.margin, null);
  assert.ok(r.warnings.some((w) => /fewer than 5 independent runs/.test(w)));
});

test("questions without independent runs are left out and reported", () => {
  const s = suite({ n: 5, groupCorrect: () => true });
  s.group.push({ id: "orphan", correct: true, tokens: 400 });
  const r = gradeLadder(s);
  assert.deepEqual(r.excluded, ["orphan"]);
  assert.equal(r.questions, 5);
});

test("bad input is refused with the reason", () => {
  assert.throws(() => gradeLadder({ group: [], pool: [] }), /No group records/);
  assert.throws(
    () =>
      gradeLadder({
        group: [{ id: "a", correct: "yes", tokens: 1 }],
        pool: [{ id: "a", correct: true, tokens: 1 }],
      }),
    /correct must be true\/false/,
  );
  assert.throws(
    () =>
      gradeLadder({
        group: [{ id: "a", correct: true, tokens: 1 }],
        pool: [{ id: "a", correct: true, tokens: 0 }],
      }),
    /c₁ is undefined/,
  );
});

test("records parse from a JSON object or from JSON Lines with an arm field", () => {
  const obj = parseLadderRecords(
    JSON.stringify({ group: [{ id: "a" }], pool: [{ id: "a" }, { id: "a" }] }),
  );
  assert.equal(obj.pool.length, 2);
  const jsonl = parseLadderRecords(
    [
      '{"arm":"group","id":"a","correct":true,"tokens":4}',
      '{"arm":"pool","id":"a","correct":false,"tokens":1}',
    ].join("\n"),
  );
  assert.equal(jsonl.group.length, 1);
  assert.equal(jsonl.pool.length, 1);
  assert.throws(() => parseLadderRecords('{"arm":"team","id":"a"}\n{"arm":"pool"}'), /arm must be/);
});
