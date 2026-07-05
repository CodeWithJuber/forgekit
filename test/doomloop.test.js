import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const guard = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "global",
  "guards",
  "doom-loop.sh",
);

function run(input) {
  const r = spawnSync("bash", [guard], {
    input: JSON.stringify(input),
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
      tool_input: { command: "echo " + i },
    });
  }
  assert.equal(last.code, 0);
  assert.doesNotMatch(last.err, /doom-loop/i);
});
