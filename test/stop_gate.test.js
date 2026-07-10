import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const GUARD = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "global",
  "guards",
  "completion-gate.sh",
);

const feed = (mode, payload, env = {}) =>
  spawnSync("node", [ENTRY, mode], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-gate-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  writeFileSync(join(root, "a.js"), "export const one = 1;\n");
  writeFileSync(join(root, "README.md"), "# app\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, git };
}

const start = (root, sid) => feed("session-start", { session_id: sid, cwd: root });
const stopGate = (root, sid, extra = {}, env = {}) =>
  feed("stop-gate", { session_id: sid, cwd: root, ...extra }, env);

test("code-only session blocks ONCE with the repair checklist, then the marker allows", () => {
  const { root } = gitFixture();
  start(root, "g1");
  writeFileSync(join(root, "a.js"), "export const one = 2;\n");
  const first = stopGate(root, "g1");
  assert.equal(first.status, 0, "a blocking gate still exits 0 (decision, not crash)");
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /docs sync/, "checklist names the sweep");
  assert.match(out.reason, /handoff/, "checklist names the snapshot");
  assert.match(out.reason, /a\.js/, "the changed code file is cited");
  assert.ok(existsSync(join(root, ".forge", "sessions", "g1.blocked")), "marker set");
  const second = stopGate(root, "g1");
  assert.equal(second.stdout.trim(), "", "block-at-most-once per session");
});

test("stop_hook_active and the kill switch never block", () => {
  const { root } = gitFixture();
  start(root, "g2");
  writeFileSync(join(root, "a.js"), "export const one = 3;\n");
  const looped = stopGate(root, "g2", { stop_hook_active: true });
  assert.equal(looped.stdout.trim(), "", "official loop-protection flag respected");
  const killed = stopGate(root, "g2", {}, { FORGE_STOPGATE: "0" });
  assert.equal(killed.stdout.trim(), "", "FORGE_STOPGATE=0 disables the gate");
});

test("code+doc together, docs-only, and clean sessions all pass silently", () => {
  const { root } = gitFixture();
  start(root, "g3");
  assert.equal(stopGate(root, "g3").stdout.trim(), "", "clean session owes nothing");
  writeFileSync(join(root, "a.js"), "export const one = 4;\n");
  writeFileSync(join(root, "README.md"), "# app\n\nupdated with the change\n");
  assert.equal(stopGate(root, "g3").stdout.trim(), "", "docs moved with the code");
});

test("a handoff (state.md mtime after session start) satisfies the gate", () => {
  const { root } = gitFixture();
  start(root, "g4");
  writeFileSync(join(root, "a.js"), "export const one = 5;\n");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "state.md"), "# Session state\n\n## Done\n- changed a.js\n");
  const r = stopGate(root, "g4");
  assert.equal(r.stdout.trim(), "", "the gitignored snapshot counts via mtime-vs-baseline");
});

test("missing baseline degrades to worktree-only detection and still blocks", () => {
  const { root } = gitFixture();
  // no session-start — hooks installed mid-session
  writeFileSync(join(root, "a.js"), "export const one = 6;\n");
  const r = stopGate(root, "nobase");
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block", "uncommitted code caught without an anchor");
});

test("non-git root and garbage stdin are silent no-ops (fail-open)", () => {
  const bare = mkdtempSync(join(tmpdir(), "forge-gate-"));
  const r = stopGate(bare, "g5");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  const garbage = spawnSync("node", [ENTRY, "stop-gate"], { input: "not json", encoding: "utf8" });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout.trim(), "");
});

test("guard shim: synchronous passthrough of the block decision, always exit 0", () => {
  const { root } = gitFixture();
  start(root, "g6");
  writeFileSync(join(root, "a.js"), "export const one = 7;\n");
  const r = spawnSync("bash", [GUARD], {
    input: JSON.stringify({ session_id: "g6", cwd: root }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, "block", "the shim relays the gate's answer");
  const bare = spawnSync("bash", [GUARD], {
    input: JSON.stringify({ session_id: "x", cwd: mkdtempSync(join(tmpdir(), "forge-gate-")) }),
    encoding: "utf8",
  });
  assert.equal(bare.status, 0);
  assert.equal(bare.stdout.trim(), "");
});

test("both hook manifests register the completion gate under Stop (lockstep)", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const plugin = JSON.parse(readFileSync(join(repo, "hooks", "hooks.json"), "utf8"));
  const template = JSON.parse(readFileSync(join(repo, "global", "settings.template.json"), "utf8"));
  const flat = (m) => (m.hooks.Stop || []).flatMap((e) => e.hooks.map((h) => h.command)).join("\n");
  assert.match(flat(plugin), /completion-gate\.sh/, "plugin manifest wires the gate");
  assert.match(flat(template), /completion-gate\.sh/, "init template wires the gate");
});

test("pre-session dirt is never pinned on the session (review: false-block class)", () => {
  const { root } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 99;\n"); // dirty BEFORE the session
  start(root, "pre1");
  const r = stopGate(root, "pre1"); // session itself did nothing
  assert.equal(r.stdout.trim(), "", "no-op session over a dirty repo passes");
  // But the same session then editing another code file DOES get gated.
  writeFileSync(join(root, "b.js"), "export const two = 2;\n");
  const blocked = stopGate(root, "pre1");
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /b\.js/);
  assert.doesNotMatch(JSON.parse(blocked.stdout).reason, /a\.js/, "pre-existing dirt not cited");
});

test("a branch switch's old commits are not attributed to the session", () => {
  const { root, git } = gitFixture();
  // A feature branch whose commit is an hour old (committer date aged explicitly).
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "old_work.js"), "export const legacy = 1;\n");
  git("add", "-A");
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "old feature work"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: new Date(Date.now() - 3_600_000).toISOString(),
      GIT_AUTHOR_DATE: new Date(Date.now() - 3_600_000).toISOString(),
    },
  });
  git("checkout", "-q", "master");
  start(root, "sw1"); // session starts on master
  git("checkout", "-q", "feature"); // the session merely switches branches
  const r = stopGate(root, "sw1");
  assert.equal(r.stdout.trim(), "", "hour-old commits reached by checkout are not the session's");
});

test("unicode/space doc paths keep their doc credit (-z parsing)", () => {
  const { root, git } = gitFixture();
  start(root, "uni1");
  writeFileSync(join(root, "a.js"), "export const one = 42;\n");
  writeFileSync(join(root, "Änderungen notes.md"), "# änderungen\n\ndocumented the change\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "code + unicode doc");
  const r = stopGate(root, "uni1");
  assert.equal(r.stdout.trim(), "", "the unicode-named doc satisfies the gate");
});

test("missing session_id disables gating (no shared 'default' state)", () => {
  const { root } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 7;\n");
  const r = spawnSync("node", [ENTRY, "stop-gate"], {
    input: JSON.stringify({ cwd: root }), // no session_id
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "unknown identity → no per-session promises → allow");
});

test("unwritable marker → stand down instead of blocking every turn", () => {
  const { root } = gitFixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "sessions"), "a file where a directory must be\n");
  writeFileSync(join(root, "a.js"), "export const one = 8;\n");
  const r = stopGate(root, "ro1");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "block-once cannot be promised → fail open");
});
