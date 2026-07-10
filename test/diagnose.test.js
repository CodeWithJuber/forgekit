import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  diagnose,
  failureSignature,
  failuresPath,
  normalizeError,
  RING_SIZE,
  readFailures,
  recordFailure,
  THRASH_K,
} from "../src/diagnose.js";
import { loadClaims, repoLedger } from "../src/ledger_store.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-diagnose-"));

// ---------------------------------------------------------------------------
// failureSignature — pure, and stable under everything that varies between two
// runs of the SAME broken code (the whole point: recurrences must accumulate).
// ---------------------------------------------------------------------------

test("failureSignature is stable under line/col numbers, hex addresses, timestamps, absolute paths", () => {
  const where = { file: "src/auth.js", symbol: "verifyToken" };
  const a = failureSignature(
    "TypeError: x is undefined\n    at verifyToken (/home/alice/repo/src/auth.js:12:5) 0xdeadbeef 2026-07-07T10:00:00Z",
    where,
  );
  const b = failureSignature(
    "TypeError: x is undefined\n    at verifyToken (/Users/bob/work/src/auth.js:99:21) 0x1234abcd 2026-07-08T23:59:59Z",
    where,
  );
  assert.equal(a, b, "volatile parts must not change the signature");
});

test("failureSignature distinguishes error class, file, and symbol", () => {
  const base = failureSignature("TypeError: x is undefined", {
    file: "a.js",
    symbol: "f",
  });
  assert.notEqual(base, failureSignature("RangeError: y overflow", { file: "a.js", symbol: "f" }));
  assert.notEqual(
    base,
    failureSignature("TypeError: x is undefined", {
      file: "b.js",
      symbol: "f",
    }),
  );
  assert.notEqual(
    base,
    failureSignature("TypeError: x is undefined", {
      file: "a.js",
      symbol: "g",
    }),
  );
});

test("normalizeError keeps the basename (signal) while dropping the machine prefix", () => {
  const n = normalizeError("Error at /home/ci/build/src/auth.js:3:1 after 120ms");
  assert.match(n, /auth\.js/);
  assert.doesNotMatch(n, /home|ci|build|120|:3/);
});

// ---------------------------------------------------------------------------
// recordFailure — append-only trace with a corrupt-tolerant reader.
// ---------------------------------------------------------------------------

test("recordFailure counts recurrences of the same signature", () => {
  const root = fixture();
  const f = {
    errorText: "TypeError: boom",
    file: "src/a.js",
    symbol: "f",
    t: 1,
  };
  assert.equal(recordFailure(root, f).count, 1);
  assert.equal(recordFailure(root, f).count, 2);
  const other = recordFailure(root, { ...f, errorText: "RangeError: other" });
  assert.equal(other.count, 1, "a different signature counts separately");
  assert.equal(recordFailure(root, f).count, 3);
});

test("recordFailure tolerates corrupt trace lines (killed-process append)", () => {
  const root = fixture();
  recordFailure(root, { errorText: "boom", t: 1 });
  appendFileSync(failuresPath(root), '{"truncated: \n');
  const r = recordFailure(root, { errorText: "boom", t: 2 });
  assert.equal(r.count, 2, "the corrupt line is skipped, not fatal");
  assert.equal(readFailures(root).length, 2);
});

test("recordFailure only counts within the last RING_SIZE entries", () => {
  const root = fixture();
  const f = { errorText: "old failure", file: "src/a.js" };
  recordFailure(root, { ...f, t: 1 });
  recordFailure(root, { ...f, t: 2 });
  for (let i = 0; i < RING_SIZE; i++) recordFailure(root, { errorText: `noise ${i}`, t: 3 + i });
  const r = recordFailure(root, { ...f, t: 999 });
  assert.equal(r.count, 1, "hits pushed out of the ring no longer count toward thrash");
});

test("recordFailure never persists a secret-shaped error head", () => {
  const root = fixture();
  recordFailure(root, {
    errorText: `auth failed: api_key="hunter2-super-secret"`,
    t: 1,
  });
  const [e] = readFailures(root);
  assert.match(e.head, /redacted/);
  assert.doesNotMatch(JSON.stringify(e), /hunter2/);
});

// ---------------------------------------------------------------------------
// diagnose — thrash at k=3 mints ONE content-addressed diagnosis claim.
// ---------------------------------------------------------------------------

test("diagnose stays quiet below the thrash threshold", () => {
  const root = fixture();
  const f = {
    errorText: "TypeError: boom",
    file: "src/a.js",
    symbol: "f",
    nowDay: 10,
  };
  for (let i = 1; i < THRASH_K; i++) {
    const r = diagnose(root, { ...f, t: i });
    assert.equal(r.thrash, false);
    assert.equal(r.count, i);
    assert.equal(r.escalate, undefined);
  }
  assert.equal(loadClaims(repoLedger(root)).length, 0, "no claim minted before thrash");
});

test("diagnose at the 3rd recurrence mints a diagnosis claim and says STOP + escalate one tier", () => {
  const root = fixture();
  const f = {
    errorText: "TypeError: boom",
    file: "src/a.js",
    symbol: "f",
    nowDay: 10,
  };
  let r;
  for (let i = 1; i <= THRASH_K; i++) r = diagnose(root, { ...f, t: i });
  assert.equal(r.thrash, true);
  assert.equal(r.count, THRASH_K);
  assert.match(r.escalate, /STOP retrying/i);
  assert.match(r.escalate, /ONE model tier/i);
  assert.match(r.escalate, /diagnosis as the head/i);
  const claims = loadClaims(repoLedger(root));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "diagnosis");
  assert.equal(claims[0].id, r.claimId);
  assert.equal(claims[0].body.signature, r.signature);
  assert.deepEqual(claims[0].body.triedFixes, []);
  assert.equal(claims[0].provenance.agent, "doomloop");
});

test("diagnose is idempotent — further recurrences resolve to the SAME claim", () => {
  const root = fixture();
  const f = {
    errorText: "TypeError: boom",
    file: "src/a.js",
    symbol: "f",
    nowDay: 10,
  };
  let third;
  for (let i = 1; i <= THRASH_K; i++) third = diagnose(root, { ...f, t: i });
  const fourth = diagnose(root, { ...f, t: THRASH_K + 1 });
  assert.equal(fourth.thrash, true);
  assert.equal(fourth.claimId, third.claimId, "content addressing dedupes the mint");
  assert.equal(loadClaims(repoLedger(root)).length, 1, "no duplicate diagnosis claims");
});

test("diagnose prefers the caller's root-cause note over the error head", () => {
  const root = fixture();
  const f = {
    errorText: "boom",
    note: "circular import between auth and session",
    nowDay: 1,
  };
  let r;
  for (let i = 1; i <= THRASH_K; i++) r = diagnose(root, { ...f, t: i });
  const [claim] = loadClaims(repoLedger(root));
  assert.equal(claim.body.note, f.note);
  assert.equal(claim.id, r.claimId);
});

// ---------------------------------------------------------------------------
// CLI — forge diagnose "<error>" [--file f] [--symbol s] [--json]
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const runCli = (args, cwd) => spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });

test("forge diagnose: records, then escalates on the 3rd identical failure", () => {
  const cwd = fixture();
  mkdirSync(join(cwd, ".forge"), { recursive: true });
  const args = ["diagnose", "TypeError: boom", "--file", "src/a.js", "--symbol", "f"];
  let out;
  for (let i = 0; i < THRASH_K; i++) out = runCli(args, cwd);
  assert.equal(out.status, 0, "advisory — never fails the process");
  assert.match(out.stdout, /thrash/i);
  assert.match(out.stdout, /STOP retrying/i);
  const j = JSON.parse(runCli([...args, "--json"], cwd).stdout);
  assert.equal(j.thrash, true);
  assert.ok(j.claimId);
});

test("forge diagnose: no error text prints usage and exits 1", () => {
  const cwd = fixture();
  const r = runCli(["diagnose"], cwd);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: forge diagnose/);
});
