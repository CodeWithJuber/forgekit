import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { workspaceSnapshot } from "../src/cloud_snapshot.js";
import { requiredSet } from "../src/context.js";
import {
  confirmCorrection,
  lessonsForContext,
  pendingCorrections,
  recordContradiction,
  recordMistake,
  startupBlock,
  summary,
} from "../src/cortex.js";
import { appendSessionEvent } from "../src/cortex_hook.js";
import { outcomeRecord } from "../src/ledger.js";
import { lessonClaim } from "../src/ledger_bridge.js";
import { claimToLesson, mergedLessons as load } from "../src/ledger_read.js";
import {
  appendEvidence,
  getClaimByPrefix,
  mergeDirs,
  putClaim,
  readEvidence,
  repoLedger,
  tombstone,
} from "../src/ledger_store.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-cortex-"));
const ctx = {
  symbols: ["validateToken"],
  files: ["src/auth/token.ts"],
  keywords: [],
};
const strong = [{ signal: "S1" }, { signal: "S6" }];

test("a single behavioral source abstains and creates no lesson", () => {
  const root = fixture();
  const r = recordMistake(root, {
    signals: [{ signal: "S3" }],
    context: ctx,
    nowDay: 1,
    episodeId: "ep0",
  });
  assert.equal(r.action, "abstained", "lone behavioral signal never mints a lesson");
  assert.equal(load(root).length, 0);
});

test("first real mistake creates a candidate; recurrence promotes it to active", () => {
  const root = fixture();
  const first = recordMistake(root, {
    signals: strong,
    context: ctx,
    nowDay: 1,
    episodeId: "ep1",
  });
  assert.equal(first.action, "created");
  assert.equal(first.status, "candidate", "one occurrence is not yet trusted");

  assert.equal(first.visibility, "private");
  assert.deepEqual(load(root), []);
  assert.equal(existsSync(join(root, ".forge")), false);
  assert.equal(pendingCorrections(root)[0].id, first.id);
  assert.equal(pendingCorrections(fixture()).length, 0);
  assert.equal(
    recordMistake(root, { signals: strong, context: ctx, nowDay: 3, episodeId: "ep1" }).action,
    "duplicate",
  );

  const again = recordMistake(root, {
    signals: strong,
    context: ctx,
    nowDay: 2,
    episodeId: "ep2",
  });
  assert.equal(again.action, "confirmed");
  assert.equal(again.status, "active", "a recurrence promotes the lesson");

  const lesson = load(root)[0];
  assert.equal(lesson.evidenceCount, 1, "one independent confirmation");
  assert.deepEqual(lesson.provenance.episodes, ["ep1", "ep2"], "episodes accrue for audit");
});

test("an active lesson surfaces for its context; irrelevant context sees nothing", () => {
  const root = fixture();
  recordMistake(root, {
    signals: strong,
    context: ctx,
    nowDay: 1,
    episodeId: "e1",
  });
  recordMistake(root, {
    signals: strong,
    context: ctx,
    nowDay: 2,
    episodeId: "e2",
  }); // → active

  const hit = lessonsForContext(root, { symbols: ["validateToken"] }, { nowDay: 2 });
  assert.equal(hit.selected.length, 1, "injected for the matching symbol");
  assert.match(hit.block, /Lessons for the files in play/);

  const miss = lessonsForContext(root, { symbols: ["unrelatedFn"] }, { nowDay: 2 });
  assert.equal(miss.block, "", "no lesson, no noise for an unrelated file");
});

test("a human reversal contradicts the matching lesson (anti-self-reinforcement path)", () => {
  const root = fixture();
  recordMistake(root, {
    signals: strong,
    context: ctx,
    nowDay: 1,
    episodeId: "a",
  });
  recordMistake(root, {
    signals: strong,
    context: ctx,
    nowDay: 2,
    episodeId: "b",
  }); // active, evidence 1

  const before = load(root)[0].contradictionCount;
  const r = recordContradiction(root, {
    context: ctx,
    nowDay: 3,
    episodeId: "c",
  });
  assert.equal(r.results.length, 1, "the matching lesson was contradicted");
  assert.equal(load(root)[0].contradictionCount, before + 1);

  assert.equal(
    recordContradiction(root, { context: ctx, nowDay: 4, episodeId: "c" }).results[0].duplicate,
    true,
  );
  assert.equal(load(root, 4)[0].status, "quarantined");
  const s = summary(root, 3, { includePrivate: true });
  assert.equal(s.total, 1);
  assert.equal(s.provisional, 0);
});

test("recordMistake reports 'refused' (not 'created') when the save is rejected", () => {
  const root = fixture();
  const r = recordMistake(root, {
    signals: [{ signal: "S1" }, { signal: "S6" }],
    context: { symbols: ["loadCreds"], files: ["src/auth.js"] },
    nowDay: 1,
    episodeId: "ep_leak",
    distilled: { whatWentWrong: "leaked a value", correctedBehavior: 'password = "hunter2xyz"' },
  });
  assert.equal(r.action, "refused", "a refused save must not be reported as created");
  assert.equal(load(root).length, 0, "nothing was persisted");
});

test("operator confirms a private correction under the same canonical checkout", () => {
  const root = fixture(),
    other = fixture();
  const r = recordMistake(root, { signals: strong, context: ctx, nowDay: 1, episodeId: "e1" });
  assert.equal(confirmCorrection(other, r.id, 2).ok, false);
  assert.equal(confirmCorrection(root, r.id, 2).status, "active");
  assert.equal(confirmCorrection(root, r.id, 3).action, "already-published");
  assert.equal(load(root, 3)[0].evidenceCount, 1);
  assert.equal(pendingCorrections(root).length, 0);
});

test("unpublished observations and the raw capture are excluded from full cloud exports", () => {
  const root = fixture();
  appendSessionEvent(root, "session", { type: "bash", command: "echo customer-5831", exitCode: 0 });
  const proposed = recordMistake(root, {
    signals: strong,
    context: { files: ["customer-5831.js"] },
    nowDay: 1,
    episodeId: "local-only",
  });
  assert.equal(proposed.visibility, "private");
  assert.equal(Object.hasOwn(summary(root, 1), "provisional"), false);
  assert.deepEqual(workspaceSnapshot(root).files, []);
});

test("concurrent delivery of the same correction only confirms it once", async () => {
  const root = fixture(),
    run = promisify(execFile);
  recordMistake(root, { signals: strong, context: ctx, nowDay: 1, episodeId: "first" });
  const script =
    "const {recordMistake}=await import(process.argv[1]); console.log(JSON.stringify(recordMistake(process.argv[2],JSON.parse(process.argv[3]))));";
  const args = [
    "--input-type=module",
    "-e",
    script,
    new URL("../src/cortex.js", import.meta.url).href,
    root,
    JSON.stringify({ signals: strong, context: ctx, nowDay: 2, episodeId: "same-delivery" }),
  ];
  const deliveries = await Promise.all(
    Array.from({ length: 4 }, () => run(process.execPath, args)),
  );
  const actions = deliveries.map((r) => JSON.parse(r.stdout).action).sort();
  assert.deepEqual(actions, ["confirmed", "duplicate", "duplicate", "duplicate"]);
  assert.equal(load(root, 2)[0].evidenceCount, 1);
});

test("a shared v2 correction needs checkout evidence or approval of the exact revision", () => {
  const author = fixture(),
    peer = fixture();
  const observe = (root, episodeId, nowDay) =>
    recordMistake(root, { signals: strong, context: ctx, nowDay, episodeId });
  observe(author, "first", 1);
  observe(author, "second", 2);
  const [original] = load(author);
  const id = original.provenance.claim;
  const dst = repoLedger(peer);
  mergeDirs(dst, repoLedger(author), { nowDay: 3 });
  const [imported] = load(peer);
  assert.equal(imported.status, "candidate");
  assert.equal(imported.evidenceCount, 0);
  assert.equal(startupBlock(peer, 3), "");
  assert.equal(lessonsForContext(peer, ctx, { nowDay: 3 }).block, "");
  assert.equal(confirmCorrection(peer, imported.id, 3).ok, false);

  for (const ref of ["test:report-one", "test:report-two", "episode:second"]) {
    const oracle = ref.startsWith("test:") ? "test.run" : "cortex.episode";
    const record = outcomeRecord({ oracle, result: "confirm", t: 1, ref });
    assert.equal(record.ok, true);
    assert.equal(appendEvidence(dst, id, record.outcome).ok, true);
  }
  const claim = getClaimByPrefix(dst, id);
  assert.equal(claimToLesson(claim, 3, peer).status, "candidate");
  assert.equal(lessonsForContext(peer, ctx, { nowDay: 3 }).block, "");

  const gitReceipt = outcomeRecord({
    oracle: "test.run",
    result: "confirm",
    t: 1,
    ref: "git:0123456789abcdef",
  }).outcome;
  const candidates = [{ ...claim, evidence: [...claim.evidence, gitReceipt] }];
  assert.equal(
    requiredSet(peer, "Review src/auth/token.ts", { claims: candidates }).some(
      (r) => r.kind === "lesson",
    ),
    false,
  );
  assert.equal(confirmCorrection(peer, id, 4).status, "active");
  assert.equal(confirmCorrection(peer, id, 5).action, "already-published");
  assert.equal(load(peer)[0].evidenceCount, 1);
  assert.match(lessonsForContext(peer, ctx, { nowDay: 5 }).block, /validateToken/);
  assert.equal(
    requiredSet(peer, "Review src/auth/token.ts", {
      claims: [{ ...candidates[0], evidence: [...readEvidence(dst, id), gitReceipt] }],
    }).some((r) => r.kind === "lesson"),
    true,
  );

  const revision = lessonClaim(
    { ...imported, correctedBehavior: "Inspect the output in the local editor." },
    6,
  ).claim;
  assert.notEqual(revision.id, id);
  putClaim(dst, revision);
  for (const event of readEvidence(dst, id))
    assert.equal(appendEvidence(dst, revision.id, event).ok, true);
  assert.equal(claimToLesson(getClaimByPrefix(dst, revision.id), 6, peer).status, "candidate");
  tombstone(dst, id, { reason: "Revised lesson", t: 6, author: "maintainer" });
  assert.equal(confirmCorrection(peer, id, 7).ok, false);
  assert.equal(confirmCorrection(peer, "0".repeat(64), 7).ok, false);
  assert.equal(lessonsForContext(peer, ctx, { nowDay: 7 }).block, "");
  assert.equal(observe(peer, "first-local", 8).action, "created");
  assert.equal(observe(peer, "second-local", 9).action, "refused");
  assert.equal(lessonsForContext(peer, ctx, { nowDay: 9 }).block, "");
});

test("an independent pair of local recoveries can corroborate the same imported content", () => {
  const author = fixture(),
    peer = fixture();
  const observe = (root, episodeId, nowDay) =>
    recordMistake(root, { signals: strong, context: ctx, nowDay, episodeId });
  observe(author, "first", 1);
  observe(author, "second", 2);
  mergeDirs(repoLedger(peer), repoLedger(author), { nowDay: 3 });
  assert.equal(observe(peer, "local-first", 4).action, "created");
  assert.equal(load(peer)[0].status, "candidate");
  assert.equal(observe(peer, "local-second", 5).status, "active");
  assert.equal(load(peer)[0].evidenceCount, 1);
});
