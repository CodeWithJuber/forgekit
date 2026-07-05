import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyEvent, detectEpisodes, processSession } from "../src/cortex_hook.js";
import { load } from "../src/lessons_store.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-hook-"));

test("classifyEvent normalizes edits, bash, and prompts", () => {
  assert.deepEqual(classifyEvent({ tool_name: "Edit", tool_input: { file_path: "a.ts" } }), {
    type: "edit",
    file: "a.ts",
  });
  assert.deepEqual(
    classifyEvent({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      exitCode: 1,
    }),
    {
      type: "bash",
      command: "npm test",
      exitCode: 1,
    },
  );
  assert.equal(
    classifyEvent({ hook_event_name: "UserPromptSubmit", prompt: "undo that" }).type,
    "prompt",
  );
  assert.equal(classifyEvent({ tool_name: "Read", tool_input: {} }), null);
});

test("test-fail → edit → pass on a repeatedly-edited file fires a mistake episode", () => {
  const events = [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  const eps = detectEpisodes(events, { nowDay: 1 });
  const m = eps.find((e) => e.kind === "mistake");
  const signals = m.signals.map((s) => s.signal).sort();
  assert.deepEqual(signals, ["S1", "S2"], "test-recovery + self-edit → two families");
});

test("a lone edit or a single 'no' produces no firing lesson (false-positive guards)", () => {
  const root = fixture();
  processSession(root, [{ type: "edit", file: "src/x.ts" }], 1); // one edit, nothing else
  assert.equal(load(root).length, 0, "one edit is not a mistake");

  const root2 = fixture();
  processSession(
    root2,
    [
      { type: "edit", file: "src/y.ts" },
      { type: "prompt", text: "no problem, thanks" },
    ],
    1,
  );
  assert.equal(load(root2).length, 0, "'no problem' is not a correction");
});

test("git revert emits a contradiction episode against recently-edited files", () => {
  const events = [
    { type: "edit", file: "src/auth.ts" },
    { type: "bash", command: "git revert HEAD", exitCode: 0 },
  ];
  const eps = detectEpisodes(events, { nowDay: 1 });
  const c = eps.find((e) => e.kind === "contradiction");
  assert.ok(c, "revert detected");
  assert.deepEqual(c.context.files, ["src/auth.ts"]);
});

test("end-to-end (strong pattern): recurring mistake → candidate then active in 2 sessions", () => {
  const root = fixture();
  // 3 edits (S2+S3) + test fail→pass (S1) → p≈0.71, clears the distill bar on its own
  const session = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, session(), 1);
  assert.equal(load(root)[0].status, "candidate", "first strong occurrence → candidate");
  processSession(root, session(), 2);
  assert.equal(load(root)[0].status, "active", "recurrence → active");
});

test("end-to-end (weak pattern): a 0.4–0.7 episode is ignored once, earns a lesson on recurrence", () => {
  const root = fixture();
  // 2 edits (S2) + test fail→pass (S1) → p≈0.59, below the distill bar
  const session = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/util.ts" },
    { type: "edit", file: "src/util.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, session(), 1);
  assert.equal(load(root).length, 0, "one weak occurrence is not yet a lesson");
  processSession(root, session(), 2);
  assert.equal(
    load(root)[0]?.status,
    "candidate",
    "recurrence promotes the weak episode to a candidate",
  );
});
