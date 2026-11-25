import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { workspaceSnapshot } from "../src/cloud_snapshot.js";
import {
  confirmCorrection,
  lessonsForContext,
  pendingCorrections,
  recordContradiction,
  recordMistake,
  summary,
} from "../src/cortex.js";
import { appendSessionEvent } from "../src/cortex_hook.js";
import { mergedLessons as load } from "../src/ledger_read.js";

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
