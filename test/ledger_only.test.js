// Legacy-store retirement (FORGE_LEDGER_ONLY): ledger-only is now the DEFAULT — the
// legacy files (lessons/*.md, recall/brain fact files) are not written and reads come
// from the ledger alone. FORGE_LEDGER_ONLY=0 is the escape hatch that restores the file
// store (covered by the legacy-pinned suites). These tests exercise the default path
// end-to-end, from the store layer up through the cortex learning loop.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordMistake, summary } from "../src/cortex.js";
import { reconcileFacts, recordLessonEvent, shadowFact } from "../src/ledger_bridge.js";
import { ledgerFacts, ledgerLessons, mergedLessons } from "../src/ledger_read.js";
import { newLesson } from "../src/lessons.js";
import { lessonsDir, save } from "../src/lessons_store.js";
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

test("ledger-only: save() writes no .md file and reports ledgerOnly", () => {
  withEnv({ FORGE_LEDGER_ONLY: "1" }, () => {
    const root = tmpRoot();
    const s = save(root, makeLesson("lsn_a"));
    assert.equal(s.ok, true);
    assert.equal(s.ledgerOnly, true);
    assert.equal(existsSync(lessonsDir(root)), false, "no legacy lessons dir should be created");
  });
});

test("ledger-only: a minted lesson is served from the ledger via ledgerLessons + mergedLessons", () => {
  withEnv({ FORGE_LEDGER_ONLY: "1" }, () => {
    const root = tmpRoot();
    const lesson = makeLesson("lsn_b");
    save(root, lesson); // no-op file write
    recordLessonEvent(root, lesson, { t: 0 }); // the ledger is the store
    assert.ok(ledgerLessons(root, 0).some((l) => l.id === "lsn_b"));
    assert.ok(mergedLessons(root, 0).some((l) => l.id === "lsn_b"));
  });
});

test("escape hatch (FORGE_LEDGER_ONLY=0): save() DOES write the legacy .md file", () => {
  withEnv({ FORGE_LEDGER_ONLY: "0" }, () => {
    const root = tmpRoot();
    const s = save(root, makeLesson("lsn_c"));
    assert.equal(s.ok, true);
    assert.equal(s.ledgerOnly, undefined);
    assert.equal(
      existsSync(lessonsDir(root)),
      true,
      "legacy lessons dir written with the escape hatch",
    );
  });
});

test("default is ledger-only: save() writes no file even with FORGE_LEDGER_ONLY unset", () => {
  withEnv({ FORGE_LEDGER_ONLY: undefined }, () => {
    const root = tmpRoot();
    const s = save(root, makeLesson("lsn_d"));
    assert.equal(s.ok, true);
    assert.equal(s.ledgerOnly, true, "ledger-only is the default now");
    assert.equal(existsSync(lessonsDir(root)), false, "no legacy lessons dir by default");
  });
});

test("ledger-only: recall.add writes no fact file; readFact + list resolve from the ledger", () => {
  withEnv({ FORGE_LEDGER_ONLY: "1" }, () => {
    const store = tmpRoot();
    const res = add(store, "API base", "https://api.example.com");
    assert.equal(res.ok, true);
    assert.equal(existsSync(join(store, "facts")), false, "no legacy fact files under ledger-only");
    // The caller shadows the fact into the ledger (what `forge recall add` does).
    shadowFact(join(store, "ledger"), "API base", "https://api.example.com", 0);
    const f = readFact(store, res.slug);
    assert.ok(f, "fact resolves from the ledger");
    assert.equal(f.text, "https://api.example.com");
    assert.ok(list(store).includes(res.slug), "merged list includes the ledger fact");
  });
});

test("ledger-only: reconcileFacts is a no-op and never tombstones ledger facts (no data loss)", () => {
  withEnv({ FORGE_LEDGER_ONLY: "1", FORGE_AUTHOR: "Tester <t@example.com>" }, () => {
    const store = tmpRoot();
    const ledgerDir = join(store, "ledger");
    // Two facts live only in the ledger (no fact files exist under ledger-only).
    shadowFact(ledgerDir, "API base", "https://api.example.com", 0);
    shadowFact(ledgerDir, "DB host", "db.example.com", 0);
    assert.equal(ledgerFacts(ledgerDir).length, 2, "two live facts before reconcile");
    // Under the file-store model this would tombstone BOTH (no backing file); under
    // ledger-only it must leave them untouched.
    const r = reconcileFacts(store, ledgerDir, 1);
    assert.equal(r.ok, true);
    assert.equal(r.removed, 0, "reconcile removes nothing under ledger-only");
    assert.equal(ledgerFacts(ledgerDir).length, 2, "both facts survive — no memory wiped");
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
