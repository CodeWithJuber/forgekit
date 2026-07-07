import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalize,
  liveClaims,
  mintClaim,
  outcomeRecord,
  sealRecord,
  val,
} from "../src/ledger.js";
import {
  appendEvidence,
  blame,
  getClaimByPrefix,
  importState,
  loadClaims,
  loadState,
  mergeDirs,
  pruneToAttic,
  putClaim,
  readEvidence,
  reindex,
  stats,
  tombstone,
  verify,
} from "../src/ledger_store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-ledger-"));
const fact = (name, text, t = 0) =>
  mintClaim({ kind: "fact", body: { name, text }, provenance: { author: "tester" }, t }).claim;
const ev = (result, ref, t = 0) => outcomeRecord({ oracle: "test.run", result, ref, t }).outcome;

test("putClaim/loadClaims: roundtrip; rewrite of the same claim is a no-op", () => {
  const dir = tmp();
  const c = fact("style", "tabs are actually spaces here");
  assert.deepEqual(putClaim(dir, c), { ok: true, id: c.id, existed: false });
  assert.equal(putClaim(dir, c).existed, true, "content-addressed → idempotent");
  const loaded = loadClaims(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, c.id);
  assert.deepEqual(loaded[0].body, c.body);
});

test("claim file bytes are pure content — two authors' mints are byte-identical, provenance goes to the log", () => {
  const dirA = tmp();
  const dirB = tmp();
  const a = mintClaim({
    kind: "fact",
    body: { name: "x", text: "y" },
    provenance: { author: "alice" },
    t: 1,
  }).claim;
  const b = mintClaim({
    kind: "fact",
    body: { name: "x", text: "y" },
    provenance: { author: "bob" },
    t: 9,
  }).claim;
  putClaim(dirA, a);
  putClaim(dirB, b);
  const path = (d, c) => join(d, "claims", c.id.slice(0, 2), `${c.id}.json`);
  assert.equal(
    readFileSync(path(dirA, a), "utf8"),
    readFileSync(path(dirB, b), "utf8"),
    "same id ⇒ same bytes on every replica — git can never conflict on a claim file",
  );
  assert.ok(!readFileSync(path(dirA, a), "utf8").includes("alice"), "no provenance in claim bytes");
  const viewA = loadClaims(dirA)[0];
  assert.equal(viewA.provenance.author, "alice", "provenance preserved via its own log");
});

test("putClaim: refuses an id that doesn't match the content (no forged addresses)", () => {
  const dir = tmp();
  const c = { ...fact("a", "b"), id: "0".repeat(64) };
  const r = putClaim(dir, c);
  assert.equal(r.ok, false);
  assert.match(r.reason, /id does not match/);
});

test("putClaim: repairs a corrupt/truncated claim file instead of trusting existsSync", () => {
  const dir = tmp();
  const c = fact("healme", "important content");
  putClaim(dir, c);
  const path = join(dir, "claims", c.id.slice(0, 2), `${c.id}.json`);
  writeFileSync(path, '{"kind":"fact","bo'); // killed mid-write
  assert.equal(loadClaims(dir).length, 0, "corrupt claim is not trusted");
  const again = putClaim(dir, c);
  assert.equal(again.ok, true);
  assert.equal(again.existed, false, "repair reported as a fresh write");
  assert.equal(loadClaims(dir).length, 1, "claim is loadable again");
});

test("appendEvidence: appends, dedupes by hash, requires the claim to exist and a valid outcome", () => {
  const dir = tmp();
  const c = fact("f", "text");
  putClaim(dir, c);
  const o = ev("confirm", "run:1", 3);
  assert.deepEqual(appendEvidence(dir, c.id, o), { ok: true, deduped: false });
  assert.deepEqual(appendEvidence(dir, c.id, o), { ok: true, deduped: true });
  assert.equal(readEvidence(dir, c.id).length, 1);
  assert.equal(appendEvidence(dir, "f".repeat(64), o).ok, false, "evidence for a ghost claim");
  assert.equal(
    appendEvidence(dir, c.id, { oracle: "made.up", result: "confirm", ref: "x", h: "y" }).ok,
    false,
    "unknown oracle rejected at the store boundary too",
  );
  const loaded = loadClaims(dir)[0];
  assert.ok(val(loaded, 3) > 0.5, "evidence is attached on load");
});

test("corrupt files are quarantined, not fatal — and verify names what load skips", () => {
  const dir = tmp();
  const good = fact("good", "content");
  putClaim(dir, good);
  // Tampered claim: valid JSON at the right path, wrong content for its address.
  writeFileSync(
    join(dir, "claims", good.id.slice(0, 2), `${"e".repeat(64)}.json`),
    '{"kind":"fact","body":{"name":"evil","text":"tampered"},"scope":{},"v":1}',
  );
  appendEvidence(dir, good.id, ev("confirm", "run:1"));
  writeFileSync(
    join(dir, "evidence", `${good.id}.log`),
    `${readFileSync(join(dir, "evidence", `${good.id}.log`), "utf8")}not json at all\n`,
  );
  const loaded = loadClaims(dir);
  assert.equal(loaded.length, 1, "tampered claim not trusted");
  assert.equal(loaded[0].evidence.length, 1, "corrupt evidence line skipped");
  const v = verify(dir);
  assert.equal(v.ok, false, "verify reports what load silently skips");
  assert.ok(v.issues.some((i) => /unparseable or id mismatch/.test(i)));
  assert.ok(v.issues.some((i) => /unparseable or missing hash/.test(i)));
});

test("verify: catches forged evidence — wrong content hash, unknown oracle, inflated weight", () => {
  const dir = tmp();
  const c = fact("target", "forgery magnet");
  putClaim(dir, c);
  appendEvidence(dir, c.id, ev("confirm", "run:legit"));
  const logPath = join(dir, "evidence", `${c.id}.log`);
  const forged = [
    // real-looking record whose h doesn't match its content
    '{"author":"","h":"deadbeef","oracle":"test.run","ref":"x","result":"confirm","t":0,"w":0.8}',
    // correctly sealed record naming an oracle that doesn't exist
    JSON.stringify(
      sealRecord({ author: "", oracle: "made.up", ref: "x", result: "confirm", t: 0, w: 1 }),
    ),
  ].join("\n");
  writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${forged}\n`);
  const v = verify(dir);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => /content hash mismatch/.test(i)));
  assert.ok(v.issues.some((i) => /invalid outcome/.test(i)));
  assert.equal(v.outcomes, 1, "only the legit outcome counts");
  // And the forged lines can't move confidence either (val ignores them):
  const honest = val(loadClaims(dir)[0], 0);
  assert.ok(honest > 0.5 && honest < 0.75, `val=${honest} reflects one real confirm only`);
});

test("tombstone: append-only records; concurrent retractions coexist; stats reflects it", () => {
  const dir = tmp();
  const c = fact("wrong", "this was retracted");
  putClaim(dir, c);
  assert.equal(tombstone(dir, c.id, { reason: "superseded", t: 5, author: "alice" }).ok, true);
  assert.equal(tombstone(dir, c.id, { reason: "duplicate", t: 3, author: "bob" }).ok, true);
  const loaded = loadClaims(dir)[0];
  assert.equal(loaded.tombstone.author, "bob", "earliest record is the view");
  assert.equal(stats(dir).tombstoned, 1);
});

test("getClaimByPrefix: finds one claim via its shard without scanning the ledger", () => {
  const dir = tmp();
  const c = fact("needle", "in a stack of shards");
  putClaim(dir, c);
  appendEvidence(dir, c.id, ev("confirm", "run:1"));
  const hit = getClaimByPrefix(dir, c.id.slice(0, 8));
  assert.equal(hit.id, c.id);
  assert.equal(hit.evidence.length, 1);
  assert.equal(getClaimByPrefix(dir, "zz"), null);
  assert.equal(getClaimByPrefix(dir, "a"), null, "sub-shard prefixes are refused");
});

test("importState: semilattice import is idempotent and merges evidence", () => {
  const a = tmp();
  const b = tmp();
  const shared = fact("shared", "both replicas know this");
  const onlyB = fact("only-b", "bob learned this alone");
  putClaim(a, shared);
  appendEvidence(a, shared.id, ev("confirm", "run:a", 1));
  putClaim(b, shared);
  appendEvidence(b, shared.id, ev("confirm", "run:a", 1)); // same outcome, both saw it
  appendEvidence(b, shared.id, ev("contradict", "run:b", 2));
  putClaim(b, onlyB);

  const first = importState(a, loadState(b));
  assert.equal(first.claims, 1, "only bob's new claim is new");
  assert.ok(first.records >= 1, "the unseen outcome lands");
  const again = importState(a, loadState(b));
  assert.deepEqual({ c: again.claims, r: again.records }, { c: 0, r: 0 }, "re-import is a no-op");
  assert.equal(loadClaims(a).length, 2);
  assert.equal(readEvidence(a, shared.id).length, 2);
});

test("reindex + stats: human index and counts reflect the live ledger", () => {
  const dir = tmp();
  putClaim(dir, fact("one", "first fact"));
  putClaim(dir, fact("two", "second fact"));
  assert.equal(reindex(dir), 2);
  assert.match(readFileSync(join(dir, "LEDGER.md"), "utf8"), /fact · val 0\.50/);
  const s = stats(dir);
  assert.equal(s.total, 2);
  assert.deepEqual(s.byKind, { fact: 2 });
});

test("pruneToAttic: moves the claim out of the live set but keeps the bytes", () => {
  const dir = tmp();
  const c = fact("old", "long dormant");
  putClaim(dir, c);
  assert.equal(pruneToAttic(dir, c.id).ok, true);
  assert.equal(loadClaims(dir).length, 0);
  assert.ok(readFileSync(join(dir, "attic", `${c.id}.json`), "utf8").includes("long dormant"));
});

// --- team merge + blame (P2) -----------------------------------------------------------

test("mergeDirs: two replicas converge to canonically identical state in either merge order", () => {
  const mkReplica = () => tmp();
  const a = mkReplica();
  const b = mkReplica();
  const shared = fact("shared", "both know this");
  const onlyA = fact("only-a", "alice learned this");
  const onlyB = fact("only-b", "bob learned this");
  // Replica A: shared + own claim + a confirm + a retraction of its own claim.
  putClaim(a, shared);
  putClaim(a, onlyA);
  appendEvidence(a, shared.id, ev("confirm", "run:a", 1));
  tombstone(a, onlyA.id, { reason: "wrong", t: 2, author: "alice" });
  // Replica B: shared + own claim + a different confirm + a retraction of the SAME shared claim.
  putClaim(b, shared);
  putClaim(b, onlyB);
  appendEvidence(b, shared.id, ev("contradict", "run:b", 3));
  tombstone(b, shared.id, { reason: "disputed", t: 4, author: "bob" });

  mergeDirs(a, b); // A absorbs B
  mergeDirs(b, a); // B absorbs (A ∪ B)
  const canonState = (d) => canonicalize(liveClaims(loadState(d)));
  assert.equal(canonState(a), canonState(b), "replicas are canonically identical");
  // And a third replica merging in the opposite order reaches the same state:
  const c = mkReplica();
  mergeDirs(c, b);
  mergeDirs(c, a);
  assert.equal(canonState(c), canonState(a), "order of merges never matters");
  assert.equal(mergeDirs(a, b).claims + mergeDirs(a, b).records, 0, "re-merge is a no-op");
});

test("blame: full accountability view — mints, evidence, retractions, per-author trust", () => {
  const dir = tmp();
  const c = mintClaim({
    kind: "fact",
    body: { name: "traced", text: "who said this and why do we believe it" },
    provenance: { author: "alice" },
    t: 1,
  }).claim;
  putClaim(dir, c);
  appendEvidence(
    dir,
    c.id,
    outcomeRecord({ oracle: "ci.run", result: "confirm", ref: "ci:42", author: "bob", t: 2 })
      .outcome,
  );
  tombstone(dir, c.id, { reason: "superseded", t: 3, author: "carol" });
  const b = blame(dir, c.id.slice(0, 8), 3);
  assert.equal(b.id, c.id);
  assert.equal(b.minted[0].author, "alice");
  assert.equal(b.evidence[0].ref, "ci:42");
  assert.equal(b.tombstones[0].author, "carol");
  assert.ok(b.val > 0.5);
  assert.ok(b.trust.alice >= 0.5 && b.trust.alice <= 1);
  assert.equal(blame(dir, "zz", 3), null);
});
