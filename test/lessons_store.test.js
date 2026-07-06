import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newLesson } from "../src/lessons.js";
import {
  appendEpisode,
  lessonsDir,
  load,
  parse,
  readEpisodes,
  save,
  serialize,
} from "../src/lessons_store.js";
import { fakeAnthropic } from "./_fixtures.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-lessons-"));

const sample = () => {
  const l = newLesson(
    {
      id: "lsn_auth",
      trigger: {
        files: ["src/auth/*.ts"],
        symbols: ["validateToken"],
        keywords: ["jwt"],
        action: "edit",
      },
      scope: "symbol",
      whatWentWrong: "Changed validateToken signature without updating callers; build broke.",
      correctedBehavior: "grep callers of validateToken before changing its signature.",
      provenance: { episodes: ["ep_1", "ep_2"], signals: ["S1", "S6"] },
    },
    10,
  );
  return {
    ...l,
    status: "active",
    evidenceCount: 3,
    contradictionCount: 1,
    lastConfirmedDay: 12,
  };
};

test("serialize → parse round-trips every field", () => {
  const before = sample();
  const after = parse(serialize(before));
  assert.equal(after.id, before.id);
  assert.equal(after.status, "active");
  assert.equal(after.scope, "symbol");
  assert.deepEqual(after.trigger.symbols, ["validateToken"]);
  assert.deepEqual(after.trigger.files, ["src/auth/*.ts"]);
  assert.equal(after.trigger.action, "edit");
  assert.equal(after.evidenceCount, 3);
  assert.equal(after.contradictionCount, 1);
  assert.equal(after.lastConfirmedDay, 12);
  assert.equal(after.correctedBehavior, before.correctedBehavior);
  assert.deepEqual(after.provenance.signals, ["S1", "S6"]);
});

test("save + load round-trips through the filesystem", () => {
  const root = fixture();
  assert.equal(save(root, sample()).ok, true);
  const loaded = load(root);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "lsn_auth");
  assert.equal(loaded[0].status, "active");
});

test("save refuses secret-like content (never persist a credential)", () => {
  const root = fixture();
  const leak = {
    ...sample(),
    id: "lsn_leak",
    correctedBehavior: `use ${fakeAnthropic("abcdefghijklmnop")} as the key`,
  };
  const res = save(root, leak);
  assert.equal(res.ok, false, "must refuse");
  assert.equal(load(root).length, 0, "nothing written");
});

test("episode log appends and reads back; load() ignores it", () => {
  const root = fixture();
  save(root, sample());
  appendEpisode(root, { id: "ep_1", signals: ["S1", "S6"], p: 0.82 });
  appendEpisode(root, { id: "ep_2", signals: ["S4"], p: 0.4 });
  const eps = readEpisodes(root);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].id, "ep_1");
  assert.equal(eps[1].p, 0.4);
  assert.equal(load(root).length, 1, "episodes.jsonl is not parsed as a lesson");
});

test("load skips a malformed lesson file instead of throwing (one bad file ≠ dead memory)", () => {
  const root = fixture();
  save(root, sample());
  // a hand-edited / half-written file with no front-matter
  writeFileSync(join(lessonsDir(root), "broken.md"), "not a lesson, no front-matter\n");
  const loaded = load(root);
  assert.equal(loaded.length, 1, "the good lesson still loads; the broken one is skipped");
  assert.equal(loaded[0].id, "lsn_auth");
});

test("readEpisodes skips a corrupt JSONL line instead of discarding the whole log", () => {
  const root = fixture();
  appendEpisode(root, { id: "e1", kind: "mistake", day: 1 });
  appendFileSync(join(lessonsDir(root), "episodes.jsonl"), "{ this is not json\n");
  appendEpisode(root, { id: "e2", kind: "mistake", day: 2 });
  const eps = readEpisodes(root);
  assert.equal(eps.length, 2, "both valid records survive; the corrupt line is skipped");
});
