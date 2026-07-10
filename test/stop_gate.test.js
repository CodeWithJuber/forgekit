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
