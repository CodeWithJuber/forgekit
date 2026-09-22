import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  gatherGitFacts,
  readState,
  STATE_BUDGET_BYTES,
  selectSnapshot,
  stateBlock,
  statePath,
  writeState,
} from "../src/handoff.js";
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

test("writeState stays inside its byte budget and refuses empty or secret-bearing handoffs", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  const many = Array.from({ length: 400 }, (_, i) => `row ${i}`);
  const r = writeState(root, { done: many }, { budget: 1024 });
  assert.equal(r.ok, true);
  const body = readState(root) ?? "";
  assert.ok(Buffer.byteLength(body) <= 1024, `bounded: got ${Buffer.byteLength(body)} bytes`);
  assert.ok(r.bytes <= 1024);
  assert.match(body, /more not kept — over the 1024-byte snapshot budget/, "the drop is stated");
  assert.equal(writeState(root, {}).ok, false, "empty handoff refused");
  // Runtime-assembled credential shape — never a literal (gitleaks scans history).
  const s = writeState(root, { done: [`the key is ${fakeAnthropic("AAAAbbbbCCCCddddEEEEffff")}`] });
  assert.equal(s.ok, false);
  assert.match(s.reason, /secret/);
});

test("stateBlock injects the snapshot, empty when none exists, capped when hand-edited long", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  assert.equal(stateBlock(root), "", "fresh repo injects nothing");
  writeState(root, { done: ["a thing"], next: ["n0"] });
  // A hand-edited (or pre-budget) file can still overflow the loader: the cut is explicit.
  const p = statePath(root);
  const extra = Array.from({ length: 2000 }, (_, i) => `- hand-added row ${i}`).join("\n");
  writeFileSync(p, `${readFileSync(p, "utf8")}\n${extra}\n`);
  const block = stateBlock(root);
  assert.match(block, /Session state/);
  assert.match(block, /a thing/);
  assert.match(block, /truncated at 8192 bytes/, "overflow becomes a pointer, not silent growth");
  assert.doesNotMatch(block, /hand-added row 1999/);
});

// ── C09: the writer bounded 150 LINES and the loader injected 80, so rows 81-150 of a
// valid handoff were silently dropped at session start. One budget now serves both.
test("what writeState writes is what stateBlock reads back (one shared budget)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  // 120 next steps: under the old 150-line writer cap, over the old 80-line loader cap.
  const next = Array.from({ length: 120 }, (_, i) => `next step ${i}`);
  writeState(root, { done: ["shipped"], next });
  const block = stateBlock(root);
  assert.doesNotMatch(block, /truncated/, "a written snapshot is never cut by the loader");
  for (const row of (readState(root) ?? "").split("\n").filter((l) => l.startsWith("- ")))
    assert.ok(block.includes(row), `row read back: ${row}`);
  assert.match(block, /next step 119/);
  // Overfull: the writer drops rows (explicitly), the loader still injects all it wrote.
  const big = (tag) => Array.from({ length: 300 }, (_, i) => `${tag} ${i} ${"x".repeat(40)}`);
  const r = writeState(root, { done: big("done"), next: big("next"), gotchas: big("gotcha") });
  assert.ok(r.bytes <= STATE_BUDGET_BYTES, `writer inside the budget: ${r.bytes}`);
  const full = stateBlock(root);
  assert.doesNotMatch(full, /truncated/);
  for (const row of (readState(root) ?? "").split("\n").filter((l) => l.startsWith("- ")))
    assert.ok(full.includes(row), `row read back: ${row.slice(0, 40)}`);
});

test("writeState keeps rows in A4 priority order: goal, next, decisions, gotchas, in-progress, done", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-handoff-"));
  const rows = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} ${i} ${"y".repeat(30)}`);
  writeState(
    root,
    {
      goal: "ship the export",
      done: rows("done", 60),
      next: rows("next", 20),
      gotchas: rows("gotcha", 20),
    },
    { budget: 2048 },
  );
  const text = readState(root) ?? "";
  assert.match(text, /ship the export/, "goal kept");
  assert.match(text, /next 19 /, "every next step kept before any done row");
  assert.match(text, /append-only log/, "decisions pointer kept");
  assert.match(
    text,
    /## Done this session\n(- done 0 .*\n)?(- done \d+ .*\n)*- \(\+\d+ more not kept/,
  );
  const order = [
    "Goal / Phase",
    "Next steps",
    "Decisions",
    "Gotchas",
    "In-progress",
    "Done this session",
  ];
  const at = order.map((h) => text.indexOf(`## ${h}`));
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    `sections in priority order: ${at}`,
  );
  // Under pressure the lowest-priority section loses rows first.
  const doneKept = (text.match(/^- done \d+ /gm) || []).length;
  const gotchaKept = (text.match(/^- gotcha \d+ /gm) || []).length;
  assert.ok(gotchaKept >= doneKept, `gotchas (${gotchaKept}) outrank done (${doneKept})`);
});

test("selectSnapshot: every header survives and a skipped row is counted, never silent", () => {
  const out = selectSnapshot(
    [
      { title: "A", rows: ["short"] },
      { title: "B", rows: ["z".repeat(500), "tiny"] },
      { title: "C", rows: [] },
    ],
    200,
  );
  const text = out.join("\n");
  assert.ok(Buffer.byteLength(text) <= 200, `fits: ${Buffer.byteLength(text)}`);
  for (const h of ["## A", "## B", "## C"]) assert.ok(text.includes(h), h);
  assert.match(text, /- short/);
  assert.match(text, /- \(\+2 more not kept/, "the oversized row and the rest of B are counted");
  assert.match(text, /## C\n- \(none\)/);
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
