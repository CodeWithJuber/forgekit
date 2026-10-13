import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "forge-exit-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["config", "core.fileMode", "false"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  return root;
}

function run(args, cwd) {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (e) {
    return {
      code: e.status,
      out: String(e.stdout || "") + String(e.stderr || ""),
    };
  }
}

test("forge remember with one arg exits 1 (usage), with two args exits 0 (item 45)", () => {
  const root = scratchRepo();
  const bad = run(["remember", "only-a-name"], root);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /usage/);
  const ok = run(["remember", "fact-name", "the sky is blue"], root);
  assert.equal(ok.code, 0);
});

test("forge know end-to-end: no args exits 1, a fact exits 0 (item 45)", () => {
  const root = scratchRepo();
  const bad = run(["know"], root);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /usage/);
  const ok = run(["know", "deploys happen on Fridays", "--dry-run"], root);
  assert.equal(ok.code, 0);
});
