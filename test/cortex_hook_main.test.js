import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "../src/lessons_store.js";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const feed = (mode, payload) =>
  spawnSync("node", [ENTRY, mode], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });

const sid = "sess-1";

// Replays one "session" of hook events, then Stop, through the real entrypoint over stdin.
function replaySession(root) {
  const cap = (payload) => feed("capture", { session_id: sid, cwd: root, ...payload });
  cap({ tool_name: "Bash", tool_input: { command: "npm test" }, exitCode: 1 });
  cap({ tool_name: "Edit", tool_input: { file_path: "src/tax.ts" } });
  cap({ tool_name: "Edit", tool_input: { file_path: "src/tax.ts" } });
  cap({ tool_name: "Edit", tool_input: { file_path: "src/tax.ts" } });
  cap({ tool_name: "Bash", tool_input: { command: "npm test" }, exitCode: 0 });
  feed("stop", { session_id: sid, cwd: root });
}

test("entrypoint is fail-safe on garbage input (exit 0, no throw)", () => {
  const r = spawnSync("node", [ENTRY, "capture"], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
});

test("full ambient loop over stdin: capture → stop learns; a recurrence goes active", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-entry-"));
  replaySession(root);
  assert.equal(load(root)[0]?.status, "candidate", "first session distills a candidate");
  replaySession(root);
  assert.equal(load(root)[0]?.status, "active", "the recurrence promotes it");
});

test("session-start injects learned lessons as additionalContext", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-entry-"));
  replaySession(root);
  replaySession(root); // → active lesson exists
  const r = feed("session-start", { session_id: "sess-2", cwd: root });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /Lessons learned on this repo/);
  assert.match(out.hookSpecificOutput.additionalContext, /tax\.ts/);
});

test("session-start on a fresh repo injects nothing (no noise)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-entry-"));
  const r = feed("session-start", { session_id: "s", cwd: root });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("session-start anchors a git baseline and injects state + repo history", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-entry-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  writeFileSync(join(root, "a.js"), "export const one = 1;\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "anchor fixture");
  const r = feed("session-start", { session_id: "anchor-1", cwd: root });
  assert.equal(r.status, 0);
  const base = join(root, ".forge", "sessions", "anchor-1.base");
  assert.ok(existsSync(base), "baseline recorded at session start");
  const sha = readFileSync(base, "utf8").trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  const out = JSON.parse(r.stdout);
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /anchor fixture/,
    "recent commits injected",
  );
  // Re-fired session-start (resume) keeps the anchor even after a new commit.
  writeFileSync(join(root, "a.js"), "export const one = 2;\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "later commit");
  feed("session-start", { session_id: "anchor-1", cwd: root });
  assert.equal(readFileSync(base, "utf8").trim(), sha, "resume never moves the anchor");
});
