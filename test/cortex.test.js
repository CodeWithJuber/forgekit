import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lessonsForContext, recordContradiction, recordMistake, summary } from "../src/cortex.js";
import { load } from "../src/lessons_store.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-cortex-"));
const ctx = {
  symbols: ["validateToken"],
  files: ["src/auth/token.ts"],
  keywords: [],
};
const strong = [{ signal: "S1" }, { signal: "S6" }]; // outcome + human → fires, high p

test("a non-firing signal cluster is logged but creates no lesson", () => {
  const root = fixture();
  const r = recordMistake(root, {
    signals: [{ signal: "S3" }],
    context: ctx,
    nowDay: 1,
    episodeId: "ep0",
  });
  assert.equal(r.action, "logged", "lone behavioral signal never mints a lesson");
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

  const s = summary(root, 3);
  assert.equal(s.total, 1);
});
