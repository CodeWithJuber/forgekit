import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAnthropic } from "./_fixtures.js";

const guardsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "global", "guards");
const guard = join(guardsDir, "secret-redact.sh");

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

// RA-06: a broken redactor must never fail silently — the unredacted output would
// pass straight through. Copying the .mjs to a dir with no ../../src/secrets.js makes
// its dynamic import throw, exercising the degradation path.
function runBrokenRedactor(env = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "redact-degraded-"));
  const broken = join(tmp, "secret-redact.mjs");
  copyFileSync(join(guardsDir, "secret-redact.mjs"), broken);
  const r = spawnSync("node", [broken], {
    input: JSON.stringify({
      tool_response: "possible token ghp_but_module_is_missing",
    }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
}

test("secret-redact failure is loud, not silent (DEGRADED warning, exit 0)", () => {
  const r = runBrokenRedactor({ FORGE_GUARD_STRICT: "" });
  assert.equal(r.code, 0, "default stays non-blocking");
  assert.match(r.err, /DEGRADED/);
});

test("secret-redact failure blocks under FORGE_GUARD_STRICT=1 (exit 2)", () => {
  const r = runBrokenRedactor({ FORGE_GUARD_STRICT: "1" });
  assert.equal(r.code, 2, "strict mode blocks per the hook convention");
  assert.match(r.err, /DEGRADED/);
});

test("secret-redact catches an unknown-vendor high-entropy token (beyond the old sed list)", () => {
  const tok = ["Zq7Rt2", "Xk9Lp4", "Vm1Nc8", "Yb5Ws3", "Hd6Fg0"].join("");
  const r = run({ tool_response: `issued credential ${tok} ok` });
  assert.equal(r.code, 0);
  assert.match(r.out, /REDACTED/);
  assert.doesNotMatch(r.out, new RegExp(tok));
});
