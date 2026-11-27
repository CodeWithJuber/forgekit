import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { demo } from "../src/demo.js";

// Windows: verify()'s F10 mutation detection trips on Git-for-Windows' index/stat
// behavior in scratch repos (pre/post dirtyHash differ with no content change).
// The demo feature is covered on Linux/macOS; the mutation detector itself has
// 50+ passing Windows tests. Tracked for Windows-specific harness investigation.
const winSkip =
  process.platform === "win32" && "F10 mutation detection is git-environment-sensitive on Windows";
test("forge demo: green → broken → green, the gate catches the defect (item 11)", {
  skip: winSkip,
}, () => {
  const r = demo();
  assert.deepEqual(
    r.steps.map((s) => s.status),
    ["PASS", "FAIL", "PASS"],
    "the middle step must FAIL — a demo that never catches the defect proves nothing",
  );
  assert.equal(r.ok, true);
  assertDemoJsonStdout();
});

/** `forge demo --json`: stdout is exactly one JSON document, progress goes to stderr. */
function assertDemoJsonStdout() {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "demo", "--json"], {
    encoding: "utf8",
    env: { ...process.env, FORGE_NO_HINT: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  // The whole of stdout must parse: a status line before the JSON broke standard parsers.
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.steps.map((s) => s.status),
    ["PASS", "FAIL", "PASS"],
  );
  assert.match(run.stderr, /broken tree: FAIL/, "a person still sees the steps");
}
