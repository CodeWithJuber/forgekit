import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CODE_STATE_SCHEME,
  classifySuiteFailure,
  computeCodeState,
  extractCalledSymbols,
  findUnknownSymbols,
  maskedTestScript,
  planSuites,
  provenanceMac,
  readVerifyEvents,
  signProvenance,
  verify,
} from "../src/verify.js";

// A fake executable so a suite's exit code (and thus verify's verdict) is deterministic,
// regardless of what npm/pytest do on this machine.
const fakeBin = (dir, name, exitCode, { executable = true } = {}) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nexit ${exitCode}\n`);
  if (executable) chmodSync(p, 0o755);
  return p;
};
// Run `verify` with a bin dir prepended to PATH (fake runners win; the real git behind
// verify still resolves from the rest of PATH).
const withBins = (binDir, fn) => {
  const old = process.env.PATH;
  process.env.PATH = `${binDir}:${old}`;
  try {
    return fn();
  } finally {
    process.env.PATH = old;
  }
};

const gitRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "forge-verify-"));
  const g = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  g("init");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  return root;
};

// A git repo whose package.json carries `scripts.test` — the shape verify's runner
// detection and the masked-script check both read.
const fixtureWithTestScript = (script) => {
  const root = gitRepo();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "t", scripts: { test: script } }),
  );
  return root;
};

test("extractCalledSymbols finds call sites, skips methods and builtins", () => {
  const src = [
    "const x = computeTax(income)",
    "obj.doThing(1)", // method call — skipped (preceded by '.')
    "console.log(x)", // builtin — skipped
    "return helper(a, b)",
  ].join("\n");
  const syms = extractCalledSymbols(src);
  assert.ok(syms.includes("computeTax"));
  assert.ok(syms.includes("helper"));
  assert.ok(!syms.includes("doThing"), "method call skipped");
  assert.ok(!syms.includes("log"), "builtin skipped");
});

test("findUnknownSymbols flags symbols absent from the atlas", () => {
  const atlas = { symbols: [{ name: "computeTax" }, { name: "helper" }] };
  const unknown = findUnknownSymbols(atlas, ["computeTax", "helper", "totallyMadeUpFn"]);
  assert.deepEqual(unknown, ["totallyMadeUpFn"]);
});

test("extractCalledSymbols dedupes", () => {
  const syms = extractCalledSymbols("foo()\nfoo()\nbar()");
  assert.equal(syms.filter((s) => s === "foo").length, 1);
});

test("shared extractor: atlas and verify use the same call-site extraction (no drift)", async () => {
  const { extractCalledSymbols, CALL_IGNORE } = await import("../src/extract.js");
  // Calls must be separated — the leading-boundary regex consumes the separator, so adjacent
  // calls like foo(bar()) only yield the outer one (shared, pre-existing behaviour).
  const syms = extractCalledSymbols("const x = foo(); bar(); baz.method(); JSON.parse(y)");
  assert.ok(syms.includes("foo") && syms.includes("bar"), "top-level calls captured");
  assert.ok(!syms.includes("method"), "member call .method( is skipped");
  assert.ok(!syms.includes("JSON"), "builtins ignored");
  assert.ok(CALL_IGNORE.has("console"));
});

// ---------------------------------------------------------------------------
// M6 — checkpoint cadence (optimal-stopping threshold rule, pure).
// ---------------------------------------------------------------------------

test("checkpointCadence computes n* = ceil(checkCost / (pErr·tokensPerStep·costPerToken))", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  // risk per step = 0.05 · 200 · 1 = 10 → n* = 100/10 = 10
  assert.equal(checkpointCadence({ pErr: 0.05, tokensPerStep: 200, checkCost: 100 }), 10);
  // non-integer ratio rounds UP — checking a step late is worse than a step early
  assert.equal(checkpointCadence({ pErr: 0.05, tokensPerStep: 200, checkCost: 105 }), 11);
  // costPerToken scales the at-risk side
  assert.equal(
    checkpointCadence({
      pErr: 0.05,
      tokensPerStep: 200,
      costPerToken: 2,
      checkCost: 100,
    }),
    5,
  );
});

test("checkpointCadence: riskier (cheaper) tiers checkpoint more often", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  const haiku = checkpointCadence({
    pErr: 0.2,
    tokensPerStep: 500,
    checkCost: 400,
  });
  const opus = checkpointCadence({
    pErr: 0.01,
    tokensPerStep: 500,
    checkCost: 400,
  });
  assert.ok(haiku < opus, `higher hazard → smaller n* (${haiku} < ${opus})`);
});

test("checkpointCadence clamps to [1, 50]", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  // near-free check → never below every-step
  assert.equal(checkpointCadence({ pErr: 0.5, tokensPerStep: 1000, checkCost: 0 }), 1);
  // near-riskless run (or pErr measured at 0) → still checkpoints by the ceiling
  assert.equal(checkpointCadence({ pErr: 0, tokensPerStep: 1000, checkCost: 100 }), 50);
  assert.equal(checkpointCadence({ pErr: 1e-9, tokensPerStep: 1, checkCost: 100 }), 50);
});

test("checkpointCadence fails safe on degenerate inputs (check every step)", async () => {
  const { checkpointCadence } = await import("../src/verify.js");
  assert.equal(checkpointCadence({ pErr: Number.NaN, tokensPerStep: 100, checkCost: 100 }), 1);
  assert.equal(checkpointCadence({ pErr: 0, tokensPerStep: 100, checkCost: 0 }), 1);
});

// ---------------------------------------------------------------------------
// P0-09 — evidence-aware verdict: NOT_CONFIGURED (never ok) and untracked provenance.
// ---------------------------------------------------------------------------

test("verify: a repo with no test runner is NOT_CONFIGURED and NOT ok (nothing ran)", () => {
  const root = gitRepo();
  writeFileSync(join(root, "a.js"), "export function f(){ return 1 }\n");
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "NOT_CONFIGURED", "no runner detected");
  assert.equal(r.tests.ran, false);
  assert.equal(r.ok, false, "nothing ran must never be ok:true");
});

// ---------------------------------------------------------------------------
// RA-08 — the DETECTED runner is what executes (or is honestly reported), never
// a hardcoded `npm test`.
// ---------------------------------------------------------------------------

test("verify: pnpm repo targets pnpm — with pnpm off PATH it is INCOMPLETE, never a silent npm run", () => {
  const root = gitRepo();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "t",
      scripts: { test: "node -e 'process.exit(0)'" },
    }),
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  // Empty PATH → spawning pnpm deterministically ENOENTs, whatever this machine has
  // installed. git/atlas inside verify are fail-safe against the same PATH.
  const oldPath = process.env.PATH;
  process.env.PATH = join(root, "no-binaries-here");
  let r;
  try {
    r = verify({ targetRoot: root });
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(r.tests.status, "INCOMPLETE", "nothing ran — and npm was NOT substituted");
  assert.equal(r.tests.ran, false);
  assert.equal(r.ok, false);
  assert.ok(r.tests.output.includes("pnpm"), r.tests.output);
  assert.ok(r.tests.output.includes("executor unavailable"), r.tests.output);
});

test("verify: go-only repo is INCOMPLETE with the real label — no built-in executor", () => {
  const root = gitRepo();
  writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.22\n");
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "INCOMPLETE");
  assert.equal(r.tests.ran, false, "go test is detected but never executed by forge");
  assert.equal(r.ok, false);
  assert.ok(r.tests.output.includes("go test ./..."), r.tests.output);
  assert.ok(r.tests.output.includes("no built-in executor"), r.tests.output);
  assert.deepEqual(r.tests.detected, ["go test ./..."]);
});

test("verify: an untracked source file appears in provenance (changedFiles + untracked)", () => {
  const root = gitRepo();
  // untracked (never `git add`ed) — invisible to `git diff`, but part of the change.
  writeFileSync(join(root, "brand_new.js"), "export function shipped(){ return 2 }\n");
  const r = verify({ targetRoot: root });
  assert.ok(r.changedFiles.includes("brand_new.js"), "untracked file in changedFiles");
  assert.ok(r.provenance.untracked.includes("brand_new.js"), "untracked file in provenance stamp");
});

// ---------------------------------------------------------------------------
// HI-01 — run EVERY detected executable suite; a passing suite must not hide a
// second, unexecuted/failing one.
// ---------------------------------------------------------------------------

// win32 gate: the fake runners are `#!/bin/sh` scripts made runnable via the exec bit and a
// `:`-delimited PATH — a Unix construct. Windows resolves `npm`/`pytest` through PATHEXT to
// `.cmd`/`.exe`, so an extensionless shell script can never stand in for them. verify.js itself
// is portable (shell-free execFileSync); only this fake-executable injection is Unix-only.
test("verify: polyglot — passing Node suite + non-executable go suite ⇒ INCOMPLETE, not PASS", {
  skip:
    process.platform === "win32" &&
    "fake #!/bin/sh runners can't be invoked as npm/pytest on Windows",
}, () => {
  const root = gitRepo();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "t", scripts: { test: "true" } }),
  );
  writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.22\n");
  const bin = mkdtempSync(join(tmpdir(), "forge-bin-"));
  fakeBin(bin, "npm", 0); // Node suite passes
  const r = withBins(bin, () => verify({ targetRoot: root }));
  assert.equal(
    r.tests.status,
    "INCOMPLETE",
    "a non-executable suite means the repo isn't fully verified",
  );
  assert.equal(r.ok, false, "INCOMPLETE is never ok:true");
  assert.ok(
    r.tests.executed.some((s) => s.label.includes("npm") && s.status === "PASS"),
    "the Node suite ran and passed",
  );
  assert.ok(
    r.tests.notExecuted.some((l) => l.includes("go test")),
    "the go suite is recorded as not executed",
  );
});

// win32 gate: same Unix fake-runner mechanism as above (see comment).
test("verify: two executable suites both pass ⇒ PASS (every suite ran)", {
  skip:
    process.platform === "win32" &&
    "fake #!/bin/sh runners can't be invoked as npm/pytest on Windows",
}, () => {
  const root = gitRepo();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "t", scripts: { test: "true" } }),
  );
  writeFileSync(join(root, "requirements.txt"), "pytest\n");
  const bin = mkdtempSync(join(tmpdir(), "forge-bin-"));
  fakeBin(bin, "npm", 0);
  fakeBin(bin, "pytest", 0);
  const r = withBins(bin, () => verify({ targetRoot: root }));
  assert.equal(r.tests.status, "PASS");
  assert.equal(r.ok, true);
  assert.equal(r.tests.executed.length, 2, "both suites ran");
  assert.ok(r.tests.executed.every((s) => s.status === "PASS"));
  assert.deepEqual(r.tests.notExecuted, []);
});

// win32 gate: same Unix fake-runner mechanism as above (see comment).
test("verify: one of two executable suites fails ⇒ FAIL (failure is not hidden)", {
  skip:
    process.platform === "win32" &&
    "fake #!/bin/sh runners can't be invoked as npm/pytest on Windows",
}, () => {
  const root = gitRepo();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "t", scripts: { test: "true" } }),
  );
  writeFileSync(join(root, "requirements.txt"), "pytest\n");
  const bin = mkdtempSync(join(tmpdir(), "forge-bin-"));
  fakeBin(bin, "npm", 0); // Node passes
  fakeBin(bin, "pytest", 1); // pytest fails
  const r = withBins(bin, () => verify({ targetRoot: root }));
  assert.equal(r.tests.status, "FAIL");
  assert.equal(r.ok, false);
  const failed = r.tests.executed.find((s) => s.label.includes("pytest"));
  assert.equal(failed.status, "FAIL");
  assert.equal(failed.exitCode, 1, "the real non-zero exit code is recorded");
});

// ---------------------------------------------------------------------------
// ME-02 — a suite that never executed (spawn failure) is INCOMPLETE, never a FAIL.
// ---------------------------------------------------------------------------

test("verify: a suite killed by a signal ⇒ INCOMPLETE, not FAIL (ME-02)", () => {
  // The classification is pure, so every "never reached a verdict" shape is checked on
  // EVERY OS. The old test could only express this with a `#!/bin/sh … kill -9 $$` fixture,
  // which Windows cannot run at all: it exits with a real code, so verify (correctly) called
  // it FAIL and the test failed for a reason that had nothing to do with signals.
  const ctx = { label: "pytest -q", bin: "pytest", timeout: 1000 };
  const killed = classifySuiteFailure({ status: null, signal: "SIGKILL" }, ctx);
  assert.equal(killed.status, "INCOMPLETE", "a signal-killed run is not a test failure");
  assert.equal(killed.exitCode, null);
  assert.equal(killed.signal, "SIGKILL");
  for (const [e, expected] of [
    [{ code: "ENOENT" }, "INCOMPLETE"],
    [{ code: "EACCES" }, "INCOMPLETE"],
    [{ code: "ENOEXEC" }, "INCOMPLETE"],
    [{ code: "ETIMEDOUT" }, "INCOMPLETE"],
    [{ status: null, signal: "SIGTERM" }, "INCOMPLETE"],
    [{ status: 1, stdout: "1 failed" }, "FAIL"], // the ONLY true FAIL: a completed run
    [{ status: 2 }, "FAIL"],
  ]) {
    assert.equal(classifySuiteFailure(e, ctx).status, expected, JSON.stringify(e));
  }
  assert.equal(classifySuiteFailure({ code: "ETIMEDOUT" }, ctx).timedOut, true);

  // End to end where the OS can express it: a suite that really is killed by a signal.
  if (process.platform === "win32") return;
  const root = gitRepo();
  writeFileSync(join(root, "requirements.txt"), "pytest\n");
  const bin = mkdtempSync(join(tmpdir(), "forge-bin-"));
  const p = join(bin, "pytest");
  writeFileSync(p, "#!/bin/sh\nkill -9 $$\n");
  chmodSync(p, 0o755);
  const r = withBins(bin, () => verify({ targetRoot: root }));
  assert.equal(r.tests.status, "INCOMPLETE", "a signal-killed run is not a test failure");
  assert.equal(r.ok, false);
  const s = r.tests.executed.find((x) => x.label.includes("pytest"));
  assert.equal(s.status, "INCOMPLETE");
  assert.ok(s.signal || s.code, `spawn signal/code recorded (${s.signal ?? s.code})`);
});

// ---------------------------------------------------------------------------
// HI-02 / ME-04 — codeState fingerprint bound to the exact tree state.
// ---------------------------------------------------------------------------

test("computeCodeState: stable for an unchanged tree; tracked and untracked edits change dirtyHash", () => {
  const root = gitRepo();
  writeFileSync(join(root, "a.js"), "export const a = 1\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

  const s1 = computeCodeState(root);
  assert.equal(s1.gitAvailable, true);
  assert.equal(typeof s1.head, "string");
  assert.ok(s1.head.length >= 7, "HEAD sha captured");
  assert.equal(typeof s1.dirtyHash, "string");
  assert.equal(computeCodeState(root).dirtyHash, s1.dirtyHash, "unchanged tree → stable hash");

  writeFileSync(join(root, "a.js"), "export const a = 2\n"); // tracked edit
  const s2 = computeCodeState(root);
  assert.notEqual(s2.dirtyHash, s1.dirtyHash, "a tracked edit changes dirtyHash");

  writeFileSync(join(root, "b.js"), "export const b = 3\n"); // untracked file
  const s3 = computeCodeState(root);
  assert.notEqual(s3.dirtyHash, s2.dirtyHash, "an untracked file changes dirtyHash");
});

test("computeCodeState: non-git dir → gitAvailable:false, dirtyHash null (ME-04)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-nogit-"));
  const s = computeCodeState(dir);
  assert.equal(s.gitAvailable, false);
  assert.equal(s.dirtyHash, null);
  assert.equal(s.head, null);
});

test("verify: provenance carries the codeState fingerprint (HI-02)", () => {
  const root = gitRepo();
  writeFileSync(join(root, "a.js"), "export const a = 1\n");
  const r = verify({ targetRoot: root });
  assert.ok(r.provenance.codeState, "codeState present on provenance");
  assert.equal(r.provenance.codeState.gitAvailable, true);
  assert.equal(typeof r.provenance.codeState.dirtyHash, "string");
  assert.ok("head" in r.provenance.codeState);
});

// B7: `"test": "node --test || true"` exits 0 whatever the tests do, so `forge verify`
// reported PASS and the Stop gate accepted it as evidence.
test("verify: a test script that masks its own failures is INCOMPLETE, never PASS (B7)", () => {
  for (const script of [
    "node --test || true",
    "node --test || exit 0",
    "node --test; true",
    "node --test || :",
    "jest --passWithNoTests",
  ]) {
    assert.equal(maskedTestScript(fixtureWithTestScript(script)), script, `masked: ${script}`);
  }
  for (const script of ["node --test", "npm run test:unit && npm run test:e2e", "jest --ci"]) {
    assert.equal(maskedTestScript(fixtureWithTestScript(script)), null, `honest: ${script}`);
  }
  const root = fixtureWithTestScript("node --test || true");
  writeFileSync(
    join(root, "x.test.js"),
    "import test from 'node:test';\ntest('t', () => { throw new Error('x'); });\n",
  );
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "INCOMPLETE", "a masked script cannot produce a verdict");
  assert.equal(r.ok, false);
  assert.match(r.tests.executed[0].output, /masks failures/);
});

// B7: the provenance stamp carries a MAC over the verdict it claims.
test("verify: the provenance stamp is signed, and an edited one no longer verifies (B7)", () => {
  const root = fixtureWithTestScript("node --test");
  const r = verify({ targetRoot: root });
  assert.equal(typeof r.provenance.signature, "string", "the stamp is signed");
  assert.equal(r.provenance.signature, provenanceMac(r.provenance));
  const tampered = { ...r.provenance, tests: { ...r.provenance.tests, status: "PASS" } };
  if (r.provenance.tests.status !== "PASS")
    assert.notEqual(tampered.signature, provenanceMac(tampered), "flipping the verdict breaks it");
  const handWritten = { tests: { status: "PASS" }, codeState: r.provenance.codeState };
  assert.notEqual(handWritten.signature, provenanceMac(handWritten), "an unsigned stamp fails");
  // …and the signer is what closes the gap: only `forge verify` runs it.
  assert.equal(signProvenance(handWritten).signature, provenanceMac(handWritten));
});

// ---------------------------------------------------------------------------
// Review 2026-09-26 — F01: the fingerprint is a canonical manifest, not a byte stream.
// ---------------------------------------------------------------------------

const committedRepo = () => {
  const root = gitRepo();
  writeFileSync(join(root, "keep.js"), "export const keep = 1\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
};

test("F01: renaming an untracked file (identical bytes) changes the fingerprint", () => {
  const root = committedRepo();
  writeFileSync(join(root, "a.js"), "export const x = 42\n");
  const before = computeCodeState(root);
  renameSync(join(root, "a.js"), join(root, "b.js"));
  const after = computeCodeState(root);
  assert.equal(before.scheme, CODE_STATE_SCHEME);
  assert.notEqual(after.dirtyHash, before.dirtyHash, "a.js → b.js is a different code state");
});

test("F01: moving bytes between untracked files ([ab,c] vs [a,bc]) changes the fingerprint", () => {
  const root = committedRepo();
  writeFileSync(join(root, "x.js"), "ab");
  writeFileSync(join(root, "y.js"), "c");
  const s1 = computeCodeState(root);
  writeFileSync(join(root, "x.js"), "a");
  writeFileSync(join(root, "y.js"), "bc");
  assert.notEqual(computeCodeState(root).dirtyHash, s1.dirtyHash, "file boundaries are bound");
});

test("F01: an added EMPTY untracked file, and HEAD itself, are part of the code state", () => {
  const root = committedRepo();
  const clean = computeCodeState(root);
  writeFileSync(join(root, "empty.js"), "");
  assert.notEqual(computeCodeState(root).dirtyHash, clean.dirtyHash, "empty file changes it");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "second"], { cwd: root, stdio: "ignore" });
  const cleanAtNewHead = computeCodeState(root);
  // Both states are CLEAN (empty diff) — only HEAD differs. v1 hashed them identically.
  assert.notEqual(
    cleanAtNewHead.dirtyHash,
    clean.dirtyHash,
    "a different commit is not the same code",
  );
});

test("F01: an untracked file's exec bit and a symlink target are bound", {
  skip: process.platform === "win32" && "POSIX modes/symlinks",
}, () => {
  const root = committedRepo();
  writeFileSync(join(root, "run.sh"), "echo hi\n");
  const s1 = computeCodeState(root);
  chmodSync(join(root, "run.sh"), 0o755);
  const s2 = computeCodeState(root);
  assert.notEqual(s2.dirtyHash, s1.dirtyHash, "mode change is a code-state change");
  symlinkSync("keep.js", join(root, "link.js"));
  const s3 = computeCodeState(root);
  renameSync(join(root, "link.js"), join(root, "link2.js"));
  assert.notEqual(computeCodeState(root).dirtyHash, s3.dirtyHash, "symlink path is bound");
});

test("F01: an unreadable untracked file makes the state unbindable (fail closed)", {
  skip:
    (process.platform === "win32" || process.getuid?.() === 0) &&
    "needs a non-root POSIX user (root reads mode-000 files)",
}, () => {
  const root = committedRepo();
  writeFileSync(join(root, "secret.js"), "x");
  chmodSync(join(root, "secret.js"), 0o000);
  const s = computeCodeState(root);
  assert.equal(s.dirtyHash, null);
  assert.match(s.unbindable, /could not be read/);
  chmodSync(join(root, "secret.js"), 0o644);
});

test("F01: the stamp's signature binds the fingerprint scheme (old-scheme stamps are stale)", () => {
  const stamp = {
    tests: { status: "PASS" },
    codeState: { scheme: CODE_STATE_SCHEME, head: "a".repeat(40), dirtyHash: "b".repeat(64) },
  };
  signProvenance(stamp);
  const v1 = { ...stamp, codeState: { ...stamp.codeState, scheme: undefined } };
  assert.notEqual(
    provenanceMac(v1),
    stamp.signature,
    "a stamp without the v2 scheme no longer verifies",
  );
});

// ---------------------------------------------------------------------------
// F10: a verdict is bound to the bytes it TESTED — a mutation during the run is INCOMPLETE.
// ---------------------------------------------------------------------------

test("F10: a test that rewrites source during the run cannot produce a signed PASS", () => {
  const root = fixtureWithTestScript("node --test");
  writeFileSync(join(root, "subject.cjs"), "module.exports = 42;\n");
  writeFileSync(
    join(root, "subject.test.cjs"),
    [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "const fs = require('node:fs');",
      "test('checks then mutates', () => {",
      "  assert.strictEqual(require('./subject.cjs'), 42);",
      "  fs.writeFileSync(__dirname + '/subject.cjs', 'module.exports = 0;\\n');",
      "});",
      "",
    ].join("\n"),
  );
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.executed[0].status, "PASS", "the suite itself passed…");
  assert.equal(r.tests.status, "INCOMPLETE", "…but the tree moved, so no verdict is bound");
  assert.equal(r.tests.mutated, true);
  assert.equal(r.ok, false);
  assert.notEqual(r.provenance.codeState.dirtyHash, r.provenance.codeStateAfter.dirtyHash);
  assert.equal(
    r.provenance.codeStateAfter.dirtyHash,
    computeCodeState(root).dirtyHash,
    "the after-state is the mutated tree",
  );
  assert.equal(r.provenance.signature, provenanceMac(r.provenance), "signed as INCOMPLETE");
});

test("F10: outputs declared in verify.generated may change during the run", () => {
  const root = fixtureWithTestScript("node --test");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "forge.config.json"),
    JSON.stringify({ verify: { generated: ["reports/**"] } }),
  );
  writeFileSync(
    join(root, "gen.test.cjs"),
    [
      "const { test } = require('node:test');",
      "const fs = require('node:fs');",
      "test('writes a report', () => {",
      "  fs.mkdirSync(__dirname + '/reports', { recursive: true });",
      "  fs.writeFileSync(__dirname + '/reports/out.txt', String(Date.now()));",
      "});",
      "",
    ].join("\n"),
  );
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "PASS", r.tests.output);
  assert.equal(r.tests.mutated, undefined);
});

// ---------------------------------------------------------------------------
// F08/F09: suites are planned per package; coverage is explicit.
// ---------------------------------------------------------------------------

const monorepo = ({ rootScript = "node --test", workspaces = ["packages/*"] } = {}) => {
  const root = gitRepo();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "mono", private: true, workspaces, scripts: { test: rootScript } }),
  );
  writeFileSync(
    join(root, "root.test.cjs"),
    "const { test } = require('node:test');\ntest('root ok', () => {});\n",
  );
  mkdirSync(join(root, "packages", "bad"), { recursive: true });
  writeFileSync(
    join(root, "packages", "bad", "package.json"),
    JSON.stringify({ name: "bad", scripts: { test: 'node -e "process.exit(1)"' } }),
  );
  return root;
};

test("F08: a failing workspace package cannot hide behind a passing root suite", () => {
  const root = monorepo();
  const r = verify({ targetRoot: root });
  const nested = r.tests.executed.find((s) => s.cwd === "packages/bad");
  assert.ok(nested, `the nested suite ran: ${JSON.stringify(r.tests.executed)}`);
  assert.equal(nested.status, "FAIL");
  assert.equal(r.tests.status, "FAIL");
  assert.deepEqual(r.tests.coverage.required, [".", "packages/bad"]);
});

test("F08: a recursive root script covers declared workspaces once (no duplicate run)", () => {
  const root = monorepo({ rootScript: "npm test --workspaces --if-present" });
  const plan = planSuites(root);
  assert.equal(plan.suites.length, 1, "only the root suite runs");
  assert.deepEqual(plan.suites[0].covers, [".", "packages/bad"], "…and it covers the workspace");
  assert.equal(plan.coverage.rootCoversWorkspaces, true);
});

test("F08: verify.workspaces=root is an explicit coverage declaration; exclude/fixtures skip", () => {
  const root = monorepo();
  mkdirSync(join(root, "test", "fixtures", "pkg"), { recursive: true });
  writeFileSync(
    join(root, "test", "fixtures", "pkg", "package.json"),
    JSON.stringify({ scripts: { test: "exit 1" } }),
  );
  const plan = planSuites(root);
  assert.ok(
    plan.coverage.excluded.some((e) => e.path === "test/fixtures/pkg"),
    "a fixture package is not a required suite",
  );
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "forge.config.json"),
    JSON.stringify({ verify: { exclude: ["packages/bad"] } }),
  );
  const excluded = verify({ targetRoot: root });
  assert.equal(excluded.tests.status, "PASS", excluded.tests.output);
  assert.ok(excluded.tests.coverage.excluded.some((e) => e.reason === "verify.exclude"));
  writeFileSync(
    join(root, ".forge", "forge.config.json"),
    JSON.stringify({ verify: { workspaces: "root" } }),
  );
  const declared = planSuites(root);
  assert.equal(declared.suites.length, 1);
  assert.ok(declared.suites[0].covers.includes("packages/bad"));
});

test("F08: a nested suite forge cannot execute leaves its package uncovered → INCOMPLETE", () => {
  const root = fixtureWithTestScript("node --test");
  mkdirSync(join(root, "services", "api"), { recursive: true });
  writeFileSync(join(root, "services", "api", "go.mod"), "module x\n\ngo 1.22\n");
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "INCOMPLETE");
  assert.deepEqual(r.tests.coverage.uncovered, ["services/api"]);
  assert.ok(r.tests.notExecuted.some((l) => l.includes("services/api")));
});

test("F09: an explicit passing script + a runner devDependency is a complete PASS", () => {
  const root = gitRepo();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "t",
      scripts: { test: "node --test" },
      devDependencies: { vitest: "2" },
    }),
  );
  writeFileSync(
    join(root, "ok.test.cjs"),
    "const { test } = require('node:test');\ntest('ok', () => {});\n",
  );
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "PASS", r.tests.output);
  assert.deepEqual(
    r.tests.notExecuted,
    [],
    "the vitest dependency is inventory, not an obligation",
  );
});

// ---------------------------------------------------------------------------
// A01: one verifier event per run — id, suites, coverage, pre/post state, environment.
// ---------------------------------------------------------------------------

test("A01: verify records an immutable, MAC'd verifier event", () => {
  const root = fixtureWithTestScript("node --test");
  writeFileSync(
    join(root, "ok.test.cjs"),
    "const { test } = require('node:test');\ntest('ok', () => {});\n",
  );
  const r = verify({ targetRoot: root });
  const e = r.provenance.event;
  assert.match(e.runId, /^[0-9a-f-]{36}$/);
  assert.equal(e.status, "PASS");
  assert.equal(e.pre.dirtyHash, r.provenance.codeState.dirtyHash);
  assert.equal(e.post.dirtyHash, e.pre.dirtyHash);
  assert.deepEqual(e.suites[0].covers, ["."]);
  assert.equal(typeof e.environment.digest, "string");
  const events = readVerifyEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, e.runId);
  // A hand-edited event line (verdict flipped) is not read back as evidence.
  const path = join(root, ".forge", "verify-events.jsonl");
  const forged = { ...JSON.parse(readFileSync(path, "utf8").trim()), status: "FAIL" };
  writeFileSync(path, `${JSON.stringify(forged)}\n`);
  assert.equal(readVerifyEvents(root).length, 0);
});

test("F10: interpreter caches written by a test run are not a code mutation", () => {
  const root = fixtureWithTestScript("node write-cache.cjs");
  writeFileSync(
    join(root, "write-cache.cjs"),
    [
      "const fs = require('node:fs');",
      "fs.mkdirSync(__dirname + '/pkg/__pycache__', { recursive: true });",
      "fs.writeFileSync(__dirname + '/pkg/__pycache__/m.cpython-312.pyc', String(Date.now()));",
      "fs.mkdirSync(__dirname + '/.pytest_cache', { recursive: true });",
      "fs.writeFileSync(__dirname + '/.pytest_cache/state', String(Date.now()));",
      "",
    ].join("\n"),
  );
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "PASS", r.tests.output);
  assert.equal(r.tests.mutated, undefined);
});
