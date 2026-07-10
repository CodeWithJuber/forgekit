import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionPath } from "../src/cortex_hook.js";
import {
  pruneSessions,
  readBaseline,
  readDirtySnapshot,
  recordBaseline,
  rehydrationBlock,
} from "../src/session.js";

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-session-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  writeFileSync(join(root, "a.js"), "export const one = 1;\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, git };
}

test("recordBaseline anchors HEAD once; a resume never moves the anchor", () => {
  const { root, git } = gitFixture();
  const first = recordBaseline(root, "s1");
  assert.equal(first.recorded, true);
  assert.match(first.head, /^[0-9a-f]{40}$/);
  // New commit, then SessionStart re-fires (resume) — the original anchor must survive.
  writeFileSync(join(root, "a.js"), "export const one = 2;\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "second");
  const again = recordBaseline(root, "s1");
  assert.equal(again.recorded, false, "resume keeps the anchor");
  assert.equal(again.head, first.head, "anchor still points at session-start HEAD");
  assert.equal(readBaseline(root, "s1").head, first.head);
});

test("recordBaseline outside a git repo is a safe no-op; readBaseline null", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-session-"));
  assert.equal(recordBaseline(root, "s").recorded, false);
  assert.equal(readBaseline(root, "s"), null);
  assert.equal(existsSync(sessionPath(root, "s", "base")), false, "no file written");
});

test("pruneSessions removes week-old artifacts, keeps fresh ones", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-session-"));
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  const old = sessionPath(root, "old", "base");
  const fresh = sessionPath(root, "fresh");
  writeFileSync(old, "abc\n");
  writeFileSync(fresh, "{}\n");
  const past = (Date.now() - 10 * 86_400_000) / 1000;
  utimesSync(old, past, past);
  const { removed } = pruneSessions(root, { maxAgeDays: 7 });
  assert.equal(removed, 1);
  assert.equal(existsSync(old), false, "aged artifact pruned");
  assert.equal(existsSync(fresh), true, "fresh artifact kept");
});

test("rehydrationBlock: commits + dirty files in a repo; empty string outside", () => {
  const { root } = gitFixture();
  writeFileSync(join(root, "b.js"), "export const two = 2;\n");
  const block = rehydrationBlock(root);
  assert.match(block, /Recent commits:/);
  assert.match(block, /fixture/);
  assert.match(block, /Uncommitted changes at session start:/);
  assert.match(block, /b\.js/);
  assert.equal(rehydrationBlock(mkdtempSync(join(tmpdir(), "forge-session-"))), "");
});

test("rehydrationBlock caps the dirty list with an overflow pointer", () => {
  const { root, git } = gitFixture();
  for (let i = 0; i < 25; i += 1) writeFileSync(join(root, `f${i}.js`), "export const x = 1;\n");
  const block = rehydrationBlock(root, { statusCap: 5 });
  assert.match(block, /\(\+20 more\)/, "overflow counted, not silently dropped");
  git("add", "-A"); // keep fixture dir reusable; not asserted
});

test("recordBaseline snapshots pre-session dirt (even before the anchor exists)", () => {
  const { root } = gitFixture();
  writeFileSync(join(root, "dirty_before.js"), "export const pre = 1;\n");
  recordBaseline(root, "d1");
  const snap = readDirtySnapshot(root, "d1");
  assert.ok(snap.has("dirty_before.js"), "pre-existing dirt captured at session start");
  // A resume never rewrites the snapshot either.
  writeFileSync(join(root, "later.js"), "export const post = 1;\n");
  recordBaseline(root, "d1");
  assert.ok(!readDirtySnapshot(root, "d1").has("later.js"), "resume keeps the original snapshot");
});

test("a >7-day-old session re-anchors instead of losing its baseline (prune-then-record)", () => {
  const { root } = gitFixture();
  recordBaseline(root, "old1");
  const base = sessionPath(root, "old1", "base");
  const past = (Date.now() - 8 * 86_400_000) / 1000;
  utimesSync(base, past, past);
  // The session-start order: prune first, THEN record — the stale anchor is replaced,
  // never silently deleted after being "preserved".
  pruneSessions(root);
  recordBaseline(root, "old1");
  assert.ok(existsSync(base), "baseline exists after the aged resume");
  assert.ok(Date.now() - statSync(base).mtimeMs < 60_000, "and it is a FRESH anchor");
});
