import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordUiCheck } from "../src/gate.js";
import { computeCodeState, signProvenance } from "../src/verify.js";

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

// A `verify` provenance stamp (the exact shape verify.js writes) with an explicit
// mtime offset relative to now, so fresh-vs-stale is deterministic regardless of
// filesystem timestamp granularity. Positive offsetMs = future = after session start.
// `codeState` is captured from the tree AS IT STANDS NOW (HI-02) — the caller writes
// this AFTER its edits, so it matches what the gate recomputes at Stop unless the code
// is changed again afterward. Pass codeState:false to omit it (a pre-HI-02 stamp).
function writeProvenance(root, status, { offsetMs = 5000, codeState = true } = {}) {
  mkdirSync(join(root, ".forge"), { recursive: true });
  const p = join(root, ".forge", "provenance.json");
  const stamp = { tests: { status } };
  if (codeState) stamp.codeState = computeCodeState(root);
  // Signed exactly as `forge verify` signs it (B7) — an UNSIGNED stamp is what an agent can
  // hand-write, and its own test below pins that the gate refuses it.
  writeFileSync(p, JSON.stringify(signProvenance(stamp)));
  const t = new Date(Date.now() + offsetMs);
  utimesSync(p, t, t);
}

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

test("code + docs + test evidence and clean sessions pass silently", () => {
  const { root } = gitFixture();
  start(root, "g3");
  assert.equal(stopGate(root, "g3").stdout.trim(), "", "clean session owes nothing");
  writeFileSync(join(root, "a.js"), "export const one = 4;\n");
  writeFileSync(join(root, "README.md"), "# app\n\nupdated with the change\n");
  writeFileSync(join(root, "a.test.js"), "import './a.js';\n");
  assert.equal(stopGate(root, "g3").stdout.trim(), "", "docs AND a test moved with the code");
});

test("a handoff ALONE no longer satisfies a code change — but with fresh verify PASS it does (RA-10)", () => {
  const { root } = gitFixture();
  start(root, "g4");
  writeFileSync(join(root, "a.js"), "export const one = 5;\n");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "state.md"), "# Session state\n\n## Done\n- changed a.js\n");
  const bare = stopGate(root, "g4");
  const out = JSON.parse(bare.stdout);
  assert.equal(out.decision, "block", "handoff alone is ceremony, not evidence");
  assert.match(out.reason, /test evidence/i, "the reason leads with the missing leg");
  assert.match(out.reason, /verify/, "the checklist names the verify step");
  assert.doesNotMatch(
    out.reason,
    /this alone satisfies the gate\)/,
    "the handoff-suffices claim is gone from code rows",
  );
  // Same session shape, fresh evidence: state touch (docs leg) + fresh verify PASS passes.
  const { root: root2 } = gitFixture();
  start(root2, "g4b");
  writeFileSync(join(root2, "a.js"), "export const one = 5;\n");
  writeFileSync(join(root2, ".forge", "state.md"), "# Session state\n\n## Done\n- changed a.js\n");
  writeProvenance(root2, "PASS");
  const r = stopGate(root2, "g4b");
  assert.equal(
    r.stdout.trim(),
    "",
    "the gitignored snapshot still counts as the docs leg once test evidence exists",
  );
});

test("stale or failing verify provenance is NOT evidence; unreadable provenance fails toward block-once (RA-10)", () => {
  // Stale stamp (mtime before session start) → block on first stop.
  const { root } = gitFixture();
  start(root, "pv1");
  writeFileSync(join(root, "a.js"), "export const one = 51;\n");
  writeFileSync(join(root, ".forge", "state.md"), "# state\n");
  writeProvenance(root, "PASS", { offsetMs: -3_600_000 }); // an hour-old run
  const stale = stopGate(root, "pv1");
  assert.equal(JSON.parse(stale.stdout).decision, "block", "stale PASS proves nothing");

  // Fresh but FAIL → block.
  const { root: rootF } = gitFixture();
  start(rootF, "pv2");
  writeFileSync(join(rootF, "a.js"), "export const one = 52;\n");
  writeFileSync(join(rootF, ".forge", "state.md"), "# state\n");
  writeProvenance(rootF, "FAIL");
  assert.equal(JSON.parse(stopGate(rootF, "pv2").stdout).decision, "block");

  // Unreadable provenance → treated as absent → block once, second stop proceeds.
  const { root: rootU } = gitFixture();
  start(rootU, "pv3");
  writeFileSync(join(rootU, "a.js"), "export const one = 53;\n");
  writeFileSync(join(rootU, ".forge", "state.md"), "# state\n");
  mkdirSync(join(rootU, ".forge"), { recursive: true });
  writeFileSync(join(rootU, ".forge", "provenance.json"), "not json{");
  utimesSync(
    join(rootU, ".forge", "provenance.json"),
    new Date(Date.now() + 5000),
    new Date(Date.now() + 5000),
  );
  const first = stopGate(rootU, "pv3");
  assert.equal(JSON.parse(first.stdout).decision, "block", "corrupt stamp → no evidence");
  const second = stopGate(rootU, "pv3");
  assert.equal(second.stdout.trim(), "", "block-once marker: second stop always proceeds");
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
  const garbage = spawnSync("node", [ENTRY, "stop-gate"], {
    input: "not json",
    encoding: "utf8",
  });
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
    input: JSON.stringify({
      session_id: "x",
      cwd: mkdtempSync(join(tmpdir(), "forge-gate-")),
    }),
    encoding: "utf8",
  });
  assert.equal(bare.status, 0);
  assert.equal(bare.stdout.trim(), "");
});

test("both hook manifests register the completion gate under Stop (lockstep)", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const plugin = JSON.parse(readFileSync(join(repo, "hooks", "hooks.json"), "utf8"));
  const template = JSON.parse(readFileSync(join(repo, "global", "settings.template.json"), "utf8"));
  const flat = (m) =>
    (m.hooks.Stop || [])
      .flatMap((e) => e.hooks.map((h) => [h.command, ...(h.args ?? [])].join(" ")))
      .join("\n");
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

test("HI-03: a pre-dirty file edited AGAIN during the session is seen as a change", () => {
  const { root } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 100;\n"); // dirty BEFORE the session
  start(root, "hi3");
  // The agent further edits the already-dirty file — a path-only baseline would hide this.
  writeFileSync(join(root, "a.js"), "export const one = 200;\n");
  const r = stopGate(root, "hi3");
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block", "a further edit to a pre-dirty file is not hidden");
  assert.match(out.reason, /a\.js/, "the re-edited pre-dirty file is cited");
});

test("HI-02: a verify PASS goes stale once code changes after it (dirtyHash mismatch → block)", () => {
  const { root } = gitFixture();
  start(root, "hi2a");
  writeFileSync(join(root, "a.js"), "export const one = 21;\n");
  writeFileSync(join(root, ".forge", "state.md"), "# state\n"); // docs leg present
  writeProvenance(root, "PASS"); // codeState captured with a.js = 21
  // ...then the agent edits code AGAIN — the stamp no longer describes the FINAL tree.
  writeFileSync(join(root, "a.js"), "export const one = 22;\n");
  const r = stopGate(root, "hi2a");
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block", "stale verify evidence (code moved after it) does not count");
  assert.match(out.reason, /test evidence/i);
});

test("HI-02: a stale PASS is caught even when the pending diff exceeds 1 MiB (B3)", () => {
  // computeCodeState read `git diff HEAD` with the 1 MiB default buffer: past it the diff
  // hashed as "", so every state with a big pending change looked identical and the stale
  // PASS survived a post-verify edit.
  const { root, git } = gitFixture();
  writeFileSync(join(root, "data.txt"), "seed\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "data");
  start(root, "b3big");
  let big = "";
  for (let i = 0; i < 40000; i++) big += `row ${i} lorem ipsum dolor sit amet\n`;
  writeFileSync(join(root, "data.txt"), big); // ~1.5 MB tracked diff
  writeFileSync(join(root, "a.js"), "export const one = 24;\n");
  writeFileSync(join(root, ".forge", "state.md"), "# state\n");
  writeProvenance(root, "PASS");
  writeFileSync(join(root, "a.js"), "export const one = () => { throw new Error('x'); };\n");
  const out = JSON.parse(stopGate(root, "b3big").stdout || "{}");
  assert.equal(out.decision, "block", "the edit after verify must invalidate the stamp");
  assert.notEqual(computeCodeState(root).dirtyHash, null, "a big diff still binds");
});

test("HI-02: a verify PASS bound to the FINAL code state + handoff → allow", () => {
  const { root } = gitFixture();
  start(root, "hi2b");
  writeFileSync(join(root, "a.js"), "export const one = 23;\n");
  writeFileSync(join(root, ".forge", "state.md"), "# state\n"); // docs leg
  writeProvenance(root, "PASS"); // codeState matches the tree; nothing changes afterward
  const r = stopGate(root, "hi2b");
  assert.equal(r.stdout.trim(), "", "a fresh verify matching the final code state passes");
});

test("HI-04: a deleted test file is not positive evidence for a code change", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.test.js"), "import './a.js';\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "add test");
  start(root, "hi4a");
  writeFileSync(join(root, "a.js"), "export const one = 41;\n"); // code change
  writeFileSync(join(root, "README.md"), "# app\n\ndocumented\n"); // docs leg
  rmSync(join(root, "a.test.js")); // the only "test" signal is a DELETION
  const r = stopGate(root, "hi4a");
  assert.equal(
    JSON.parse(r.stdout).decision,
    "block",
    "a deleted test proves nothing about the code change",
  );
});

test("HI-04: an empty new test file is not positive evidence", () => {
  const { root } = gitFixture();
  start(root, "hi4b");
  writeFileSync(join(root, "a.js"), "export const one = 42;\n");
  writeFileSync(join(root, "README.md"), "# app\n\ndocumented\n");
  writeFileSync(join(root, "a.test.js"), ""); // empty file — an obligation signal, not proof
  const r = stopGate(root, "hi4b");
  assert.equal(
    JSON.parse(r.stdout).decision,
    "block",
    "an empty test file does not satisfy the test leg",
  );
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
  writeProvenance(root, "PASS"); // test-evidence leg, so the doc leg is what's under test
  const r = stopGate(root, "uni1");
  assert.equal(r.stdout.trim(), "", "the unicode-named doc satisfies the docs leg");
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

// ── B7: the evidence the gate trusts lives in files the agent can write. Both are now MAC'd
// with a machine-local key kept outside the repo, so a hand-written one is not evidence.
test("B7: a hand-written provenance stamp is not test evidence", () => {
  const { root } = gitFixture();
  start(root, "b7a");
  writeFileSync(join(root, "a.js"), "export const one = 71;\n");
  writeFileSync(join(root, ".forge", "state.md"), "# state\n"); // docs leg present
  // Exactly what an agent can produce on its own: the right shape, the right code state,
  // no MAC (forge verify never ran).
  const forged = { tests: { status: "PASS" }, codeState: computeCodeState(root) };
  const p = join(root, ".forge", "provenance.json");
  writeFileSync(p, JSON.stringify(forged));
  const t = new Date(Date.now() + 5000);
  utimesSync(p, t, t);
  const out = JSON.parse(stopGate(root, "b7a").stdout || "{}");
  assert.equal(out.decision, "block", "an unsigned stamp does not satisfy the strong leg");

  // …and the same stamp, signed the way `forge verify` signs it, passes. (A fresh repo and
  // session: the first gate call above already spent this session's block-once marker.)
  const second = gitFixture().root;
  start(second, "b7a2");
  writeFileSync(join(second, "a.js"), "export const one = 71;\n");
  writeFileSync(join(second, ".forge", "state.md"), "# state\n");
  const signed = signProvenance({ tests: { status: "PASS" }, codeState: computeCodeState(second) });
  const p2 = join(second, ".forge", "provenance.json");
  writeFileSync(p2, JSON.stringify(signed));
  utimesSync(p2, t, t);
  assert.equal(
    stopGate(second, "b7a2").stdout.trim(),
    "",
    "a signed, code-state-bound PASS passes",
  );
});

test("B7: a pre-written block-once marker does not switch the gate off", () => {
  const { root } = gitFixture();
  start(root, "b7b");
  writeFileSync(join(root, "a.js"), "export const one = 72;\n");
  // The agent drops the marker in before stopping — the gate used to read it as
  // "already blocked once" and wave the session through.
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  writeFileSync(join(root, ".forge", "sessions", "b7b.blocked"), `${new Date().toISOString()}\n`);
  const out = JSON.parse(stopGate(root, "b7b").stdout || "{}");
  assert.equal(out.decision, "block", "a forged marker is ignored");
  // The gate's OWN marker (written by that block) still ends the loop at the next stop.
  assert.equal(stopGate(root, "b7b").stdout.trim(), "", "block once, then proceed");
});

test("B7: a comment-only touch to a test file is not test evidence", () => {
  const { root, git } = gitFixture();
  writeFileSync(
    join(root, "a.test.js"),
    "import { test } from 'node:test';\ntest('x', () => {});\n",
  );
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "add test");
  start(root, "b7c");
  writeFileSync(join(root, "a.js"), "export const one = 73;\n"); // code changed
  writeFileSync(join(root, "README.md"), "# app\n\ndocumented\n"); // docs leg
  appendFileSync(join(root, "a.test.js"), "// touched\n"); // a comment, not a test
  const out = JSON.parse(stopGate(root, "b7c").stdout || "{}");
  assert.equal(out.decision, "block", "a comment line is not a test");
  // A real added assertion IS evidence.
  appendFileSync(join(root, "a.test.js"), "test('two', () => {});\n");
  assert.equal(stopGate(root, "b7c2").stdout.trim(), "", "real added test code counts");
});

// ── UI-only changes (review: a className tweak in .tsx was blocked for unit tests) ─────────

const HERO_BEFORE = 'export const Hero = () => <h1 className="text-xl">Hi</h1>;\n';
const HERO_STYLED = 'export const Hero = () => <h1 className="text-2xl font-semibold">Hi</h1>;\n';
const HERO_LOGIC =
  'export const Hero = () => <h1 className="text-xl" onClick={() => track()}>Hi</h1>;\n';

// A repo with a committed component, and the PostToolUse capture the real hooks send.
function uiFixture() {
  const fx = gitFixture();
  mkdirSync(join(fx.root, "src"), { recursive: true });
  writeFileSync(join(fx.root, "src", "Hero.tsx"), HERO_BEFORE);
  fx.git("add", "-A");
  fx.git("-c", "commit.gpgsign=false", "commit", "-qm", "hero");
  return fx;
}
const capture = (root, sid, payload) =>
  feed("capture", { session_id: sid, cwd: root, hook_event_name: "PostToolUse", ...payload });
// The session writes a file through its Write tool: the bytes land, then the capture fires.
function write(root, sid, rel, text) {
  writeFileSync(join(root, rel), text);
  capture(root, sid, { tool_name: "Write", tool_input: { file_path: join(root, rel) } });
}

test("UI-only: a className-only .tsx edit + a design doc passes (no unit test owed)", () => {
  const { root } = uiFixture();
  start(root, "ui1");
  write(root, "ui1", "src/Hero.tsx", HERO_STYLED);
  write(root, "ui1", "DESIGN.md", "# Design\n\nHero heading is text-2xl.\n");
  assert.equal(stopGate(root, "ui1").stdout.trim(), "", "a UI change with its design record");
});

test("UI-only: alone it blocks once with the UI checklist, not the unit-test one", () => {
  const { root } = uiFixture();
  start(root, "ui2");
  write(root, "ui2", "src/Hero.tsx", HERO_STYLED);
  const out = JSON.parse(stopGate(root, "ui2").stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /UI-only change/);
  assert.match(out.reason, /Changed UI: src\/Hero\.tsx/);
  assert.match(out.reason, /uicheck design/);
  assert.doesNotMatch(out.reason, /NO test evidence/, "no unit test is demanded");
  assert.equal(stopGate(root, "ui2").stdout.trim(), "", "block-once still holds");
});

test("UI-only: a fresh uicheck PASS or a passing e2e run covers it; a stale one does not", () => {
  // uicheck stamp written after the final edit (what `forge uicheck design` does).
  const t = new Date(Date.now() + 5000);
  const a = uiFixture().root;
  start(a, "ui3");
  write(a, "ui3", "src/Hero.tsx", HERO_STYLED);
  assert.equal(recordUiCheck(a, { check: "design", pass: true, files: ["src/Hero.tsx"] }), true);
  utimesSync(join(a, ".forge", "uicheck.json"), t, t);
  assert.equal(stopGate(a, "ui3").stdout.trim(), "", "a fresh, signed uicheck PASS");

  // A design check of some OTHER file proves nothing about this change.
  const other = uiFixture().root;
  start(other, "ui3b");
  write(other, "ui3b", "src/Hero.tsx", HERO_STYLED);
  recordUiCheck(other, { check: "design", pass: true, files: ["src/Unrelated.tsx"] });
  utimesSync(join(other, ".forge", "uicheck.json"), t, t);
  assert.equal(JSON.parse(stopGate(other, "ui3b").stdout).decision, "block", "wrong files");

  // A visual check renders the page: it covers the UI change.
  const vis = uiFixture().root;
  start(vis, "ui3c");
  write(vis, "ui3c", "src/Hero.tsx", HERO_STYLED);
  recordUiCheck(vis, { check: "visual", pass: true });
  utimesSync(join(vis, ".forge", "uicheck.json"), t, t);
  assert.equal(stopGate(vis, "ui3c").stdout.trim(), "", "a fresh visual PASS");

  // A passing e2e run after the final edit, recorded by the capture hook.
  const b = uiFixture().root;
  start(b, "ui4");
  write(b, "ui4", "src/Hero.tsx", HERO_STYLED);
  capture(b, "ui4", { tool_name: "Bash", tool_input: { command: "npm run e2e" } });
  assert.equal(stopGate(b, "ui4").stdout.trim(), "", "a passing e2e run bound to this code");

  // The same run BEFORE another edit is stale.
  const c = uiFixture().root;
  start(c, "ui5");
  write(c, "ui5", "src/Hero.tsx", HERO_STYLED);
  capture(c, "ui5", { tool_name: "Bash", tool_input: { command: "npm run e2e" } });
  write(c, "ui5", "src/Hero.tsx", HERO_STYLED.replace("text-2xl", "text-3xl"));
  assert.equal(JSON.parse(stopGate(c, "ui5").stdout).decision, "block", "stale e2e run");
});

test("UI-only: a logic edit to the same .tsx is still gated as code", () => {
  const { root } = uiFixture();
  start(root, "ui6");
  write(root, "ui6", "src/Hero.tsx", HERO_LOGIC);
  write(root, "ui6", "DESIGN.md", "# Design\n\nHero tracks clicks.\n");
  const out = JSON.parse(stopGate(root, "ui6").stdout);
  assert.equal(out.decision, "block", "a new handler is logic, not presentation");
  assert.match(out.reason, /NO test evidence/);
  assert.match(out.reason, /Changed code: src\/Hero\.tsx/);
});

test("UI-only: a stylesheet now owes the same as a className edit (a handoff covers it)", () => {
  const { root } = uiFixture();
  start(root, "ui7");
  write(root, "ui7", "src/app.css", ".hero { font-size: 2rem; }\n");
  assert.equal(JSON.parse(stopGate(root, "ui7").stdout).decision, "block");
  const r2 = uiFixture().root;
  start(r2, "ui8");
  write(r2, "ui8", "src/app.css", ".hero { font-size: 2rem; }\n");
  writeFileSync(join(r2, ".forge", "state.md"), "# state\n\n- restyled the hero\n");
  assert.equal(stopGate(r2, "ui8").stdout.trim(), "", "handoff alone satisfies a UI-only change");
});

// ── Multi-agent checkouts (review: the gate blamed a session for other agents' edits) ──────

test("concurrency: another agent's concurrent edit is not blamed on this session", () => {
  const { root } = gitFixture();
  start(root, "ma1");
  write(root, "ma1", "README.md", "# app\n\nma1 documented something\n");
  writeFileSync(join(root, "a.js"), "export const one = 2; // another agent\n");
  assert.equal(stopGate(root, "ma1").stdout.trim(), "", "only README.md is this session's");
});

test("concurrency: this session's own code is still gated, and the other file is named, not blamed", () => {
  const { root } = gitFixture();
  start(root, "ma2");
  write(root, "ma2", "a.js", "export const one = 3;\n");
  writeFileSync(join(root, "b.js"), "export const two = 2; // another agent\n");
  const out = JSON.parse(stopGate(root, "ma2").stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Changed code: a\.js\n/, "only this session's file is cited");
  assert.doesNotMatch(out.reason, /Changed code:.*b\.js/);
  assert.match(out.reason, /1 other changed file\(s\).*another agent/);
});

test("concurrency: another agent's COMMIT mid-session is not this session's either", () => {
  const { root, git } = gitFixture();
  start(root, "ma3");
  capture(root, "ma3", { tool_name: "Bash", tool_input: { command: "git status" } });
  writeFileSync(join(root, "a.js"), "export const one = 4;\n");
  git("add", "a.js");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "another agent's commit");
  assert.equal(stopGate(root, "ma3").stdout.trim(), "", "a commit this session never touched");
});

test("concurrency: a file a Bash command named is attributed to the session", () => {
  const { root } = gitFixture();
  start(root, "ma4");
  writeFileSync(join(root, "a.js"), "export const one = 5;\n");
  capture(root, "ma4", {
    tool_name: "Bash",
    tool_input: { command: `sed -i 's/4/5/' ${join(root, "a.js")}` },
  });
  const out = JSON.parse(stopGate(root, "ma4").stdout);
  assert.equal(out.decision, "block", "a sed -i edit is this session's change");
  assert.match(out.reason, /a\.js/);
});

test("concurrency fallback: no trail (or a trail with no tool call) keeps the tree-wide view", () => {
  // Trail deleted (hooks upgraded mid-session): today's behaviour, the tree decides.
  const { root } = gitFixture();
  start(root, "fb1");
  capture(root, "fb1", { tool_name: "Bash", tool_input: { command: "git status" } });
  rmSync(join(root, ".forge", "sessions", "fb1.trail"));
  writeFileSync(join(root, "a.js"), "export const one = 6;\n");
  assert.equal(JSON.parse(stopGate(root, "fb1").stdout).decision, "block", "no log → fallback");
  // Trail opened but no tool call captured: capture may not be live, so nothing is narrowed.
  const r2 = gitFixture().root;
  start(r2, "fb2");
  writeFileSync(join(r2, "a.js"), "export const one = 7;\n");
  assert.equal(JSON.parse(stopGate(r2, "fb2").stdout).decision, "block", "no activity → fallback");
});
