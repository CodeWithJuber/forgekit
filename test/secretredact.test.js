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

// CR-01: built-in tools return structured OBJECTS, and Claude Code ignores an
// `updatedToolOutput` whose shape doesn't match the original — a stringified object
// would be silently discarded, leaving the secret visible. These tests pin the
// shape-preserving contract against realistic built-in result shapes.
test("secret-redact preserves a Bash-shaped object response (CR-01)", () => {
  const secret = fakeAnthropic("AAAAbbbbCCCCddddEEEEffff");
  const r = run({
    tool_name: "Bash",
    tool_response: {
      stdout: `TOKEN=${secret}`,
      stderr: "",
      interrupted: false,
      isImage: false,
    },
  });
  assert.equal(r.code, 0);
  const updated = JSON.parse(r.out).hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof updated, "object", "replacement must stay an object, not a string");
  assert.deepEqual(Object.keys(updated).sort(), ["interrupted", "isImage", "stderr", "stdout"]);
  assert.match(updated.stdout, /REDACTED/);
  assert.doesNotMatch(updated.stdout, /AAAAbbbbCCCCddddEEEE/);
  assert.equal(updated.stderr, "");
  assert.equal(updated.interrupted, false, "non-string leaves pass through untouched");
  assert.equal(updated.isImage, false);
});

test("secret-redact preserves nested arrays/objects (Grep-shaped response)", () => {
  const secret = fakeAnthropic("AAAAbbbbCCCCddddEEEEffff");
  const r = run({
    tool_name: "Grep",
    tool_response: {
      mode: "content",
      numMatches: 1,
      matches: [{ file: "config.js", line: 3, text: `apiKey = "${secret}"` }],
    },
  });
  assert.equal(r.code, 0);
  const updated = JSON.parse(r.out).hookSpecificOutput.updatedToolOutput;
  assert.equal(updated.mode, "content");
  assert.equal(updated.numMatches, 1, "numbers pass through untouched");
  assert.ok(Array.isArray(updated.matches), "arrays stay arrays");
  assert.equal(updated.matches[0].file, "config.js");
  assert.equal(updated.matches[0].line, 3);
  assert.match(updated.matches[0].text, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(updated), /AAAAbbbbCCCCddddEEEE/);
});

test("secret-redact emits nothing for a clean structured response", () => {
  const r = run({
    tool_name: "Bash",
    tool_response: {
      stdout: "api_key = loaded from environment provider chain",
      stderr: "",
      interrupted: false,
      isImage: false,
    },
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "", "unchanged object must produce no rewrite at all");
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

// CR-02: the previous wrapper ran `node "$MJS"` then unconditionally `exit 0`, erasing
// the strict-mode exit 2 before Claude ever saw it. These tests drive the REAL shell
// wrapper (not the .mjs directly) with a broken redactor beside it and assert the child's
// status survives the pipeline.
function runBrokenWrapper(env = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "redact-wrapper-"));
  copyFileSync(join(guardsDir, "secret-redact.sh"), join(tmp, "secret-redact.sh"));
  copyFileSync(join(guardsDir, "secret-redact.mjs"), join(tmp, "secret-redact.mjs"));
  const r = spawnSync("bash", [join(tmp, "secret-redact.sh")], {
    input: JSON.stringify({
      tool_response: "possible token ghp_but_module_is_missing",
    }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
}

test("wrapper propagates redactor failure as exit 0 + DEGRADED by default (CR-02)", () => {
  const r = runBrokenWrapper({ FORGE_GUARD_STRICT: "" });
  assert.equal(r.code, 0, "default stays advisory");
  assert.match(r.err, /DEGRADED/);
});

test("wrapper propagates strict-mode exit 2 through the pipeline (CR-02)", () => {
  const r = runBrokenWrapper({ FORGE_GUARD_STRICT: "1" });
  assert.equal(r.code, 2, "wrapper must not swallow the child's exit status");
  assert.match(r.err, /DEGRADED/);
});

test("secret-redact failure is loud, not silent (DEGRADED warning, exit 0)", () => {
  const r = runBrokenRedactor({ FORGE_GUARD_STRICT: "" });
  assert.equal(r.code, 0, "default stays non-blocking");
  assert.match(r.err, /DEGRADED/);
});

test("secret-redact failure exits 2 under FORGE_GUARD_STRICT=1 (surfaced, not blocking)", () => {
  const r = runBrokenRedactor({ FORGE_GUARD_STRICT: "1" });
  assert.equal(r.code, 2, "strict mode surfaces the degradation to Claude via exit 2");
  assert.match(r.err, /DEGRADED/);
});

test("secret-redact catches an unknown-vendor high-entropy token (beyond the old sed list)", () => {
  const tok = ["Zq7Rt2", "Xk9Lp4", "Vm1Nc8", "Yb5Ws3", "Hd6Fg0"].join("");
  const r = run({ tool_response: `issued credential ${tok} ok` });
  assert.equal(r.code, 0);
  assert.match(r.out, /REDACTED/);
  assert.doesNotMatch(r.out, new RegExp(tok));
});
