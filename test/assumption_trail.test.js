// Wave: recorded assumptions + CUSUM drift — the evidence trail between "the advisory
// said something" and "the session actually recorded it for the gate and the handoff".
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setGoal } from "../src/goal.js";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const feed = (mode, payload) =>
  spawnSync("node", [ENTRY, mode], { input: JSON.stringify(payload), encoding: "utf8" });

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-trail-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "tax.js"), "export function computeTax(x){ return x*0.2 }\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, git };
}

const events = (root, sid) =>
  readFileSync(join(root, ".forge", "sessions", `${sid}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("preflight records a drift score per prompt once a goal is anchored", () => {
  const { root } = gitFixture();
  setGoal(root, "improve tax calculation accuracy");
  writeFileSync(join(root, "src", "unrelated.js"), "export const x = 1;\n");
  feed("preflight", { session_id: "t1", cwd: root, prompt: "tweak the logging colors" });
  const drift = events(root, "t1").filter((e) => e.type === "drift");
  assert.equal(drift.length, 1, "one drift observation per prompt");
  assert.ok(drift[0].score > 0, "off-goal change scored above zero");
});

test("proceeding under assumptions is RECORDED and named in the advisory", () => {
  const { root } = gitFixture();
  const prompt = "refactor src/tax.js keeping behavior, verify with the test suite";
  const r = feed("preflight", { session_id: "t2", cwd: root, prompt });
  const recorded = events(root, "t2").filter((e) => e.type === "assumption");
  assert.equal(recorded.length, 1, "assumption event persisted for the handoff");
  assert.ok(recorded[0].missing.includes("constraints"), JSON.stringify(recorded[0]));
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Proceeding without asking under 1 recorded assumption/, ctx);
});

test("sustained drift (CUSUM alarm) is named in the completion-gate block reason", () => {
  const { root } = gitFixture();
  feed("session-start", { session_id: "t3", cwd: root });
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  for (let i = 0; i < 4; i += 1)
    appendFileSync(
      join(root, ".forge", "sessions", "t3.jsonl"),
      `${JSON.stringify({ type: "drift", score: 1 })}\n`,
    );
  writeFileSync(join(root, "src", "tax.js"), "export function computeTax(x){ return x*0.21 }\n");
  const r = feed("stop-gate", { session_id: "t3", cwd: root });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /CUSUM/, "drift alarm rides the repair checklist");
  assert.match(out.reason, /anchor/, "and points back at the goal");
});

test("a session with no goal and no assumptions records nothing extra", () => {
  const { root } = gitFixture();
  feed("preflight", {
    session_id: "t4",
    cwd: root,
    prompt: "update computeTax in src/tax.js to round half up",
  });
  let evts = [];
  try {
    evts = events(root, "t4");
  } catch {}
  assert.equal(evts.filter((e) => e.type === "drift").length, 0, "no goal → no drift series");
  assert.equal(
    evts.filter((e) => e.type === "assumption").length,
    0,
    "fully specified → no record",
  );
});
