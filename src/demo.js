// forge demo — the scripted scenario the README hero describes (item 11):
// a broken tree → verify FAILs → fix → verify PASSes. A real defect, a real
// gate, end to end, in a throwaway git repo under the system temp dir.
//
// It is also the smoke test: `forge demo` exits 0 only if the middle step
// actually FAILED (a demo that never catches the defect proves nothing) and
// the final step PASSED.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "./verify.js";

// Portable: no shell (Windows Git Bash has no /bin/sh path). Each git command
// is a direct spawn.
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" });

function scaffold(root) {
  git(["init", "-q"], root);
  git(["config", "user.email", "demo@forgekit.local"], root);
  git(["config", "user.name", "forge demo"], root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "forge-demo", scripts: { test: "node --test" } }, null, 2),
  );
  writeFileSync(join(root, "add.js"), "export const add = (a, b) => a + b;\n");
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "test", "add.test.js"),
    "import { test } from 'node:test';\n" +
      "import assert from 'node:assert/strict';\n" +
      "import { add } from '../add.js';\n" +
      "test('adds', () => assert.equal(add(2, 3), 5));\n",
  );
  git(["add", "-A"], root);
  git(["commit", "-qm", "scaffold"], root);
}

/**
 * Run the broken → fixed scenario.
 * @param {{onStep?: (msg: string) => void}} [opts]
 * @returns {{ok: boolean, steps: {name: string, status: string}[], root: string}}
 */
export function demo({ onStep } = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-demo-"));
  const say = onStep ?? (() => {});
  /** @type {{name: string, status: string}[]} */
  const steps = [];
  try {
    scaffold(root);

    say("1/3  green tree — verify should PASS");
    const green = verify({ targetRoot: root });
    steps.push({ name: "green tree", status: green.tests.status });

    say("2/3  introduce a real defect — verify should FAIL");
    writeFileSync(join(root, "add.js"), "export const add = (a, b) => a - b; // defect\n");
    const broken = verify({ targetRoot: root });
    steps.push({ name: "broken tree", status: broken.tests.status });

    say("3/3  fix the defect — verify should PASS again");
    writeFileSync(join(root, "add.js"), "export const add = (a, b) => a + b;\n");
    const fixed = verify({ targetRoot: root });
    steps.push({ name: "fixed tree", status: fixed.tests.status });

    const ok =
      steps[0].status === "PASS" && steps[1].status === "FAIL" && steps[2].status === "PASS";
    return { ok, steps, root };
  } finally {
    // Leave the tree on disk for inspection when the demo failed; clean up on success.
    // (The caller decides — here: always clean; the steps carry the evidence.)
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
}
