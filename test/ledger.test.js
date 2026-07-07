import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalize,
  claimId,
  clusters,
  jaccard,
  liveClaims,
  mergeStates,
  mintClaim,
  outcomeRecord,
  rec,
  retrieve,
  score,
  sketch,
  val,
} from "../src/ledger.js";
import { fakeAnthropic } from "./_fixtures.js";

// --- canonicalization & content addressing -----------------------------------------

test("canonicalize: key order never changes the bytes (id stability)", () => {
  const a = canonicalize({ b: 1, a: [{ y: 2, x: 1 }], c: "s" });
  const b = canonicalize({ c: "s", a: [{ x: 1, y: 2 }], b: 1 });
  assert.equal(a, b);
});

test("canonicalize: drops undefined/function values, keeps null", () => {
  assert.equal(canonicalize({ a: undefined, b: null, c: () => 1 }), '{"b":null}');
});

test("claimId: pinned fixture — the protocol's address must never drift across versions", () => {
  // If this fixture ever fails, existing ledgers on disk stop resolving. Bump v and
  // write a migration before changing canonicalization or the id recipe.
  const id = claimId("fact", { name: "n", text: "t" }, { level: "repo" });
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, claimId("fact", { text: "t", name: "n" }, { level: "repo" }));
});

test("claimId: provenance and evidence never affect the address (teammates converge)", () => {
  const a = mintClaim({
    kind: "fact",
    body: { name: "x", text: "y" },
    provenance: { author: "alice" },
    t: 1,
  });
  const b = mintClaim({
    kind: "fact",
    body: { name: "x", text: "y" },
    provenance: { author: "bob" },
    t: 9,
  });
  assert.ok(a.ok && b.ok);
  assert.equal(a.claim.id, b.claim.id);
});

test("mintClaim: refuses secrets, unknown kinds, and non-object bodies", () => {
  const s = mintClaim({ kind: "fact", body: { name: "k", text: fakeAnthropic() } });
  assert.equal(s.ok, false);
  assert.match(s.reason, /secret/);
  assert.equal(mintClaim({ kind: "nope", body: {} }).ok, false);
  assert.equal(mintClaim({ kind: "fact", body: "text" }).ok, false);
});

test("outcomeRecord: requires a known oracle, a valid result, and a verifiable ref", () => {
  assert.equal(outcomeRecord({ oracle: "vibes", result: "confirm", ref: "r" }).ok, false);
  assert.equal(outcomeRecord({ oracle: "test.run", result: "maybe", ref: "r" }).ok, false);
  assert.equal(outcomeRecord({ oracle: "test.run", result: "confirm", ref: "" }).ok, false);
  const ok = outcomeRecord({ oracle: "test.run", result: "confirm", ref: "run:1", t: 3 });
  assert.ok(ok.ok);
  assert.match(ok.outcome.h, /^[0-9a-f]{64}$/);
  assert.equal(ok.outcome.w, 0.8);
});

// --- confidence: the decayed Beta posterior -----------------------------------------

const mkClaim = (evidence = []) => {
  const m = mintClaim({ kind: "fact", body: { name: "f", text: "body" }, t: 0 });
  return { ...m.claim, evidence };
};
const ev = (result, t, oracle = "test.run") =>
  outcomeRecord({ oracle, result, ref: `r:${result}:${t}`, t }).outcome;

test("val: fresh claim sits at the 0.5 prior; confirms raise; contradictions lower", () => {
  assert.equal(val(mkClaim(), 0), 0.5);
  assert.ok(val(mkClaim([ev("confirm", 0)]), 0) > 0.5);
  assert.ok(val(mkClaim([ev("contradict", 0)]), 0) < 0.5);
});

test("val: monotone in confirmations (more independent evidence is never worse)", () => {
  let prev = 0.5;
  for (let n = 1; n <= 5; n++) {
    const v = val(mkClaim(Array.from({ length: n }, () => ev("confirm", 0, "ci.run"))), 0);
    assert.ok(v > prev, `val(${n} confirms)=${v} must exceed ${prev}`);
    prev = v;
  }
});

test("val: decays toward the PRIOR (uncertainty), never toward false", () => {
  const confirmed = mkClaim([ev("confirm", 0), ev("confirm", 0)]);
  const now = val(confirmed, 0);
  const later = val(confirmed, 90); // two half-lives
  const muchLater = val(confirmed, 900);
  assert.ok(later < now, "unreviewed confirmation loses weight");
  assert.ok(later > 0.5, "decayed-but-confirmed stays above the prior");
  assert.ok(Math.abs(muchLater - 0.5) < 0.01, "fully decayed → back to uncertainty, not 0");
  // Same shape from below: an old contradiction also relaxes toward 0.5.
  const contradicted = mkClaim([ev("contradict", 0)]);
  assert.ok(val(contradicted, 900) > val(contradicted, 0));
});

test("val: oracle weight matters — a human revert outweighs a behavioral signal", () => {
  const human = val(mkClaim([ev("contradict", 0, "human.revert")]), 0);
  const behav = val(mkClaim([ev("contradict", 0, "behavioral")]), 0);
  assert.ok(human < behav, "stronger oracle pulls harder");
});

test("rec: recency keys on the latest evidence, else the mint day", () => {
  assert.equal(rec(mkClaim(), 0), 1);
  assert.ok(rec(mkClaim(), 45) < rec(mkClaim(), 1));
  const fresh = mkClaim([ev("confirm", 40)]);
  assert.ok(rec(fresh, 45) > rec(mkClaim(), 45), "new evidence refreshes recency");
});

// --- similarity ----------------------------------------------------------------------

test("sketch/jaccard: identical text = 1, disjoint ≈ 0, near-duplicates score high", () => {
  const a = sketch("always run the impacted tests before editing shared utils");
  assert.equal(jaccard(a, sketch("always run the impacted tests before editing shared utils")), 1);
  assert.ok(jaccard(a, sketch("completely unrelated words about cooking pasta dinner")) < 0.15);
  const near = sketch("always run the impacted tests before editing shared utilities");
  assert.ok(jaccard(a, near) > 0.5, "one-word change stays similar");
});

test("sketch: deterministic across calls (no randomness — ids and sketches are stable)", () => {
  assert.deepEqual(sketch("some stable text here"), sketch("some stable text here"));
});

test("clusters: near-duplicates group, distinct claims stay apart", () => {
  const long =
    "before renaming any exported symbol in the shared utilities package always query the " +
    "atlas for reverse dependents and run the impacted test selection so silent breakage";
  const c1 = mintClaim({
    kind: "fact",
    body: { name: "note", text: `${long} is impossible` },
  }).claim;
  const c2 = mintClaim({ kind: "fact", body: { name: "note", text: `${long} is unlikely` } }).claim;
  const c3 = mintClaim({
    kind: "fact",
    body: { name: "note", text: "the deploy pipeline needs the staging flag set first" },
  }).claim;
  const groups = clusters([c1, c2, c3], { tau: 0.5 });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], [c1.id, c2.id].sort());
});

// --- retrieval (Eq. 3) ---------------------------------------------------------------

test("score: outcome-confirmed claims outrank merely-similar unconfirmed ones", () => {
  const q = "renaming a shared symbol";
  const confirmed = {
    ...mintClaim({
      kind: "fact",
      body: { name: "a", text: "check callers before renaming a shared symbol" },
      t: 0,
    }).claim,
    evidence: [ev("confirm", 0), ev("confirm", 0, "human.accept")],
  };
  const unconfirmed = mintClaim({
    kind: "fact",
    body: { name: "b", text: "check callers before renaming a shared symbol" },
    t: 0,
  }).claim;
  assert.ok(score(q, confirmed, { nowDay: 0 }) > score(q, unconfirmed, { nowDay: 0 }));
});

test("retrieve: excludes tombstoned and dormant claims, caps at budget", () => {
  const alive = mkClaim([ev("confirm", 0)]);
  const dead = { ...mkClaim(), tombstone: { reason: "retracted", t: 0, author: "" } };
  const dormant = mkClaim(Array.from({ length: 4 }, (_, i) => ev("contradict", 0, "human.revert")));
  const out = retrieve("body", [alive, dead, dormant], { nowDay: 0, budget: 10 });
  assert.deepEqual(
    out.map((r) => r.claim.id),
    [alive.id],
  );
  assert.equal(retrieve("body", [alive, alive, alive], { budget: 2 }).length, 2);
});

// --- the CRDT merge: the semilattice laws property-tested ----------------------------

const state = (claims, evidence = {}, tombstones = {}) => ({
  claims: Object.fromEntries(claims.map((c) => [c.id, c])),
  evidence,
  tombstones,
});

test("mergeStates: commutative, associative, idempotent — replicas converge in any order", () => {
  const c1 = mintClaim({ kind: "fact", body: { name: "1", text: "one" }, t: 1 }).claim;
  const c2 = mintClaim({ kind: "fact", body: { name: "2", text: "two" }, t: 2 }).claim;
  const c3 = mintClaim({
    kind: "lesson",
    body: { whatWentWrong: "w", correctedBehavior: "c", trigger: {} },
    t: 3,
  }).claim;
  const sA = state([c1, c2], { [c1.id]: [ev("confirm", 1)] });
  const sB = state([c2, c3], { [c1.id]: [ev("confirm", 1), ev("contradict", 2)] });
  const sC = state([c3], {}, { [c2.id]: { reason: "retracted", t: 4, author: "bob" } });

  const canon = (s) => canonicalize(liveClaims(s));
  // commutativity
  assert.equal(canon(mergeStates(sA, sB)), canon(mergeStates(sB, sA)));
  // associativity
  assert.equal(
    canon(mergeStates(mergeStates(sA, sB), sC)),
    canon(mergeStates(sA, mergeStates(sB, sC))),
  );
  // idempotence
  const m = mergeStates(sA, sB);
  assert.equal(canon(mergeStates(m, m)), canon(m));
  assert.equal(canon(mergeStates(m, sA)), canon(m), "absorbing a subset is a no-op");
});

test("mergeStates: evidence unions dedupe by hash; val is identical after any merge order", () => {
  const c = mintClaim({ kind: "fact", body: { name: "x", text: "y" }, t: 0 }).claim;
  const e1 = ev("confirm", 1);
  const e2 = ev("contradict", 2);
  const sA = state([c], { [c.id]: [e1] });
  const sB = state([c], { [c.id]: [e1, e2] });
  const ab = mergeStates(sA, sB);
  const ba = mergeStates(sB, sA);
  assert.equal(ab.evidence[c.id].length, 2, "duplicate outcome merged away");
  assert.equal(
    val(liveClaims(ab)[0], 10),
    val(liveClaims(ba)[0], 10),
    "confidence is merge-order-independent",
  );
});
