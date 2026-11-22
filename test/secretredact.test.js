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

// Encoded media is not text. Claude Code hands the model an image or a PDF as base64, and
// base64 is full of long mixed-case runs the entropy detector reads as tokens. A rewrite
// that swaps those runs for [REDACTED] is still a string, so the host accepts it and the
// API then rejects the image ("invalid base64 data"). Bytes are deterministic so the
// samples never change between runs.
function mediaBase64(head) {
  let seed = 7;
  const tail = Buffer.from(
    Array.from({ length: 3000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) & 0xff;
    }),
  );
  return Buffer.concat([Buffer.from(head, "latin1"), tail]).toString("base64");
}
const MEDIA = {
  png: mediaBase64("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"),
  jpeg: mediaBase64("\xff\xd8\xff\xe0\x00\x10JFIF"),
  gif: mediaBase64("GIF89a"),
  webp: mediaBase64("RIFF\x24\x0c\x00\x00WEBPVP8 "),
  pdf: mediaBase64("%PDF-1.7\n"),
};

test("secret-redact leaves an image or PDF that Read returns byte-identical", () => {
  for (const [kind, base64] of Object.entries(MEDIA)) {
    const r = run({
      tool_name: "Read",
      tool_input: { file_path: `/tmp/sample.${kind}` },
      tool_response:
        kind === "pdf"
          ? { type: "pdf", file: { filePath: "/tmp/sample.pdf", base64, originalSize: 3009 } }
          : { type: "image", file: { base64, type: `image/${kind}`, originalSize: 3009 } },
    });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), "", `${kind}: encoded media must not be rewritten`);
  }
});

test("secret-redact leaves an image that Bash reports as a data URI untouched", () => {
  for (const stdout of [
    `data:image/png;base64,${MEDIA.png}`,
    `data:image/png;base64,${MEDIA.png}\n`,
  ]) {
    const r = run({
      tool_name: "Bash",
      tool_response: { stdout, stderr: "", interrupted: false, isImage: true },
    });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), "", JSON.stringify(stdout.slice(-3)));
  }
});

test("secret-redact still masks the text beside an image it leaves alone", () => {
  const secret = fakeAnthropic("AAAAbbbbCCCCddddEEEEffff");
  const r = run({
    tool_name: "mcp__browser__screenshot",
    tool_response: [
      { type: "text", text: `saved, session token ${secret}` },
      { type: "image", data: MEDIA.png, mimeType: "image/png" },
    ],
  });
  assert.equal(r.code, 0);
  const updated = JSON.parse(r.out).hookSpecificOutput.updatedToolOutput;
  assert.match(updated[0].text, /REDACTED/);
  assert.doesNotMatch(updated[0].text, /AAAAbbbbCCCCddddEEEE/);
  assert.equal(updated[1].data, MEDIA.png, "the image survives the rewrite byte for byte");
});

test("secret-redact scans a string that only starts like encoded media", () => {
  const secret = fakeAnthropic("AAAAbbbbCCCCddddEEEEffff");
  // No media signature: base64 that is not an image is still a candidate token.
  const blob = run({ tool_response: { stdout: mediaBase64("not media ") } });
  assert.match(blob.out, /REDACTED/, "unrecognised base64 is still scanned");
  // A media signature, then text: the leaf is not one encoded file, so all of it is scanned.
  for (const stdout of [`${MEDIA.png}\nTOKEN=${secret}`, `/9j/ ${secret}`]) {
    const r = run({ tool_response: { stdout } });
    assert.match(r.out, /REDACTED/);
    assert.doesNotMatch(r.out, /AAAAbbbbCCCCddddEEEE/, "the secret after the image is gone");
  }
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

// The shell prefilter decides whether node runs at all, so it has to be a SUPERSET of the
// JS detectors: a URL credential has no 20+ char token run, so before B2 it skipped the
// redactor entirely and the password reached the transcript.
test("secret-redact's prefilter lets every detector's shape through to node (B2)", async () => {
  const { redactSecrets } = await import("../src/secrets.js");
  for (const stdout of [
    "psql postgres://app:Tr0ub4dor3@db.example.com:5432/app",
    "redis-cli -u redis://:hunter2pw@cache:6379/0",
    "DB_PASSWORD=hunter2",
    "AUTH=Basic dXNlcjpwYXNzd29yZA==",
  ]) {
    const r = run({ tool_name: "Bash", tool_response: { stdout } });
    assert.equal(r.code, 0);
    assert.match(r.out, /updatedToolOutput/, `prefilter skipped: ${stdout}`);
    const emitted = JSON.parse(r.out).hookSpecificOutput.updatedToolOutput;
    assert.deepEqual(emitted, { stdout: redactSecrets(stdout) });
  }
});
