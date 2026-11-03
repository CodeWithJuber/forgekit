import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/brand.js";
import { load } from "../src/lessons_store.js";
import { TOOLS } from "../src/mcp_tools.js";
import { ORIENT_CREW, ORIENT_TOOLS, orientationBlock } from "../src/orient.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const feed = (mode, payload, env = {}) =>
  spawnSync("node", [ENTRY, mode], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
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

test("session-start on a fresh repo injects only the orientation, as one hook JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-entry-"));
  const r = feed("session-start", { session_id: "s", cwd: root });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout); // a single JSON object — nothing printed around it
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(ctx.trim(), orientationBlock({}).trim(), "nothing but the orientation");
  assert.match(ctx, new RegExp(`${BRAND.brand} is active`));
  assert.doesNotMatch(ctx, /Lessons learned on this repo/);
});

test("FORGE_ORIENT=0 silences the orientation (fresh repo injects nothing)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-entry-"));
  for (const value of ["0", "false", "off", "NO"]) {
    const r = feed("session-start", { session_id: "s", cwd: root }, { FORGE_ORIENT: value });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "", `FORGE_ORIENT=${value}`);
  }
});

test("orientation comes first and the learned lessons still follow it", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-entry-"));
  replaySession(root);
  replaySession(root); // → active lesson exists
  const r = feed("session-start", { session_id: "sess-3", cwd: root });
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith(`## ${BRAND.brand} is active`), "orientation leads the block");
  const lessons = ctx.indexOf("Lessons learned on this repo");
  assert.ok(lessons > ctx.indexOf("hides this block"), "lessons follow the orientation");
  assert.match(ctx, /tax\.ts/);
});

test("orientation names only real MCP tools and shipped crew, within the SessionStart budget", () => {
  const registry = new Set(TOOLS.map((t) => t.name));
  for (const [, names] of ORIENT_TOOLS) for (const n of names) assert.ok(registry.has(n), n);
  const manifest = JSON.parse(
    readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
  );
  const shipped = manifest.agents.map((p) => p.split("/").pop().replace(/\.md$/, ""));
  assert.deepEqual(ORIENT_CREW.map(([name]) => name).sort(), [...shipped].sort());
  const block = orientationBlock({});
  for (const [, names] of ORIENT_TOOLS) for (const n of names) assert.ok(block.includes(n), n);
  const budget = JSON.parse(readFileSync(new URL("../hooks/budget.json", import.meta.url), "utf8"))
    .events.SessionStart;
  assert.ok(Buffer.byteLength(block) <= 1536, `orientation is ${Buffer.byteLength(block)} bytes`);
  assert.ok(Buffer.byteLength(block) < budget);
  assert.equal(orientationBlock({ FORGE_ORIENT: "0" }), "");
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
