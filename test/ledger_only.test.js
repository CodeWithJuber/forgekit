// Legacy-store retirement (FORGE_LEDGER_ONLY): with the switch on, the legacy files
// (lessons/*.md, recall/brain fact files) are not written and reads come from the
// ledger alone. Default off keeps the legacy files canonical (covered by every other
// suite). These tests exercise the on path end-to-end at the store layer.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordLessonEvent, shadowFact } from "../src/ledger_bridge.js";
import { ledgerLessons, mergedLessons } from "../src/ledger_read.js";
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
      trigger: { symbols: ["verifyToken"], files: [], keywords: [], action: "edit" },
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

test("default (off): save() DOES write the legacy .md file", () => {
  withEnv({ FORGE_LEDGER_ONLY: undefined }, () => {
    const root = tmpRoot();
    const s = save(root, makeLesson("lsn_c"));
    assert.equal(s.ok, true);
    assert.equal(s.ledgerOnly, undefined);
    assert.equal(existsSync(lessonsDir(root)), true, "legacy lessons dir is written by default");
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
