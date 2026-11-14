import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assessTestIntegrity } from "../src/test_integrity.js";

const js = (name, assertion) => `test("${name}", () => {\n  ${assertion}\n});\n`;
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-integrity-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  for (const [p, s] of Object.entries(files)) write(p, s);
  const commit = () => {
    git("add", "--all");
    git("commit", "--allow-empty", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { root, write, git, commit, scan: (base = undefined) => assessTestIntegrity(root, base) };
}

test("test integrity detects lost assertions, loosened checks and new unconditional skips", (t) => {
  const f = fixture(t, {
    "core.test.mjs":
      js("roundtrip", "expect(read()).toEqual(value);") +
      js("rejects bad ID", "assert.throws(parse);"),
    "test_amount.py": "def test_amount():\n    assert value == 123\n",
  });
  f.commit();
  f.write(
    "core.test.mjs",
    js("roundtrip", "expect(read()).toBeTruthy();").replace("test(", "test.skip("),
  );
  f.write("test_amount.py", "def test_amount():\n    assert True\n");
  const r = f.scan();
  assert.equal(r.status, "suspect");
  for (const kind of [/skip/, /truthiness/, /case was removed/, /unconditionally true/])
    assert(
      r.findings.some((x) => kind.test(x.reason)),
      String(kind),
    );
  assert(r.findings.every((x) => x.line > 0 && x.file && x.snapshot === "worktree"));
});

test("file moves, case renames and previous skips are preserved under staged and unstaged moves", (t) => {
  const src =
    js("old name", "assert.equal(output, value);") +
    js("old skip", "doWork();").replace("test(", "it.skip(");
  const f = fixture(t, { "old.test.js": src });
  f.commit();
  renameSync(join(f.root, "old.test.js"), join(f.root, "next.test.js"));
  f.write("next.test.js", src.replace("old name", "new name"));
  assert.equal(f.scan().status, "clear");
  f.git("add", "-A");
  assert.equal(f.scan().status, "clear");
});

test("a changed commit relative to an explicit base and a weakened staged-only file are both inspected", (t) => {
  const file = "test/test_core.py",
    original = "def test_core():\n    assert result == 1\n";
  const f = fixture(t, { [file]: original });
  const base = f.commit();
  f.write(file, "def test_core():\n    assert result is not None\n");
  f.git("add", file);
  f.write(file, original);
  const r = f.scan();
  assert.equal(r.status, "suspect");
  assert.equal(r.findings[0].snapshot, "index");
  f.git("checkout", "--", file);
  f.commit();
  assert.equal(f.scan().status, "clear");
  assert.equal(f.scan(base).status, "suspect");
  assert.equal(f.scan("no-such-base").status, "unavailable");
});

test("unborn repository, newly skipped Go/Rust tests, ignored files, non-git and bounded output", (t) => {
  const f = fixture(t, {
    ".gitignore": "ignored.test.js\n",
    "plain.js": "x\n",
    "ignored.test.js": "it.skip('x', fn)\n",
  });
  assert.equal(f.scan().status, "clear");
  f.write("sample_test.go", 'func TestDisk(t *testing.T) {\n t.Skip("pending")\n}\n');
  f.write("tests/read.rs", "#[test]\n#[ignore]\nfn reads() {}\n");
  const r = f.scan();
  assert.equal(r.status, "suspect");
  assert.equal(r.scannedFiles, 2);
  f.write("new.test.js", " ".repeat(500000));
  assert.equal(f.scan().status, "unavailable");
  assert.equal(assessTestIntegrity(join(f.root, "missing")).status, "unavailable");
});

test("removed unrecognized test formats and conditional new skips remain reviewable", (t) => {
  const f = fixture(t, {
    "test/contract.php": "<?php run_contract_fixture();",
    "runtime.test.ts": "test('clock', { skip: false }, checkClock);",
  });
  f.commit();
  rmSync(join(f.root, "test", "contract.php"));
  f.write("runtime.test.ts", "test('clock', { skip: !process.env.CI }, checkClock);");
  const r = f.scan();
  assert.equal(r.status, "suspect");
  assert(
    r.findings.some((x) => x.file === "test/contract.php" && /entire test file/.test(x.reason)),
  );
  assert(r.findings.some((x) => x.file === "runtime.test.ts" && /skip/.test(x.reason)));
});

test("untrusted pathspecs and git diff helpers cannot run or override the comparison", {
  skip: process.platform === "win32",
}, (t) => {
  const name = ":(glob)$(touch sentinel).test.js";
  const f = fixture(t, {
    [name]: js("abc", "assert.deepEqual(a, b);"),
    ".gitattributes": "*.js diff=evil\n",
  });
  f.commit();
  f.git("config", "diff.evil.textconv", "touch sentinel");
  f.git("config", "diff.external", "touch sentinel");
  f.git("config", "core.fsmonitor", "touch sentinel");
  f.write(name, js("abc", "assert.ok(a);"));
  assert.equal(f.scan().status, "suspect");
  assert.equal(f.scan("--output=sentinel").status, "unavailable");
  assert(!existsSync(join(f.root, "sentinel")));
  rmSync(join(f.root, name));
  symlinkSync(join(f.root, ".git", "config"), join(f.root, name));
  assert.equal(f.scan().status, "unavailable");
});
