import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "../src/atlas.js";
import { duplicateGate, preEditReuse } from "../src/duplicate_gate.js";
import { computeCodeState, verify } from "../src/verify.js";

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "forge-clones-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  mkdirSync(root);
  mkdirSync(join(root, ".forge"));
  const config = (enabled) =>
    writeFileSync(
      join(root, ".forge", "forge.config.json"),
      JSON.stringify({ verify: { duplicates: enabled } }),
    );
  config(true);
  writeFileSync(join(root, "a.js"), "export function verifyRetryBudget() { return 3; }");
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.org",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, stdio: "ignore" },
    );
  git("init", "-q");
  git("add", "a.js");
  git("commit", "-qm", "initial");
  return { temp, root, config };
}

test("requires explicit project selection and binds the enabled policy into receipts", (t) => {
  const { root, config } = fixture(t);
  const before = computeCodeState(root);
  config(false);
  assert.equal(duplicateGate(root).status, "OFF");
  assert.notEqual(computeCodeState(root).dirtyHash, before.dirtyHash);
  config(true);
  assert.equal(
    duplicateGate(root, "HEAD", { env: { FORGE_JSCPD_BIN: join(root, "a.js") } }).status,
    "INCOMPLETE",
  );
});
test("pre-edit finds declarations at their current source and ignores same-file edits", (t) => {
  const { root } = fixture(t);
  build({ root });
  const input = {
    file_path: "other.js",
    new_string: "export function verifyRetryBudget() { return 3; }",
  };
  assert.match(preEditReuse(root, input), /a\.js:1/);
  assert.equal(preEditReuse(root, { ...input, file_path: "a.js" }), "");
  assert.equal(preEditReuse(root, { ...input, old_string: input.new_string }), "");
});
test("only new clones are reported, without code content, and a tool failure remains incomplete", (t) => {
  const { root, temp } = fixture(t);
  const bin = join(temp, "scanner.cjs");
  const env = { ...process.env, FORGE_JSCPD_BIN: bin };
  const set = (writeCount, code) =>
    writeFileSync(
      bin,
      `const fs=require('node:fs'),path=require('node:path');const out=process.argv[process.argv.indexOf('--output')+1];fs.writeFileSync(path.join(out,'jscpd-report.json'), JSON.stringify({statistics:{total:{newClones:${writeCount}}},duplicates:[{isNew:${Boolean(writeCount)},fragment:'must stay private',firstFile:{name:'a.js',start:1},secondFile:{name:'b.js',start:2}}]}));process.exit(${code});`,
    );
  set(0, 0);
  assert.equal(duplicateGate(root, "HEAD", { env }).status, "PASS");
  set(1, 1);
  const failed = duplicateGate(root, "HEAD", { env });
  assert.equal(failed.status, "FAIL");
  assert.deepEqual(failed.findings, [
    { first: { file: "a.js", line: 1 }, second: { file: "b.js", line: 2 } },
  ]);
  assert.doesNotMatch(JSON.stringify(failed), /must stay private/);
  set(0, 1);
  assert.equal(duplicateGate(root, "HEAD", { env }).status, "INCOMPLETE");
  assert.equal(duplicateGate(root, "missing-ref", { env }).status, "INCOMPLETE");
});
test("verification surfaces an enabled but missing scanner in its signed verdict", (t) => {
  const { root } = fixture(t);
  const before = process.env.FORGE_JSCPD_BIN;
  t.after(() =>
    before === undefined
      ? delete process.env.FORGE_JSCPD_BIN
      : (process.env.FORGE_JSCPD_BIN = before),
  );
  process.env.FORGE_JSCPD_BIN = join(root, "missing-tool");
  const r = verify({ targetRoot: root });
  assert.equal(r.ok, false);
  assert.equal(r.duplicates.status, "INCOMPLETE");
  assert.equal(r.provenance.tests.status, "INCOMPLETE");
});
