import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { sessionPath } from "../src/cortex_hook.js";
import {
  attributeChanges,
  changedSet,
  commandPaths,
  currentSessionId,
  openTrail,
  pruneSessions,
  readBaseline,
  readDirtySnapshot,
  readTrail,
  recordBaseline,
  recordTrail,
  rehydrationBlock,
  sessionChanges,
  trailEntry,
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

// ── The session trail: what THIS session touched, for multi-agent checkouts ──────────────

test("commandPaths: the file paths a shell command names, heredoc bodies skipped", () => {
  assert.deepEqual(commandPaths("sed -i 's/a/b/' src/a.tsx && git add src/b.ts"), [
    "src/a.tsx",
    "src/b.ts",
  ]);
  // Over-inclusive by design (a stray token matches no changed file), but never a directory.
  assert.deepEqual(commandPaths("rm -rf dist/ && touch dist/x.js"), ["dist/x.js"]);
  assert.deepEqual(
    commandPaths("cat > /repo/src/c.css <<'EOF'\nimport x from './not/a/target.js'\nEOF\nls"),
    ["/repo/src/c.css"],
    "a heredoc body is file content, not arguments",
  );
  assert.deepEqual(commandPaths("prettier --write --config=.prettierrc.json x.md"), [
    ".prettierrc.json",
    "x.md",
  ]);
  assert.deepEqual(
    commandPaths("npm test; git status; curl https://example.com/a.js; echo $HOME/x.js; ls ."),
    [],
    "bare commands, URLs, variables and `.` name no file",
  );
  // Review: a path after `cd dir` lives under dir; a glob is kept as a pattern.
  assert.deepEqual(commandPaths("cd src && sed -i 's/1/42/' a.js"), ["src/a.js"]);
  assert.deepEqual(commandPaths("cd /abs/app && touch x.js; cd - && touch y.js"), [
    "/abs/app/x.js",
    "y.js",
  ]);
  assert.deepEqual(commandPaths("sed -i 's/1/42/' src/*.js lib/**/x.ts"), [
    "src/*.js",
    "lib/**/x.ts",
  ]);
});

test("trailEntry: edit targets, Bash paths, and only SUCCESSFUL unmasked e2e runs", () => {
  assert.deepEqual(
    trailEntry({ tool_name: "Write", tool_input: { file_path: "src/a.ts" } }, "/r"),
    {
      k: "edit",
      p: resolve("/r", "src/a.ts"),
    },
  );
  assert.deepEqual(
    trailEntry({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/abs/n.ipynb" } }, "/r"),
    { k: "edit", p: resolve("/abs/n.ipynb") },
  );
  assert.deepEqual(
    trailEntry({ tool_name: "Read", tool_input: { file_path: "a" } }, "/r"),
    { k: "tool" },
    "any other tool proves capture is live, but names no changed file",
  );
  assert.equal(trailEntry({ tool_input: {} }, "/r"), null, "no tool, no entry");
  const bash = (command, extra = {}) =>
    trailEntry(
      { tool_name: "Bash", tool_input: { command }, hook_event_name: "PostToolUse", ...extra },
      "/r",
    );
  assert.deepEqual(bash("git status"), { k: "bash", p: [] }, "any Bash call is activity");
  assert.equal(bash("npm run e2e").e2e, true, "PostToolUse fires only for a successful call");
  assert.equal(bash("npx playwright test e2e/home.spec.ts").e2e, true);
  assert.equal(bash("npm run e2e", { exitCode: 1 }).e2e, undefined, "an explicit failure");
  assert.equal(bash("npm run e2e | tail -5").e2e, undefined, "a pipe masks the exit code");
  assert.equal(bash("npm run e2e || true").e2e, undefined);
  assert.equal(
    bash("npm run e2e", { tool_input: { command: "npm run e2e", run_in_background: true } }).e2e,
    undefined,
    "a backgrounded run has no verdict yet",
  );
  assert.equal(
    trailEntry({ tool_name: "Bash", tool_input: { command: "npm run e2e" } }, "/r").e2e,
    undefined,
    "no event name and no exit code: success unknown",
  );
  // Review: a masked run exits 0 whatever the suite did — PostToolUse fires, it is no evidence.
  assert.equal(bash('npm run e2e; echo "exit=$?"').e2e, undefined);
  assert.equal(bash("npm run e2e > out.log 2>&1; cat out.log").e2e, undefined);
  assert.equal(bash("npx playwright test --list").e2e, undefined);
  // Claude Code's documented shapes: Bash `tool_response` {stdout, stderr, interrupted,
  // isImage} on PostToolUse; `error` ("Exit code N …") + `is_interrupt` on PostToolUseFailure.
  const ok = { stdout: "3 passed", stderr: "", interrupted: false, isImage: false };
  assert.equal(bash("npm run e2e", { tool_response: ok }).e2e, true);
  assert.equal(
    bash("npm run e2e", { tool_response: { ...ok, interrupted: true } }).e2e,
    undefined,
    "an interrupted run",
  );
  assert.equal(
    bash("npm run e2e", {
      hook_event_name: "PostToolUseFailure",
      error: "Exit code 1\n2 failed",
      is_interrupt: false,
    }).e2e,
    undefined,
    "a failed run",
  );
  assert.equal(bash("npm run e2e", { exitCode: 0 }).e2e, true, "an explicit exit code of 0");
});

test("openTrail/recordTrail/readTrail: authoritative only when opened at start and used", () => {
  const { root } = gitFixture();
  assert.equal(readTrail(root, "t1"), null, "no trail yet");
  const edit = { tool_name: "Edit", tool_input: { file_path: join(root, "a.js") }, cwd: root };
  assert.equal(
    recordTrail(root, "t1", edit),
    null,
    "a trail SessionStart never opened is not written",
  );
  assert.equal(existsSync(sessionPath(root, "t1", "trail")), false);
  assert.equal(openTrail(root, "t1"), true);
  assert.equal(openTrail(root, "t1"), false, "a resume keeps the trail");
  const startRecord = JSON.parse(readFileSync(sessionPath(root, "t1", "trail"), "utf8"));
  assert.equal(startRecord.sid, "t1", "the start record names its session");
  assert.equal(readTrail(root, "t1")?.authoritative, false, "start record only: no activity yet");
  recordTrail(root, "t1", edit);
  const trail = readTrail(root, "t1");
  assert.equal(trail?.authoritative, true);
  assert.ok(trail?.paths.has(join(root, "a.js")));
  // A start record the agent wrote itself carries no valid MAC.
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  writeFileSync(
    sessionPath(root, "forged", "trail"),
    `${JSON.stringify({ k: "start", t: 1 })}\n${JSON.stringify({ k: "bash", p: [] })}\n`,
  );
  assert.equal(
    readTrail(root, "forged")?.authoritative,
    false,
    "unsigned start: not authoritative",
  );
  appendFileSync(sessionPath(root, "t1", "trail"), "not json{\n");
  assert.equal(readTrail(root, "t1")?.authoritative, true, "a torn line loses nothing");
});

test("recordTrail: a passing e2e run is stored bound to the code state, MAC'd", () => {
  const { root } = gitFixture();
  openTrail(root, "t2");
  writeFileSync(join(root, "a.js"), "export const one = 2;\n");
  recordTrail(root, "t2", {
    tool_name: "Bash",
    tool_input: { command: "npm run e2e" },
    hook_event_name: "PostToolUse",
    cwd: root,
  });
  const [run] = readTrail(root, "t2")?.e2e ?? [];
  assert.equal(typeof run?.code, "string", "bound to the tree it ran against");
  assert.match(String(run?.mac), /^[0-9a-f]{64}$/);
});

test("recordTrail: a hook running from a subdirectory writes the trail at the toplevel", () => {
  const { root } = gitFixture();
  openTrail(root, "sub");
  mkdirSync(join(root, "src"));
  const hook = {
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "x.js") },
    cwd: join(root, "src"),
  };
  assert.deepEqual(recordTrail(join(root, "src"), "sub", hook), {
    k: "edit",
    p: join(root, "src", "x.js"),
  });
  assert.equal(existsSync(join(root, "src", ".forge")), false, "no stray trail in the subdir");
  assert.ok(readTrail(root, "sub")?.paths.has(join(root, "src", "x.js")));
});

// A session's tool call, as the capture hook records it.
const wrote = (root, sid, rel) =>
  recordTrail(root, sid, {
    tool_name: "Write",
    tool_input: { file_path: join(root, rel) },
    cwd: root,
  });
const ran = (root, sid, command) =>
  recordTrail(root, sid, { tool_name: "Bash", tool_input: { command }, cwd: root });

test("attributeChanges: a file is another agent's only when that agent's trail claims it", () => {
  const { root } = gitFixture();
  const since = Date.now() - 10_000;
  for (const f of ["a.js", "b.js", "c.js", "d.js"]) writeFileSync(join(root, f), `// ${f}\n`);
  const all = changedSet(root, null);
  assert.deepEqual(all, ["a.js", "b.js", "c.js", "d.js"]);
  assert.deepEqual(
    attributeChanges(root, "me", all, { sinceMs: since }),
    { mine: all, others: [], attributed: false },
    "no trail: the tree-wide view",
  );
  openTrail(root, "me");
  wrote(root, "me", "a.js");
  ran(root, "me", "sed -i 's/x/y/' c.*"); // a glob this session's trail keeps as a pattern
  assert.deepEqual(
    attributeChanges(root, "me", all, { sinceMs: since }).others,
    [],
    "nobody else claims anything: every change stays with this session",
  );
  openTrail(root, "them");
  wrote(root, "them", "a.js"); // both touched it
  wrote(root, "them", "b.js"); // only they did
  wrote(root, "them", "c.js"); // this session's glob covers it
  const r = attributeChanges(root, "me", all, { sinceMs: since });
  assert.deepEqual(r.others, ["b.js"], "set aside: claimed by them, not named by me");
  assert.deepEqual(r.mine, ["a.js", "c.js", "d.js"], "d.js: no trail saw it, so it stays mine");
  assert.equal(r.attributed, true);
  // Their trail is only evidence while it is live: one last written before this session
  // started proves nothing about what changed since.
  const old = new Date(since - 60_000);
  utimesSync(sessionPath(root, "them", "trail"), old, old);
  assert.deepEqual(attributeChanges(root, "me", all, { sinceMs: since }).others, []);
});

test("attributeChanges: a forged or copied trail claims nothing", () => {
  const { root } = gitFixture();
  const since = Date.now() - 10_000;
  writeFileSync(join(root, "b.js"), "// b\n");
  const all = changedSet(root, null);
  openTrail(root, "me");
  ran(root, "me", "git status");
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  const claim = `${JSON.stringify({ k: "edit", p: join(root, "b.js") })}\n`;
  writeFileSync(
    sessionPath(root, "forged", "trail"),
    `${JSON.stringify({ k: "start", t: 1, sid: "forged", mac: "0".repeat(64) })}\n${claim}`,
  );
  assert.deepEqual(attributeChanges(root, "me", all, { sinceMs: since }).others, [], "bad MAC");
  // A real, signed trail copied under another session's name.
  openTrail(root, "real");
  wrote(root, "real", "b.js");
  writeFileSync(
    sessionPath(root, "copy", "trail"),
    readFileSync(sessionPath(root, "real", "trail"), "utf8"),
  );
  rmSync(sessionPath(root, "real", "trail"));
  assert.deepEqual(
    attributeChanges(root, "me", all, { sinceMs: since }).others,
    [],
    "the start record names another session",
  );
});

test("currentSessionId: FORGE_SESSION_ID, else CLAUDE_CODE_SESSION_ID, else null", () => {
  assert.equal(currentSessionId({ FORGE_SESSION_ID: "f", CLAUDE_CODE_SESSION_ID: "c" }), "f");
  assert.equal(currentSessionId({ CLAUDE_CODE_SESSION_ID: "c" }), "c");
  assert.equal(currentSessionId({}), null);
});

test("sessionChanges: pre-session dirt and other agents' edits are not this session's", () => {
  const { root } = gitFixture();
  writeFileSync(join(root, "old.js"), "dirty before the session\n");
  assert.equal(sessionChanges(root, "s9"), null, "no baseline → unscoped (caller's whole view)");
  assert.equal(sessionChanges(root, null), null);
  recordBaseline(root, "s9");
  writeFileSync(join(root, "mine.js"), "export const m = 1;\n");
  writeFileSync(join(root, "theirs.js"), "export const t = 1;\n");
  // No trail: baseline-scoped (the pre-session dirt is gone), other agents still in.
  assert.deepEqual(sessionChanges(root, "s9"), {
    base: readBaseline(root, "s9")?.head ?? null,
    changed: ["mine.js", "theirs.js"],
    attributed: false,
  });
  openTrail(root, "s9");
  wrote(root, "s9", "mine.js");
  openTrail(root, "other");
  wrote(root, "other", "theirs.js");
  const scoped = sessionChanges(root, "s9");
  assert.deepEqual(scoped?.changed, ["mine.js"], "the other session's trail claims theirs.js");
  assert.equal(scoped?.attributed, true);
  unlinkSync(sessionPath(root, "s9", "trail"));
  assert.deepEqual(
    sessionChanges(root, "s9")?.changed,
    ["mine.js", "theirs.js"],
    "no log → fallback",
  );
});
