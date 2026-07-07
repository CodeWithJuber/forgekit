import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordContradiction, recordMistake } from "../src/cortex.js";
import { val } from "../src/ledger.js";
import { importLegacy, lessonClaim, recordFactEvent } from "../src/ledger_bridge.js";
import { loadClaims, repoLedger } from "../src/ledger_store.js";
import { newLesson } from "../src/lessons.js";
import { save } from "../src/lessons_store.js";
import { add as recallAdd } from "../src/recall.js";

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
  assert.equal(claims[0].body.legacyId, r.id);
  assert.equal(claims[0].evidence.length, 0, "creation is not confirmation");
  assert.equal(val(claims[0], 1), 0.5);
});

test("cortex dual-write: a recurrence appends confirm evidence; a human reversal contradicts", () => {
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
  assert.equal(claim.evidence[1].oracle, "human.revert");
  assert.ok(val(claim, 3) < before, "the reversal pulled confidence down");
});

test("recordFactEvent: mints a fact claim; refuses secrets end-to-end", () => {
  const dir = join(tmp(), "ledger");
  assert.equal(recordFactEvent(dir, "deploy", "staging needs FLAG=1 first", 4).ok, true);
  const claims = loadClaims(dir);
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].body, { name: "deploy", text: "staging needs FLAG=1 first" });
  const refused = recordFactEvent(dir, "creds", "api_key = topsecretvalue", 4);
  assert.equal(refused.ok, false);
  assert.equal(loadClaims(dir).length, 1);
});

test("importLegacy: back-fills lessons (counts → dated outcomes) and facts; re-run is a no-op", () => {
  const root = tmp();
  // A legacy lesson with history: 3 confirmations, 1 contradiction.
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

  const again = importLegacy(root, {
    recallStore: brainStore,
    recallLedger: repoLedger(root),
    nowDay: 20,
  });
  assert.deepEqual({ l: again.lessons, f: again.facts, o: again.outcomes }, { l: 0, f: 0, o: 0 });
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
});
