import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyDistillation, recordContradiction, recordMistake } from "../src/cortex.js";
import { val } from "../src/ledger.js";
import {
  factClaim,
  importLegacy,
  lessonClaim,
  reconcileFacts,
  recordLessonEvent,
  shadowFact,
} from "../src/ledger_bridge.js";
import { loadClaims, repoLedger } from "../src/ledger_store.js";
import { newLesson } from "../src/lessons.js";
import { save } from "../src/lessons_store.js";
import { readFact, add as recallAdd } from "../src/recall.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-bridge-"));
const ctx = { symbols: ["computeTax"], files: ["src/tax.ts"], keywords: [] };
const strongSignals = [{ signal: "S1" }, { signal: "S6" }];

test("cortex dual-write: created lesson mints a claim with ZERO evidence (val = prior)", () => {
  const root = tmp();
  const r = recordMistake(root, {
    signals: strongSignals,
    context: ctx,
    nowDay: 1,
    episodeId: "e1",
  });
  assert.equal(r.action, "created");
  const claims = loadClaims(repoLedger(root));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "lesson");
  assert.equal(claims[0].provenance.task, r.id, "legacy id rides in provenance, NOT the body");
  assert.equal(claims[0].body.legacyId, undefined, "body is pure content — teammates converge");
  assert.equal(claims[0].evidence.length, 0, "creation is not confirmation");
  assert.equal(val(claims[0], 1), 0.5);
});

test("cortex dual-write: recurrence confirms at bridge weight; reversal contradicts conservatively", () => {
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
    { oracle: "cortex.episode", result: "confirm", ref: "episode:e2#n1" },
  );
  const before = val(claim, 2);
  assert.ok(before > 0.5);

  recordContradiction(root, { context: ctx, nowDay: 3, episodeId: "e3" });
  claim = loadClaims(dir)[0];
  assert.equal(claim.evidence.length, 2);
  assert.equal(
    claim.evidence[1].oracle,
    "cortex.episode",
    "regex-detected reverts are NOT the full-weight human oracle",
  );
  assert.ok(val(claim, 3) < before, "the reversal pulled confidence down");
  assert.ok(val(claim, 3) > 0.35, "one noisy revert cannot instantly bury a confirmed lesson");
});

test("cortex dual-write: same-day sessions with colliding episode ids stay distinct evidence", () => {
  const root = tmp();
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 1, episodeId: "ep_m0_x" });
  // Two later sessions the same day — detectEpisodes resets its counter, so both emit
  // the same episode id. The evidence counter in the ref keeps them distinct.
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 5, episodeId: "ep_m0_x" });
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 5, episodeId: "ep_m0_x" });
  const claim = loadClaims(repoLedger(root))[0];
  assert.equal(claim.evidence.length, 2, "both real confirmations recorded, none deduped away");
});

test("applyDistillation supersedes: evidence carries over, template claim is tombstoned", () => {
  const root = tmp();
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 1, episodeId: "e1" });
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 2, episodeId: "e2" });
  const dir = repoLedger(root);
  const beforeClaim = loadClaims(dir)[0];
  assert.equal(beforeClaim.evidence.length, 1);

  const ok = applyDistillation(root, "lsn_computetax", {
    whatWentWrong: "computeTax was edited without checking its callers.",
    correctedBehavior: "Query the atlas for computeTax dependents before editing.",
  });
  assert.equal(ok, true);
  const claims = loadClaims(dir);
  assert.equal(claims.length, 2);
  const old = claims.find((c) => c.id === beforeClaim.id);
  const distilled = claims.find((c) => c.id !== beforeClaim.id);
  assert.match(old.tombstone.reason, new RegExp(`superseded-by:${distilled.id}`));
  assert.equal(distilled.evidence.length, 1, "history carried across the body rewrite");
  assert.equal(
    distilled.body.correctedBehavior,
    "Query the atlas for computeTax dependents before editing.",
  );
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

test("factClaim: trims name/text so the shadow path and the file-parse path mint one id", () => {
  const a = factClaim("deploy", "run migrations first \n", 0);
  const b = factClaim(" deploy ", "run migrations first", 5);
  assert.equal(a.claim.id, b.claim.id);
});

test("readFact: CRLF files parse identically to LF files (no Windows fork of the format)", () => {
  const store = tmp();
  recallAdd(store, "API Style", "REST with cursor pagination");
  const lf = readFact(store, "api-style");
  // Simulate a core.autocrlf checkout of the same fact file:
  writeFileSync(
    join(store, "facts", "api-style.md"),
    "# API Style\r\n\r\nREST with cursor pagination\r\n",
  );
  const crlf = readFact(store, "api-style");
  assert.deepEqual(lf, crlf);
  assert.equal(factClaim(lf.name, lf.text).claim.id, factClaim(crlf.name, crlf.text).claim.id);
});

test("reconcileFacts: a fact deleted from the store is tombstoned in the ledger", () => {
  const store = tmp();
  const dir = join(store, "ledger");
  recallAdd(store, "keep", "this fact stays");
  recallAdd(store, "extra", "this fact stays too");
  shadowFact(dir, "keep", "this fact stays", 1);
  shadowFact(dir, "gone", "this was deleted from the store", 1);
  const r = reconcileFacts(store, dir, 2);
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1);
  const claims = loadClaims(dir);
  assert.equal(claims.find((c) => c.body.name === "gone").tombstone.reason, "removed-from-store");
  assert.equal(claims.find((c) => c.body.name === "keep").tombstone, undefined);
});

test("importLegacy: back-fills pre-ledger history; skips claims already tracked live", () => {
  const root = tmp();
  // A legacy lesson with history that predates the ledger: 3 confirmations, 1 contradiction.
  const lesson = {
    ...newLesson(
      {
        id: "lsn_computetax",
        trigger: { symbols: ["computeTax"], files: [], keywords: [] },
        scope: "symbol",
        whatWentWrong: "Edited computeTax without checking callers.",
        correctedBehavior: "Check callers and tests before editing computeTax.",
      },
      10,
    ),
    evidenceCount: 3,
    contradictionCount: 1,
    lastConfirmedDay: 20,
    status: "active",
  };
  assert.equal(save(root, lesson).ok, true);
  const brainStore = join(root, ".forge", "brain");
  assert.equal(
    recallAdd(brainStore, "deploy order", "run migrations before the app roll").ok,
    true,
  );

  const r = importLegacy(root, {
    recallStore: brainStore,
    recallLedger: repoLedger(root),
    nowDay: 20,
  });
  assert.deepEqual(
    { lessons: r.lessons, facts: r.facts, outcomes: r.outcomes, refused: r.refused },
    { lessons: 1, facts: 1, outcomes: 4, refused: [] },
  );
  const claims = loadClaims(repoLedger(root));
  assert.equal(claims.length, 2);
  const imported = claims.find((c) => c.kind === "lesson");
  assert.equal(imported.evidence.length, 4);
  const v = val(imported, 20);
  assert.ok(v > 0.5, `3 confirms vs 1 contradiction should trust the lesson (val=${v})`);

  // Re-run — even after the legacy counters move — is a no-op for tracked claims:
  save(root, { ...lesson, evidenceCount: 4, lastConfirmedDay: 25 });
  const again = importLegacy(root, {
    recallStore: brainStore,
    recallLedger: repoLedger(root),
    nowDay: 25,
  });
  assert.deepEqual({ l: again.lessons, f: again.facts, o: again.outcomes }, { l: 0, f: 0, o: 0 });
  assert.equal(loadClaims(repoLedger(root)).find((c) => c.kind === "lesson").evidence.length, 4);
});

test("importLegacy: a lesson already shadow-written live never gets synthetic double-counts", () => {
  const root = tmp();
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 1, episodeId: "e1" });
  recordMistake(root, { signals: strongSignals, context: ctx, nowDay: 2, episodeId: "e2" });
  const before = loadClaims(repoLedger(root))[0];
  assert.equal(before.evidence.length, 1, "one live confirm");
  const r = importLegacy(root, { nowDay: 3 });
  assert.equal(r.lessons, 0, "claim already tracked");
  assert.equal(r.outcomes, 0, "no synthetic evidence for a live-tracked claim");
  assert.equal(loadClaims(repoLedger(root))[0].evidence.length, 1, "evidence unchanged");
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
