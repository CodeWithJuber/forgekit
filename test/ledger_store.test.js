import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintClaim, outcomeRecord, val } from "../src/ledger.js";
import {
  appendEvidence,
  importState,
  loadClaims,
  loadState,
  pruneToAttic,
  putClaim,
  readEvidence,
  reindex,
  stats,
  tombstone,
  verify,
} from "../src/ledger_store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-ledger-"));
const fact = (name, text, t = 0) => mintClaim({ kind: "fact", body: { name, text }, t }).claim;
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

test("putClaim: refuses an id that doesn't match the content (no forged addresses)", () => {
  const dir = tmp();
  const c = { ...fact("a", "b"), id: "0".repeat(64) };
  const r = putClaim(dir, c);
  assert.equal(r.ok, false);
  assert.match(r.reason, /id does not match/);
});

test("appendEvidence: appends, dedupes by hash, requires the claim to exist", () => {
  const dir = tmp();
  const c = fact("f", "text");
  putClaim(dir, c);
  const o = ev("confirm", "run:1", 3);
  assert.deepEqual(appendEvidence(dir, c.id, o), { ok: true, deduped: false });
  assert.deepEqual(appendEvidence(dir, c.id, o), { ok: true, deduped: true });
  assert.equal(readEvidence(dir, c.id).length, 1);
  assert.equal(appendEvidence(dir, "f".repeat(64), o).ok, false, "evidence for a ghost claim");
  const loaded = loadClaims(dir)[0];
  assert.ok(val(loaded, 3) > 0.5, "evidence is attached on load");
});

test("corrupt files are quarantined, not fatal: bad claim skipped, bad evidence line skipped", () => {
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
  assert.ok(v.issues.some((i) => /id mismatch/.test(i)));
  assert.ok(v.issues.some((i) => /invalid outcome/.test(i)));
});

test("tombstone: retracts from stats' live view but the claim file stays for audit", () => {
  const dir = tmp();
  const c = fact("wrong", "this was retracted");
  putClaim(dir, c);
  assert.equal(tombstone(dir, c.id, { reason: "superseded", t: 5 }).ok, true);
  const loaded = loadClaims(dir);
  assert.equal(loaded[0].tombstone.reason, "superseded");
  assert.equal(stats(dir).tombstoned, 1);
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
  assert.equal(first.outcomes, 1, "only the unseen outcome lands");
  const again = importState(a, loadState(b));
  assert.deepEqual({ c: again.claims, o: again.outcomes }, { c: 0, o: 0 }, "re-import is a no-op");
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
