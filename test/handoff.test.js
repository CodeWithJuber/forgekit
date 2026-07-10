import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gatherGitFacts, readState, stateBlock, statePath, writeState } from "../src/handoff.js";
import { fakeAnthropic } from "./_fixtures.js";

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  writeFileSync(join(root, "a.js"), "export const one = 1;\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return root;
}

test("writeState produces every section, bounded, and rewrites (never appends)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  const r = writeState(root, { done: ["built the gate"], next: ["wire manifests"] });
  assert.equal(r.ok, true);
  const text = readFileSync(statePath(root), "utf8");
  for (const s of [
    "Goal / Phase",
    "Acceptance criteria",
    "Done this session",
    "Next steps",
    "Gotchas",
    "Open assumptions",
    "In-progress files",
    "Decisions",
  ])
    assert.match(text, new RegExp(`## ${s}`), `section ${s} present`);
  assert.match(text, /built the gate/);
  // Second write REPLACES the first — bounded snapshot, not a growing log.
  writeState(root, { done: ["second session"] });
  const after = readFileSync(statePath(root), "utf8");
  assert.doesNotMatch(after, /built the gate/, "old rows do not accumulate");
  assert.match(after, /second session/);
});

test("writeState caps at maxLines and refuses empty or secret-bearing handoffs", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  const many = Array.from({ length: 400 }, (_, i) => `row ${i}`);
  const r = writeState(root, { done: many }, { maxLines: 60 });
  assert.equal(r.ok, true);
  const lineCount = readFileSync(statePath(root), "utf8").trimEnd().split("\n").length;
  assert.ok(lineCount <= 61, `bounded: got ${lineCount} lines`);
  assert.equal(writeState(root, {}).ok, false, "empty handoff refused");
  // Runtime-assembled credential shape — never a literal (gitleaks scans history).
  const s = writeState(root, { done: [`the key is ${fakeAnthropic("AAAAbbbbCCCCddddEEEEffff")}`] });
  assert.equal(s.ok, false);
  assert.match(s.reason, /secret/);
});

test("stateBlock injects the snapshot, empty when none exists, capped when long", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  assert.equal(stateBlock(root), "", "fresh repo injects nothing");
  writeState(root, { done: ["a thing"], next: Array.from({ length: 120 }, (_, i) => `n${i}`) });
  const block = stateBlock(root, { maxLines: 20 });
  assert.match(block, /Session state/);
  assert.match(block, /a thing/);
  assert.match(block, /truncated/, "overflow becomes a pointer, not silent growth");
});

test("gatherGitFacts: branch + dirty files inside a repo, empty-safe outside", () => {
  const root = gitFixture();
  writeFileSync(join(root, "b.js"), "export const two = 2;\n");
  const facts = gatherGitFacts(root);
  assert.ok(facts.branch.length > 0, "branch known");
  assert.ok(
    facts.status.some((s) => s.includes("b.js")),
    "dirty file listed",
  );
  const bare = gatherGitFacts(mkdtempSync(join(tmpdir(), "forge-handoff-")));
  assert.equal(bare.branch, "");
  assert.deepEqual(bare.status, []);
});

test("writeState surfaces recorded assumption events from the newest session log", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "sessions", "s1.jsonl"),
    `${JSON.stringify({ type: "assumption", missing: ["target_scope"], ambiguous: ["it"] })}\n`,
  );
  writeState(root, { done: ["x"] });
  const text = readFileSync(statePath(root), "utf8");
  assert.match(text, /target_scope/, "assumption keys carried into the handoff");
});

test("a row containing '<!--' never truncates the snapshot (only provenance is stripped)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  writeState(root, {
    done: ["strip <!-- markers from templates before render"],
    next: ["CRITICAL: fix auth bypass in login.js"],
    gotchas: ["templating chokes on <!-- comments"],
  });
  const text = readState(root);
  assert.match(text, /CRITICAL: fix auth bypass/, "later sections survive an inline <!--");
  assert.match(text, /templating chokes/, "gotchas survive too");
  assert.doesNotMatch(text, /written .*handoff/, "the provenance line itself is stripped");
  const block = stateBlock(root);
  assert.match(block, /CRITICAL: fix auth bypass/, "the injection carries the full snapshot");
});

test("gatherAssumptions dedupes identical events and caps the list", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  const line = `${JSON.stringify({ type: "assumption", missing: ["test-command"] })}\n`;
  writeFileSync(join(root, ".forge", "sessions", "s1.jsonl"), line.repeat(30));
  writeState(root, { done: ["x"] });
  const text = readFileSync(statePath(root), "utf8");
  const count = (text.match(/test-command/g) || []).length;
  assert.equal(count, 1, "30 identical events collapse to one row");
});
