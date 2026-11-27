// Process confinement adapter (src/sandbox.js) and its use by `forge imagine --run`.
// No sandbox runtime is installed in CI, so these tests check the CALL, not the confinement:
// a stand-in `srt` on the PATH records how it was invoked and then runs the command. What the
// real runtime enforces is its own contract and its own test suite.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { dryRun } from "../src/imagine.js";
import { CREDENTIAL_PATHS, sandboxSettings, wrapCommand } from "../src/sandbox.js";

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

test("the policy denies the network, limits writes to the named directories, hides credentials", () => {
  const s = sandboxSettings({ writable: ["/work/checkout"] });
  assert.deepEqual(s.network, { allowedDomains: [], deniedDomains: [] });
  assert.deepEqual(s.filesystem.allowWrite, ["/work/checkout"]);
  assert.deepEqual(s.filesystem.denyRead, CREDENTIAL_PATHS);
  for (const p of ["~/.ssh", "~/.aws", "~/.npmrc", "~/.config/gh"])
    assert.ok(CREDENTIAL_PATHS.includes(p), `${p} is unreadable`);
});

test("wrapCommand: off and absent run plain and say so, required refuses, present wraps", () => {
  const none = () => false;
  const off = wrapCommand("node", ["x.js"], { mode: "off", writable: ["/w"], find: () => true });
  assert.equal(off.command, "node");
  assert.equal(off.isolation.process, "none");
  assert.equal(off.isolation.network, "host");

  const absent = wrapCommand("node", ["x.js"], { writable: ["/w"], find: none });
  assert.deepEqual(absent.args, ["x.js"]);
  assert.equal(absent.isolation.process, "none");
  assert.match(absent.isolation.reason, /no sandbox runtime installed/);

  const refused = wrapCommand("node", ["x.js"], { mode: "required", writable: ["/w"], find: none });
  assert.match(refused.error, /sandbox-runtime/);
  assert.equal("command" in refused, false, "nothing to run when confinement was required");
  assert.match(wrapCommand("node", [], { mode: "strict", writable: [] }).error, /sandbox mode/);

  const wrapped = wrapCommand("node", ["--test", "a.js"], { writable: ["/w"], find: () => true });
  assert.equal(wrapped.command, "srt");
  assert.equal(wrapped.args[0], "--settings");
  // `--` keeps the command's own flags (here node's --test) away from the runtime's parser.
  assert.deepEqual(wrapped.args.slice(2), ["--", "node", "--test", "a.js"]);
  assert.deepEqual(wrapped.isolation, {
    process: "srt",
    network: "denied",
    writes: ["/w"],
    credentials: "unreadable",
  });
  const file = wrapped.args[1];
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), sandboxSettings({ writable: ["/w"] }));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0, "private file");
  wrapped.cleanup();
  assert.equal(existsSync(file), false, "the settings file does not outlive the run");
});

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-sandbox-fx-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  put(root, "package.json", '{ "name": "fx", "type": "module" }\n');
  put(
    root,
    "test/env.test.js",
    'import assert from "node:assert/strict";\n' +
      'import { existsSync } from "node:fs";\n' +
      'import { test } from "node:test";\n' +
      'test("temp dir is whatever the runner provided", () => {\n' +
      "  if (process.env.EXPECT_SCRATCH) {\n" +
      "    assert.match(process.env.TMPDIR, /forge-dryrun-.*tmp$/);\n" +
      "    assert.ok(existsSync(process.env.TMPDIR));\n" +
      "  }\n" +
      "});\n",
  );
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return root;
}

test("dry-run without a runtime: runs, and reports that nothing was confined", () => {
  const root = gitFixture();
  const d = dryRun(root, { tests: ["test/env.test.js"], findSandbox: () => false });
  assert.equal(d.ok, true, d.reason);
  assert.equal(d.failed, 0);
  assert.equal(d.isolation.checkout, "git-worktree");
  assert.equal(d.isolation.process, "none");
  assert.equal(d.isolation.credentials, "readable");

  const refused = dryRun(root, {
    tests: ["test/env.test.js"],
    sandbox: "required",
    findSandbox: () => false,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /no sandbox runtime found/);
  assert.equal(refused.passed, undefined, "the suite never started");
  assert.equal(refused.worktree, "removed");
});

test("dry-run with a runtime on the PATH: the suite is started through it with the fixed policy", {
  skip: process.platform === "win32" && "the stand-in is a POSIX shell script",
}, () => {
  const root = gitFixture();
  const bin = mkdtempSync(join(tmpdir(), "forge-srt-standin-"));
  const record = join(bin, "call.txt");
  writeFileSync(
    join(bin, "srt"),
    "#!/bin/sh\n" +
      '[ "$1" = "--version" ] && { echo standin; exit 0; }\n' +
      'printf "%s\\n" "$@" > "$SRT_RECORD"\n' +
      'cp "$2" "$SRT_RECORD.settings"\n' +
      "shift 3\n" +
      'exec "$@"\n',
  );
  chmodSync(join(bin, "srt"), 0o755);
  const saved = {
    PATH: process.env.PATH,
    a: process.env.SRT_RECORD,
    b: process.env.EXPECT_SCRATCH,
  };
  process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
  process.env.SRT_RECORD = record;
  process.env.EXPECT_SCRATCH = "1";
  let d;
  try {
    d = dryRun(root, { tests: ["test/env.test.js"] });
  } finally {
    process.env.PATH = saved.PATH;
    for (const [k, v] of [
      ["SRT_RECORD", saved.a],
      ["EXPECT_SCRATCH", saved.b],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(d.ok, true, `${d.reason ?? ""}\n${d.output ?? ""}`);
  assert.equal(d.failed, 0, "the test saw its temp directory inside the writable area");
  assert.equal(d.passed, 1);
  assert.equal(d.isolation.process, "srt");
  assert.equal(d.isolation.network, "denied");
  assert.equal(d.worktree, "removed");

  const call = readFileSync(record, "utf8").trim().split("\n");
  assert.equal(call[0], "--settings");
  assert.equal(call[2], "--");
  assert.equal(call[3], process.execPath);
  assert.deepEqual(call.slice(4), ["--test", "--test-reporter=tap", "test/env.test.js"]);
  const policy = JSON.parse(readFileSync(`${record}.settings`, "utf8"));
  assert.deepEqual(policy.network.allowedDomains, []);
  assert.equal(policy.filesystem.allowWrite.length, 1);
  assert.match(policy.filesystem.allowWrite[0], /forge-dryrun-/);
  assert.deepEqual(d.isolation.writes, policy.filesystem.allowWrite);
  assert.equal(existsSync(call[1]), false, "the settings file was removed after the run");
});
