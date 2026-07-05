import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { processSession } from "../src/cortex_hook.js";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const preEdit = (root, file) =>
  spawnSync("node", [ENTRY, "pre-edit"], {
    input: JSON.stringify({ cwd: root, tool_input: { file_path: file } }),
    encoding: "utf8",
    timeout: 10000,
  });

const seedLesson = (root) => {
  const s = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, s(), 1);
  processSession(root, s(), 2); // → active lesson on src/tax.ts
};

test("pre-edit surfaces a learned lesson for the file being edited", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  seedLesson(root);
  const r = preEdit(root, "src/tax.ts");
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /tax\.ts/);
});

test("pre-edit stays silent for a file with no lesson and no risk (low-nag)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  seedLesson(root);
  const r = preEdit(root, "src/unrelated.ts");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "no lesson, no risk → no advisory");
});

test("pre-edit is fail-safe: no file path → exit 0, no output", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  const r = spawnSync("node", [ENTRY, "pre-edit"], {
    input: JSON.stringify({ cwd: root }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});
