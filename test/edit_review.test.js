import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editReview } from "../src/edit_review.js";
import { normalize, runHook } from "../src/hosts.js";

test("post-edit review checks actual bytes without executing user code or presenting test suggestions as passes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "edit-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "converter.mjs");
  const body = `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(root, "executed"))},"bad");`;
  writeFileSync(file, body);
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test", "converter.test.js"), 'throw Error("test ran");');
  const payload = {
    session_id: "edit",
    cwd: root,
    tool_name: "Write",
    tool_input: { file_path: file, content: "ignored: actual bytes differ" },
  };
  const review = editReview(root, payload);
  assert.match(review, /Node syntax parsed/);
  assert.match(review, /did not run tests/);
  assert.match(review, /converter.test.js/);
  assert.throws(() => readFileSync(join(root, "executed")), { code: "ENOENT" });
  writeFileSync(file, "export const = 12;\n");
  assert.match(editReview(root, payload), /Node syntax check failed/);
  writeFileSync(file, `const key = "ghp_${"V".repeat(36)}";\n<<<<<<< ours\n`);
  const alert = editReview(root, payload);
  assert.match(alert, /possible secret/);
  assert.match(alert, /merge-conflict marker found/);
  assert.doesNotMatch(alert, /VVVV|<<<<<<< ours/);
  const result = await runHook({
    host: "codex",
    event: "PostToolUse",
    claim: null,
    input: JSON.stringify({
      ...payload,
      tool_name: "apply_patch",
      tool_input: {
        input: "*** Begin Patch\n*** Update File: converter.mjs\n@@\n-x\n+y\n*** End Patch",
      },
    }),
  });
  assert.match(
    JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
    /edit review.*possible secret/,
  );
});
test("edit reviews skip a failed, oversize, protected or external file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-bounds-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = (file) => ({ tool_name: "Write", tool_input: { file_path: file } });
  writeFileSync(join(root, "large.mjs"), Buffer.alloc(128 * 1024 + 1, 65));
  for (const file of ["large.mjs", "../config.json", ".env"])
    assert.equal(editReview(root, input(file)), "");
  writeFileSync(join(root, "settings.json"), "{bad");
  assert.match(editReview(root, input("settings.json")), /invalid JSON/);
  assert.equal(
    editReview(root, { ...input("settings.json"), tool_response: { isError: true } }),
    "",
  );
  if (process.platform !== "win32") {
    symlinkSync(join(root, "settings.json"), join(root, "linked.json"));
    assert.equal(editReview(root, input("linked.json")), "");
  }
});

test("a failed patch does not review or record per-file edits that never happened", () => {
  const result = normalize("codex", "PostToolUse", {
    cwd: process.cwd(),
    tool_name: "apply_patch",
    tool_input: { input: "*** Begin Patch\n*** Add File: file.js\n+x\n*** End Patch" },
    tool_response: { isError: true, content: [{ type: "text", text: "patch failed" }] },
  });
  assert.equal(result.payloads.length, 1);
  assert.equal(result.payloads[0].tool_response.isError, true);
  assert.equal(editReview(process.cwd(), result.payloads[0]), "");
});
