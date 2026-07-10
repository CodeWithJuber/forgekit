import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAnthropic } from "./_fixtures.js";

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
    tool_response: `the key is ${fakeAnthropic("AAAAbbbbCCCCddddEEEEffff")} and more`,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /REDACTED/);
  assert.match(r.out, /updatedToolOutput/);
  assert.doesNotMatch(r.out, /AAAAbbbbCCCCddddEEEE/); // the key's payload is gone from output
});

test("secret-redact stays silent when nothing matches", () => {
  const r = run({ tool_response: "just some normal command output" });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "");
});

// The guard imports src/secrets.js — the shell path and the JS refusal sites share
// ONE detector, so they can never disagree. These two tests pin that parity.
test("secret-redact matches redactSecrets byte-for-byte (shared implementation)", async () => {
  const { redactSecrets } = await import("../src/secrets.js");
  const input = `key=${fakeAnthropic("AAAAbbbbCCCCddddEEEEffff")} then DB_PASSWORD=hunter2-value done`;
  const r = run({ tool_response: input });
  assert.equal(r.code, 0);
  const emitted = JSON.parse(r.out).hookSpecificOutput.updatedToolOutput;
  assert.equal(emitted, redactSecrets(input));
});

test("secret-redact catches an unknown-vendor high-entropy token (beyond the old sed list)", () => {
  const tok = ["Zq7Rt2", "Xk9Lp4", "Vm1Nc8", "Yb5Ws3", "Hd6Fg0"].join("");
  const r = run({ tool_response: `issued credential ${tok} ok` });
  assert.equal(r.code, 0);
  assert.match(r.out, /REDACTED/);
  assert.doesNotMatch(r.out, new RegExp(tok));
});
