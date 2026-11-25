import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newLesson } from "../src/lessons.js";
import {
  appendEpisode,
  lessonIsSafe,
  lessonsDir,
  parse,
  readEpisodes,
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

test("the legacy lesson codec parses historical files including Windows line endings", () => {
  const raw = serialize(sample());
  assert.deepEqual(parse(raw.replaceAll("\n", "\r\n")), parse(raw));
  assert.throws(() => parse("incomplete front matter"), /invalid lesson file/);
});

test("validation rejects secret-shaped text before the ledger stores it", () => {
  assert.equal(lessonIsSafe(sample()), true);
  assert.equal(
    lessonIsSafe({
      ...sample(),
      correctedBehavior: `use ${fakeAnthropic("abcdefghijklmnop")} as the key`,
    }),
    false,
  );
});

test("episode log appends and reads back independently from lesson claims", () => {
  const root = fixture();
  appendEpisode(root, { id: "ep_1", signals: ["S1", "S6"], p: 0.82 });
  appendEpisode(root, { id: "ep_2", signals: ["S4"], p: 0.4 });
  assert.deepEqual(
    readEpisodes(root).map((e) => e.id),
    ["ep_1", "ep_2"],
  );
});

test("readEpisodes skips a corrupt JSONL line instead of discarding the whole log", () => {
  const root = fixture();
  appendEpisode(root, { id: "e1", kind: "mistake", day: 1 });
  appendFileSync(join(lessonsDir(root), "episodes.jsonl"), "{ this is not json\n");
  appendEpisode(root, { id: "e2", kind: "mistake", day: 2 });
  const eps = readEpisodes(root);
  assert.equal(eps.length, 2, "both valid records survive; the corrupt line is skipped");
});
