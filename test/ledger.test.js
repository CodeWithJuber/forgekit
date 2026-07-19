import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorTrust,
  canonicalize,
  claimId,
  claimText,
  clusters,
  isDormant,
  jaccard,
  liveClaims,
  mergeStates,
  mintClaim,
  outcomeRecord,
  rec,
  refStrength,
  retrieve,
  score,
  sealRecord,
  shingles,
  sketch,
  UNRESOLVED_VAL_CAP,
  val,
} from "../src/ledger.js";
import { SERVE_FLOOR } from "../src/reuse.js";
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

test("mintClaim: normalizes non-JSON values so different Dates can't collide on one id", () => {
  const d1 = mintClaim({
    kind: "fact",
    body: { name: "d", text: new Date(0) },
  });
  const d2 = mintClaim({
    kind: "fact",
    body: { name: "d", text: new Date(86400000) },
  });
  assert.ok(d1.ok && d2.ok);
  assert.notEqual(d1.claim.id, d2.claim.id, "Dates serialize to ISO strings, not {}");
});

test("mintClaim: refuses secrets, unknown kinds, and non-object bodies", () => {
  const s = mintClaim({
    kind: "fact",
    body: { name: "k", text: fakeAnthropic() },
  });
  assert.equal(s.ok, false);
  assert.match(s.reason, /secret/);
  assert.equal(mintClaim({ kind: "nope", body: {} }).ok, false);
  assert.equal(mintClaim({ kind: "fact", body: "text" }).ok, false);
});

test("outcomeRecord: requires a known oracle, a valid result, and a verifiable ref", () => {
  assert.equal(outcomeRecord({ oracle: "vibes", result: "confirm", ref: "r" }).ok, false);
  assert.equal(outcomeRecord({ oracle: "test.run", result: "maybe", ref: "r" }).ok, false);
  assert.equal(outcomeRecord({ oracle: "test.run", result: "confirm", ref: "" }).ok, false);
  const ok = outcomeRecord({
    oracle: "test.run",
    result: "confirm",
    ref: "run:1",
    t: 3,
  });
  assert.ok(ok.ok);
  assert.match(ok.outcome.h, /^[0-9a-f]{64}$/);
  assert.equal(ok.outcome.w, 0.8);
});

test("outcomeRecord: typed git ref is resolved; unresolvable is rejected, untyped is accepted", () => {
  const resolveGit = (sha) => sha === "cafebabe"; // pretend only this object exists
  // a git: ref whose object resolves is accepted
  const good = outcomeRecord({
    oracle: "test.run",
    result: "confirm",
    ref: "git:cafebabe",
    resolveGit,
  });
  assert.ok(good.ok, "resolvable git ref accepted");
  // a git: ref that does not resolve is rejected with a reason
  const bad = outcomeRecord({
    oracle: "test.run",
    result: "confirm",
    ref: "git:deadbeef",
    resolveGit,
  });
  assert.equal(bad.ok, false, "unresolvable git ref rejected");
  assert.match(bad.reason, /unresolvable/);
  // a typed-but-empty ref is rejected on format
  assert.equal(outcomeRecord({ oracle: "test.run", result: "confirm", ref: "git:" }).ok, false);
  // an untyped/legacy ref is accepted unchanged (back-compat)
  assert.ok(outcomeRecord({ oracle: "test.run", result: "confirm", ref: "run:1" }).ok);
});

test("validateRef: ci: must be a locator, human: must be a ratification (ME-05 format grammars)", () => {
  const ok = (ref) => outcomeRecord({ oracle: "ci.run", result: "confirm", ref }).ok;
  // A CI locator: URL, owner/repo@run, or a bare run id — but not prose.
  assert.ok(ok("ci:https://ci.example.com/run/7"), "URL accepted");
  assert.ok(ok("ci:acme/app@1234"), "owner/repo@run accepted");
  assert.ok(ok("ci:42"), "bare run id accepted (back-compat)");
  assert.equal(ok("ci:not-a-url"), false, "made-up CI string refused on format");
  // human: is an explicit ratification (author@ref), never the model's own say-so.
  const okH = (ref) => outcomeRecord({ oracle: "human.accept", result: "confirm", ref }).ok;
  assert.ok(okH("human:alice@decision-42"), "explicit human ratification accepted");
  assert.equal(okH("human:the-model-said-yes"), false, "self-assertion refused on format");
});

test("refStrength: resolved (git/ci/human/legacy) vs format-only (file/test)", () => {
  assert.equal(refStrength("run:1"), "resolved", "untyped/legacy keeps historical trust");
  assert.equal(refStrength("git:cafebabe"), "resolved");
  assert.equal(refStrength("ci:42"), "resolved");
  assert.equal(refStrength("human:alice@d1"), "resolved");
  assert.equal(refStrength("test:made-up-run"), "format", "a run id is a pointer, not a proof");
  assert.equal(refStrength("file:/some/path"), "format");
});

test("val: format-only evidence (test:/file:) cannot lift confidence into the serving band", () => {
  // A single confirm on an UNTYPED (resolved-trust) ref clears the serving floor as before.
  const resolved = mkClaim([
    outcomeRecord({ oracle: "test.run", result: "confirm", ref: "run:legit" }).outcome,
  ]);
  assert.ok(val(resolved, 0) >= SERVE_FLOOR, "resolved evidence still earns trust (no regression)");

  // But test:/file: refs — however many — are capped below the serving/trusted band.
  const madeUp = mkClaim(
    Array.from(
      { length: 6 },
      (_, i) =>
        outcomeRecord({
          oracle: "test.run",
          result: "confirm",
          ref: `test:made-up-run-${i}`,
        }).outcome,
    ),
  );
  assert.ok(val(madeUp, 0) < SERVE_FLOOR, "test:made-up-run never reaches the serving floor");
  assert.ok(val(madeUp, 0) <= UNRESOLVED_VAL_CAP + 1e-9, "capped at UNRESOLVED_VAL_CAP");

  const fileGhost = mkClaim([
    outcomeRecord({
      oracle: "test.run",
      result: "confirm",
      ref: "file:/does/not/exist",
    }).outcome,
  ]);
  assert.ok(val(fileGhost, 0) < SERVE_FLOOR, "file:/does/not/exist cannot lift into serving band");
});

test("val: a resolvable git-ref confirmation raises confidence as before (no regression)", () => {
  const git = mkClaim([
    outcomeRecord({
      oracle: "test.run",
      result: "confirm",
      ref: "git:cafebabe",
    }).outcome,
  ]);
  assert.ok(val(git, 0) >= SERVE_FLOOR, "git evidence lifts confidence past the serving floor");
  // A single resolved confirm lifts the whole claim even if a format-only one rides along.
  const mixed = mkClaim([
    outcomeRecord({
      oracle: "test.run",
      result: "confirm",
      ref: "git:cafebabe",
    }).outcome,
    outcomeRecord({
      oracle: "test.run",
      result: "confirm",
      ref: "test:made-up",
    }).outcome,
  ]);
  assert.ok(val(mixed, 0) >= SERVE_FLOOR, "one resolved confirm removes the format-only cap");
});

// --- confidence: the decayed Beta posterior -----------------------------------------

const mkClaim = (evidence = []) => {
  const m = mintClaim({
    kind: "fact",
    body: { name: "f", text: "body" },
    t: 0,
  });
  return { ...m.claim, evidence };
};
const ev = (result, t, oracle = "test.run") =>
  outcomeRecord({ oracle, result, ref: `r:${result}:${t}:${oracle}`, t }).outcome;

test("val: fresh claim sits at the 0.5 prior; confirms raise; contradictions lower", () => {
  assert.equal(val(mkClaim(), 0), 0.5);
  assert.ok(val(mkClaim([ev("confirm", 0)]), 0) > 0.5);
  assert.ok(val(mkClaim([ev("contradict", 0)]), 0) < 0.5);
});

test("val: monotone in confirmations (more independent evidence is never worse)", () => {
  let prev = 0.5;
  for (let n = 1; n <= 5; n++) {
    const outs = Array.from(
      { length: n },
      (_, i) =>
        outcomeRecord({
          oracle: "ci.run",
          result: "confirm",
          ref: `r:${i}`,
          t: 0,
        }).outcome,
    );
    const v = val(mkClaim(outs), 0);
    assert.ok(v > prev, `val(${n} confirms)=${v} must exceed ${prev}`);
    prev = v;
  }
});

test("val: decays toward the PRIOR (uncertainty), never toward false", () => {
  const confirmed = mkClaim([ev("confirm", 0), ev("confirm", 0, "ci.run")]);
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

test("val: forged evidence buys nothing — weight comes from the ORACLES table, unknown oracles are ignored", () => {
  // A hand-edited log line claiming w=50 on the strongest oracle:
  const forgedWeight = { ...ev("confirm", 0, "human.revert"), w: 50 };
  const honest = val(mkClaim([ev("confirm", 0, "human.revert")]), 0);
  assert.equal(
    val(mkClaim([forgedWeight]), 0),
    honest,
    "stored w is audit metadata, never trusted",
  );
  // A record naming an oracle that doesn't exist:
  const ghost = sealRecord({
    oracle: "made.up",
    result: "confirm",
    ref: "x",
    t: 0,
    w: 1,
    author: "",
  });
  assert.equal(val(mkClaim([ghost]), 0), 0.5, "unknown oracle contributes nothing");
});

test("rec: recency keys on the latest evidence, else the mint day", () => {
  assert.equal(rec(mkClaim(), 0), 1);
  assert.ok(rec(mkClaim(), 45) < rec(mkClaim(), 1));
  const fresh = mkClaim([ev("confirm", 40)]);
  assert.ok(rec(fresh, 45) > rec(mkClaim(), 45), "new evidence refreshes recency");
});

test("isDormant: repeated strong contradictions sink a claim below the retrieval floor", () => {
  assert.equal(isDormant(mkClaim(), 0), false, "the prior is not dormant");
  const sunk = mkClaim([
    ev("contradict", 0, "human.revert"),
    ev("contradict", 0, "human.accept"),
    ev("contradict", 0, "test.run"),
    ev("contradict", 0, "ci.run"),
  ]);
  assert.equal(isDormant(sunk, 0), true);
});

// --- similarity ----------------------------------------------------------------------

test("shingles: 4-token windows over normalized text; short texts fall back to tokens", () => {
  assert.equal([...shingles("Check the CALLERS first, always")].length, 2);
  assert.deepEqual([...shingles("two words")], ["two words"]);
  assert.deepEqual([...shingles("")], []);
});

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

test("claimText: every retrievable kind exposes its human text (not canonical JSON)", () => {
  const lesson = mintClaim({
    kind: "lesson",
    body: {
      whatWentWrong: "w",
      correctedBehavior: "c",
      trigger: { keywords: ["k"], symbols: ["s"] },
    },
  }).claim;
  assert.equal(claimText(lesson), "w c k s");
  const fact = mintClaim({
    kind: "fact",
    body: { name: "n", text: "t" },
  }).claim;
  assert.equal(claimText(fact), "n t");
  const diag = mintClaim({
    kind: "diagnosis",
    body: { signature: "sig", note: "root cause" },
  }).claim;
  assert.equal(claimText(diag), "sig root cause");
});

test("clusters: near-duplicates group, distinct claims stay apart", () => {
  const long =
    "before renaming any exported symbol in the shared utilities package always query the " +
    "atlas for reverse dependents and run the impacted test selection so silent breakage";
  const c1 = mintClaim({
    kind: "fact",
    body: { name: "note", text: `${long} is impossible` },
  }).claim;
  const c2 = mintClaim({
    kind: "fact",
    body: { name: "note", text: `${long} is unlikely` },
  }).claim;
  const c3 = mintClaim({
    kind: "fact",
    body: {
      name: "note",
      text: "the deploy pipeline needs the staging flag set first",
    },
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
      body: {
        name: "a",
        text: "check callers before renaming a shared symbol",
      },
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
  const dead = {
    ...mkClaim(),
    tombstone: { reason: "retracted", t: 0, author: "" },
  };
  const dormant = mkClaim([
    ev("contradict", 0, "human.revert"),
    ev("contradict", 0, "human.accept"),
    ev("contradict", 0, "test.run"),
    ev("contradict", 0, "ci.run"),
  ]);
  const out = retrieve("body", [alive, dead, dormant], {
    nowDay: 0,
    budget: 10,
  });
  assert.deepEqual(
    out.map((r) => r.claim.id),
    [alive.id],
  );
  assert.equal(retrieve("body", [alive, alive, alive], { budget: 2 }).length, 2);
});

// --- the CRDT merge: the semilattice laws property-tested ----------------------------

const tomb = (reason, t, author = "") => sealRecord({ author, reason, t });
const prov = (author, t) => sealRecord({ agent: "test", author, t });
const state = (claims, evidence = {}, tombstones = {}, provenance = {}) => ({
  claims: Object.fromEntries(claims.map((c) => [c.id, c])),
  evidence,
  provenance,
  tombstones,
});

test("mergeStates: commutative, associative, idempotent — replicas converge in any order", () => {
  const c1 = mintClaim({
    kind: "fact",
    body: { name: "1", text: "one" },
    t: 1,
  }).claim;
  const c2 = mintClaim({
    kind: "fact",
    body: { name: "2", text: "two" },
    t: 2,
  }).claim;
  const c3 = mintClaim({
    kind: "lesson",
    body: { whatWentWrong: "w", correctedBehavior: "c", trigger: {} },
    t: 3,
  }).claim;
  const sA = state([c1, c2], { [c1.id]: [ev("confirm", 1)] }, {}, { [c1.id]: [prov("alice", 1)] });
  const sB = state(
    [c2, c3],
    { [c1.id]: [ev("confirm", 1), ev("contradict", 2)] },
    { [c2.id]: [tomb("retracted", 4, "bob")] },
    { [c1.id]: [prov("bob", 2)] },
  );
  const sC = state([c3], {}, { [c2.id]: [tomb("duplicate", 5, "carol")] });

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

test("mergeStates: concurrent retractions both survive; the view picks one deterministically", () => {
  const c = mintClaim({
    kind: "fact",
    body: { name: "x", text: "y" },
    t: 0,
  }).claim;
  const sA = state([c], {}, { [c.id]: [tomb("wrong", 3, "alice")] });
  const sB = state([c], {}, { [c.id]: [tomb("stale", 2, "bob")] });
  const ab = mergeStates(sA, sB);
  const ba = mergeStates(sB, sA);
  assert.equal(ab.tombstones[c.id].length, 2, "both retraction records kept (grow-only set)");
  assert.equal(
    canonicalize(liveClaims(ab)[0].tombstone),
    canonicalize(liveClaims(ba)[0].tombstone),
    "the single-record view is merge-order independent",
  );
  assert.equal(liveClaims(ab)[0].tombstone.author, "bob", "earliest by (t, h) wins the view");
});

test("mergeStates: evidence unions dedupe by hash; val is identical after any merge order", () => {
  const c = mintClaim({
    kind: "fact",
    body: { name: "x", text: "y" },
    t: 0,
  }).claim;
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

// --- per-author trust (P2) -------------------------------------------------------------

test("authorTrust: bootstrap 1.0, degrades with contradicted claims, floors at 0.5, ignores self-confirmation", () => {
  const mint = (name, author) =>
    mintClaim({
      kind: "fact",
      body: { name, text: `${name} content` },
      provenance: { author },
      t: 0,
    }).claim;
  const out = (result, ref, author) =>
    outcomeRecord({ oracle: "test.run", result, ref, author, t: 0 }).outcome;

  const fresh = { ...mint("a", "newbie"), evidence: [] };
  const good = {
    ...mint("b", "alice"),
    evidence: [out("confirm", "r1", "ci"), out("confirm", "r2", "ci")],
  };
  const selfServing = {
    ...mint("c", "bob"),
    evidence: [out("confirm", "r3", "bob")],
  };
  const wrongOften = {
    ...mint("d", "carol"),
    evidence: Array.from({ length: 20 }, (_, i) => out("contradict", `r${i}`, "ci")),
  };
  const trust = authorTrust([fresh, good, selfServing, wrongOften]);
  assert.equal(trust.newbie, 1, "no history → full trust (never punish the new teammate)");
  assert.equal(trust.alice, 1, "only confirmations → full trust");
  assert.equal(trust.bob, 1, "self-confirmation is excluded, so bob has NO history — bootstrap");
  assert.equal(trust.carol, 0.5, "heavily contradicted → floored, never silenced");
  assert.ok(!("" in trust), "anonymous claims don't accumulate trust");
});

test("val with trust: a distrusted author's evidence moves confidence less", () => {
  const claim = mkClaim([
    outcomeRecord({
      oracle: "test.run",
      result: "confirm",
      ref: "r",
      author: "carol",
      t: 0,
    }).outcome,
  ]);
  const flat = val(claim, 0);
  const weighted = val(claim, 0, { trust: { carol: 0.5 } });
  assert.ok(weighted < flat, "trust scales the evidence weight down");
  assert.ok(weighted > 0.5, "but a confirmation still counts for something");
});
