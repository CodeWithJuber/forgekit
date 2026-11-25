import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordMistake, summary } from "../src/cortex.js";
import { recordLessonEvent } from "../src/ledger_bridge.js";
import { mergedLessons } from "../src/ledger_read.js";
import { newLesson } from "../src/lessons.js";
import { lessonsDir } from "../src/lessons_store.js";
import { add, list, readFact } from "../src/recall.js";

const tmpRoot = () => mkdtempSync(join(tmpdir(), "forge-lonly-"));

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const makeLesson = (id) =>
  newLesson(
    {
      id,
      trigger: {
        symbols: ["verifyToken"],
        files: [],
        keywords: [],
        action: "edit",
      },
      scope: "symbol",
      whatWentWrong: "forgot to check expiry",
      correctedBehavior: "assert exp before trusting the token",
      provenance: { episodes: [], signals: [] },
    },
    0,
  );

test("the retired store override cannot change live lesson storage", () => {
  for (const flag of [undefined, "0", "false", "1"]) {
    withEnv({ FORGE_LEDGER_ONLY: flag }, () => {
      const root = tmpRoot();
      const lesson = makeLesson("lsn_a");
      assert.equal(recordLessonEvent(root, lesson, { t: 0 }).ok, true);
      assert.ok(mergedLessons(root, 0).some((l) => l.id === "lsn_a"));
      assert.equal(existsSync(lessonsDir(root)), false);
    });
  }
});

test("ledger-only: recall.add writes no fact file; readFact + list resolve from the ledger", () => {
  withEnv({ FORGE_LEDGER_ONLY: "1" }, () => {
    const store = tmpRoot();
    const res = add(store, "API base", "https://api.example.com");
    assert.equal(res.ok, true);
    assert.equal(existsSync(join(store, "facts")), false, "no legacy fact files under ledger-only");
    const f = readFact(store, res.slug);
    assert.ok(f, "fact resolves from the ledger");
    assert.equal(f.text, "https://api.example.com");
    assert.ok(list(store).includes(res.slug), "merged list includes the ledger fact");
  });
});

// End-to-end under the DEFAULT (ledger-only): the cortex learning loop must create,
// promote, and surface a lesson entirely through the ledger — no legacy files.
test("default ledger-only: recordMistake create→confirm promotes via the ledger; summary counts it", () => {
  withEnv({ FORGE_LEDGER_ONLY: undefined, FORGE_AUTHOR: "Tester <t@example.com>" }, () => {
    const root = mkdtempSync(join(tmpdir(), "forge-lonly-e2e-"));
    const ctx = { symbols: ["validateToken"], files: ["src/auth/token.ts"], keywords: [] };
    const strong = [{ signal: "S1" }, { signal: "S6" }];
    const first = recordMistake(root, {
      signals: strong,
      context: ctx,
      nowDay: 1,
      episodeId: "ep1",
    });
    assert.equal(first.action, "created");
    assert.equal(first.status, "candidate");
    const again = recordMistake(root, {
      signals: strong,
      context: ctx,
      nowDay: 2,
      episodeId: "ep2",
    });
    assert.equal(again.action, "confirmed", "recurrence confirms via the ledger, not a duplicate");
    assert.equal(again.status, "active", "a recurrence promotes the lesson");
    // Read surfaces work off the ledger under the default.
    const merged = mergedLessons(root, 2);
    assert.equal(merged.length, 1, "exactly one lesson (no fork)");
    assert.equal(merged[0].status, "active");
    const s = summary(root, 2);
    assert.equal(s.total, 1);
    assert.equal(s.active, 1, "cortex summary counts the ledger lesson");
  });
});
