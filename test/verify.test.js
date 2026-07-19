import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeCodeState,
  extractCalledSymbols,
  findUnknownSymbols,
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

test("verify: polyglot — passing Node suite + non-executable go suite ⇒ INCOMPLETE, not PASS", () => {
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

test("verify: two executable suites both pass ⇒ PASS (every suite ran)", () => {
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

test("verify: one of two executable suites fails ⇒ FAIL (failure is not hidden)", () => {
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
  const root = gitRepo();
  writeFileSync(join(root, "requirements.txt"), "pytest\n");
  const bin = mkdtempSync(join(tmpdir(), "forge-bin-"));
  // Starts but is terminated by SIGKILL before reaching a real exit code — it did NOT
  // complete, so this must be INCOMPLETE, never a false FAIL (a non-zero exit code).
  const p = join(bin, "pytest");
  writeFileSync(p, "#!/bin/sh\nkill -9 $$\n");
  chmodSync(p, 0o755);
  const r = withBins(bin, () => verify({ targetRoot: root }));
  assert.equal(r.tests.status, "INCOMPLETE", "a signal-killed run is not a test failure");
  assert.equal(r.ok, false);
  const s = r.tests.executed.find((x) => x.label.includes("pytest"));
  assert.equal(s.status, "INCOMPLETE");
  assert.notEqual(s.status, "FAIL");
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
