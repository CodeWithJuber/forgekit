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
  "doom-loop.sh",
);

function run(input, env = {}) {
  const r = spawnSync("bash", [guard], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? 1, err: r.stderr || "" };
}

test("doom-loop warns once the same action repeats past threshold; never blocks", () => {
  const call = {
    session_id: "loop-warn",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  };
  let last;
  for (let i = 0; i < 5; i++) last = run(call);
  assert.equal(last.code, 0, "never blocks");
  assert.match(last.err, /doom-loop|thrash/i);
});

test("doom-loop stays quiet for varied actions", () => {
  let last;
  for (let i = 0; i < 5; i++) {
    last = run({
      session_id: "loop-quiet",
      tool_name: "Bash",
      tool_input: { command: `echo ${i}` },
    });
  }
  assert.equal(last.code, 0);
  assert.doesNotMatch(last.err, /doom-loop/i);
});

test("unwritable history produces one advisory and never enters the numeric comparison", () => {
  // guard is a regular file, so nothing can create a subdirectory even if tests run as root.
  const result = run({ session_id: "no-history", tool_name: "Read" }, { TMPDIR: guard });
  assert.equal(result.code, 0);
  assert.match(result.err, /repetition history unavailable/);
  assert.equal(result.err.trim().split("\n").length, 1);
  assert.doesNotMatch(result.err, /integer expression|thrashing/);
});
