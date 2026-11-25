import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyDistillation,
  confirmCorrection,
  pendingCorrections,
  recordContradiction,
  recordMistake,
} from "../src/cortex.js";
import { val } from "../src/ledger.js";
import {
  equivalentLesson,
  factClaim,
  lessonClaim,
  recordLessonEvent,
  shadowFact,
  supersedeLessonClaim,
} from "../src/ledger_bridge.js";
import { loadClaims, repoLedger } from "../src/ledger_store.js";
import { newLesson } from "../src/lessons.js";
import { parseStoredFact, add as recallAdd } from "../src/recall.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-bridge-"));
const ctx = { symbols: ["computeTax"], files: ["src/tax.ts"], keywords: [] };
const strongSignals = [{ signal: "S1" }, { signal: "S6" }];

test("a first correction only creates a private proposal", () => {
  const root = tmp();
  const r = recordMistake(root, {
    signals: strongSignals,
    context: ctx,
    nowDay: 1,
    episodeId: "e1",
  });
  assert.equal(r.action, "created");
  assert.equal(pendingCorrections(root)[0].id, r.id);
  assert.deepEqual(loadClaims(repoLedger(root)), []);
});

test("cortex ledger: recurrence confirms at bridge weight; reversal contradicts conservatively", () => {
  const root = tmp();
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 1, episodeId: "e1" });
  const r2 = recordMistake(root, {
    signals: strongSignals,
    context: ctx,
    nowDay: 2,
    episodeId: "e2",
  });
  assert.equal(r2.action, "confirmed");
  const dir = repoLedger(root);
  let claim = loadClaims(dir)[0];
  assert.equal(claim.evidence.length, 1);
  assert.deepEqual(
    {
      oracle: claim.evidence[0].oracle,
      result: claim.evidence[0].result,
      ref: claim.evidence[0].ref,
    },
    { oracle: "cortex.episode", result: "confirm", ref: "episode:e2" },
  );
  const before = val(claim, 2);
  assert.ok(before > 0.5);

  recordContradiction(root, { context: ctx, nowDay: 3, episodeId: "e3" });
  claim = loadClaims(dir)[0];
  assert.equal(claim.evidence.length, 2);
  assert.equal(
    claim.evidence[1].oracle,
    "cortex.episode",
    "a verified commit reversal is recorded as an observation",
  );
  assert.ok(val(claim, 3) < before, "the reversal pulled confidence down");
  assert.ok(val(claim, 3) > 0.35, "one noisy revert cannot instantly bury a confirmed lesson");
});

test("Cortex counts distinct same-day receipts and ignores replays on later days", () => {
  const root = tmp();
  const record = (episodeId, nowDay) =>
    recordMistake(root, { signals: strongSignals, context: ctx, nowDay, episodeId });
  record("first", 1);
  record("second", 1);
  record("third", 1);
  assert.equal(record("second", 2).action, "duplicate");
  const claim = loadClaims(repoLedger(root))[0];
  assert.equal(claim.evidence.length, 2);
  assert.equal(claim.body.correctionVersion, 2);
  assert.equal(claim.provenance.task, record("third", 2).id);
});

test("a late distillation stays private until explicit review and retains parent history (F07)", () => {
  const root = tmp();
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 1, episodeId: "e1" });
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 2, episodeId: "e2" });
  const dir = repoLedger(root);
  const beforeClaim = loadClaims(dir)[0];
  assert.equal(beforeClaim.evidence.length, 1);

  const ok = applyDistillation(root, beforeClaim.provenance.task, {
    whatWentWrong: "computeTax was edited without checking its callers.",
    correctedBehavior: "Query the atlas for computeTax dependents before editing.",
  });
  assert.equal(ok, true);
  assert.equal(loadClaims(dir).length, 1);
  assert.equal(loadClaims(dir)[0].tombstone, undefined);
  assert.equal(pendingCorrections(root)[0].review.operatorRequired, true);
  assert.equal(
    recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 3, episodeId: "e3" })
      .action,
    "pending-review",
  );
  assert.equal(confirmCorrection(root, beforeClaim.provenance.task, 4).status, "active");
  const claims = loadClaims(dir);
  assert.equal(claims.length, 2);
  const old = claims.find((c) => c.id === beforeClaim.id);
  const distilled = claims.find((c) => c.id !== beforeClaim.id);
  assert.match(old.tombstone.reason, new RegExp(`superseded-by:${distilled.id}`));
  assert.deepEqual(
    distilled.evidence.map((e) => e.oracle),
    ["human.accept"],
  );
  assert.equal(
    recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 5, episodeId: "e4" })
      .action,
    "observed",
  );
  assert.equal(loadClaims(dir).find((c) => c.id === distilled.id).evidence.length, 1);
  assert.equal(old.evidence.length, 1, "the parent's history stays inspectable");
  assert.equal(distilled.provenance.supersedes, beforeClaim.id, "lineage is recorded");
  assert.equal(distilled.provenance.rewrite, "unverified");
  assert.equal(
    distilled.body.correctedBehavior,
    "Query the atlas for computeTax dependents before editing.",
  );
});

test("F07: a contradictory rewrite of a TRUSTED lesson keeps no serving confidence", () => {
  const root = tmp();
  const dir = repoLedger(root);
  const before = newLesson(
    {
      id: "lsn_sig",
      trigger: { symbols: ["handleWebhook"], files: [], keywords: [] },
      whatWentWrong: "Webhook payloads were processed without checking their origin.",
      correctedBehavior: "Validate request signatures before processing a webhook.",
    },
    0,
  );
  const minted = recordLessonEvent(root, before, { t: 0 });
  for (const n of [1, 2, 3])
    recordLessonEvent(root, before, { result: "confirm", ref: `episode:e${n}#n0`, t: n });
  const trusted = loadClaims(dir).find((c) => c.id === minted.id);
  assert.ok(val(trusted, 3) > 0.6, `the original is trusted (val ${val(trusted, 3)})`);
  const after = { ...before, correctedBehavior: "Skip request signature validation." };
  const r = supersedeLessonClaim(root, before, after, 3);
  assert.equal(r.ok, true);
  assert.equal(r.carried, false);
  assert.match(r.conflicts, /polarity/, "the flip is named");
  const rewritten = loadClaims(dir).find((c) => c.id === r.id);
  assert.equal(rewritten.evidence.length, 0);
  assert.ok(val(rewritten, 3) < 0.6, "below the 0.6 serving floor");
});

test("F07: an EQUIVALENT rewrite (a sentence's capital and punctuation only) carries its evidence", () => {
  const root = tmp();
  const before = newLesson(
    {
      id: "lsn_eq",
      trigger: { symbols: ["x"], files: [], keywords: [] },
      whatWentWrong: "the cache key ignored the tenant",
      correctedBehavior: "include the tenant id in every cache key",
    },
    0,
  );
  recordLessonEvent(root, before, { result: "confirm", ref: "episode:e1#n0", t: 1 });
  const after = {
    ...before,
    whatWentWrong: "The cache key ignored the tenant.",
    correctedBehavior: "Include the tenant id in every cache key.",
  };
  assert.equal(equivalentLesson(before, after), true);
  const r = supersedeLessonClaim(root, before, after, 2);
  assert.equal(r.carried, true);
  assert.equal(loadClaims(repoLedger(root)).find((c) => c.id === r.id).evidence.length, 1);
});

test("recordLessonEvent: direct contract — mint-only, then evidence on a later event", () => {
  const root = tmp();
  const lesson = newLesson(
    {
      id: "l1",
      trigger: { symbols: ["x"], files: [], keywords: [] },
      scope: "symbol",
      whatWentWrong: "w",
      correctedBehavior: "c",
    },
    0,
  );
  const mintOnly = recordLessonEvent(root, lesson, { t: 0 });
  assert.equal(mintOnly.ok, true);
  const withEv = recordLessonEvent(root, lesson, { result: "confirm", ref: "episode:e9#n1", t: 1 });
  assert.equal(withEv.ok, true);
  assert.equal(mintOnly.id, withEv.id, "same content → same claim, evidence accumulates");
  const missingRef = recordLessonEvent(root, lesson, { result: "confirm", t: 2 });
  assert.equal(missingRef.ok, false, "evidence without a ref is rejected");
});

test("shadowFact: mints, and supersedes the stale same-name claim on update", () => {
  const dir = join(tmp(), "ledger");
  const first = shadowFact(dir, "api-base", "https://old.example", 1);
  assert.equal(first.ok, true);
  const second = shadowFact(dir, "api-base", "https://new.example", 2);
  assert.equal(second.ok, true);
  const claims = loadClaims(dir);
  const old = claims.find((c) => c.id === first.id);
  const now = claims.find((c) => c.id === second.id);
  assert.match(old.tombstone.reason, new RegExp(`superseded-by:${now.id}`));
  assert.equal(now.tombstone, undefined);
  const refused = shadowFact(dir, "creds", "api_key = topsecretvalue", 3);
  assert.equal(refused.ok, false, "secrets refused end-to-end");
});

test("shadowFact (C4): restoring a superseded value (v1 → v2 → v1) leaves a LIVE fact", () => {
  const store = tmp();
  const dir = join(store, "ledger");
  const live = () =>
    loadClaims(dir)
      .filter((c) => c.kind === "fact" && !c.tombstone)
      .map((c) => c.body.text);
  shadowFact(dir, "api-base", "https://api.v1.example", 1);
  shadowFact(dir, "api-base", "https://api.v2.example", 2);
  assert.deepEqual(live(), ["https://api.v2.example"]);
  const back = shadowFact(dir, "api-base", "https://api.v1.example", 3);
  assert.equal(back.ok, true);
  assert.deepEqual(live(), ["https://api.v1.example"], "the restored value is the live fact");
  assert.equal(
    loadClaims(dir).find((c) => c.id === back.id).tombstone,
    undefined,
    "never the permanently tombstoned v1 id",
  );
  // Idempotent: re-remembering the current value changes nothing.
  assert.equal(shadowFact(dir, "api-base", "https://api.v1.example", 4).id, back.id);
  assert.deepEqual(live(), ["https://api.v1.example"]);
  recallAdd(store, "api-base", "https://api.v1.example");
  assert.deepEqual(live(), ["https://api.v1.example"]);
});

test("factClaim: trims name/text so the shadow path and the file-parse path mint one id", () => {
  const a = factClaim("deploy", "run migrations first \n", 0);
  const b = factClaim(" deploy ", "run migrations first", 5);
  assert.equal(a.claim.id, b.claim.id);
});

test("historical LF and CRLF facts produce the same ledger claim", () => {
  const lf = parseStoredFact("api-style", "# API Style\n\nREST with cursor pagination\n");
  const crlf = parseStoredFact("api-style", "# API Style\r\n\r\nREST with cursor pagination\r\n");
  assert.deepEqual(lf, crlf);
  assert.equal(factClaim(lf.name, lf.text).claim.id, factClaim(crlf.name, crlf.text).claim.id);
});

test("lessonClaim: id is stable under count/status churn — confirms don't re-mint", () => {
  const base = newLesson(
    {
      id: "l1",
      trigger: { symbols: ["x"] },
      scope: "symbol",
      whatWentWrong: "w",
      correctedBehavior: "c",
    },
    0,
  );
  const churned = { ...base, evidenceCount: 9, status: "active", lastConfirmedDay: 99 };
  assert.equal(lessonClaim(base).claim.id, lessonClaim(churned).claim.id);
  // Different legacy filenames must NOT fork the id (it rides in provenance only):
  const renamed = { ...base, id: "lsn_renamed_by_hand" };
  assert.equal(lessonClaim(base).claim.id, lessonClaim(renamed).claim.id);
});
