import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "global",
  "guards",
  "secret-redact.sh",
);

function run(input) {
  const r = spawnSync("bash", [guard], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return { code: r.status ?? 1, out: r.stdout || "" };
}

test("secret-redact masks a leaked key and emits updatedToolOutput", () => {
  const r = run({
    tool_response: "the key is REDACTED_FIXTURE and more",
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /REDACTED/);
  assert.match(r.out, /updatedToolOutput/);
  assert.doesNotMatch(r.out, /REDACTED_FIXTURE/);
});

test("secret-redact stays silent when nothing matches", () => {
  const r = run({ tool_response: "just some normal command output" });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "");
});
