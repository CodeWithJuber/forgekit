import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { triageVerifyEvents } from "../src/verify_triage.js";

function event(id, verdict) {
  const pass = verdict === "PASS";
  return {
    runId: id,
    verifier: "forge verify",
    verifierVersion: "1.19.2",
    inCheckout: true,
    authScope: "event",
    pre: { scheme: "v2", head: "revision", dirtyHash: "hash" },
    post: { head: "revision", dirtyHash: "hash" },
    environment: { digest: "platform" },
    suites: [
      {
        cwd: ".",
        label: "unit",
        covers: ["src"],
        status: verdict,
        reportedCounts: {
          total: 1,
          pass: Number(pass),
          fail: Number(!pass),
          cancelled: 0,
          skipped: 0,
          todo: 0,
        },
      },
    ],
  };
}

test("triage finds differing counted results only for the same authenticated suite and state", () => {
  const a = event("one", "PASS"),
    b = event("two", "FAIL"),
    c = event("three", "PASS");
  const d = event("four", "FAIL");
  d.environment.digest = "other";
  const e = event("five", "FAIL");
  e.suites[0].covers = ["lib"];
  const result = triageVerifyEvents([a, b, c, d, e, a]);
  assert.equal(result.inconsistent, 1);
  const suite = result.suites.find((s) => s.status === "inconsistent");
  assert.deepEqual(suite.passes, ["one", "three"]);
  assert.deepEqual(suite.failures, ["two"]);
  assert.equal(result.suites.filter((s) => s.status === "one-observation").length, 2);
  assert.equal(b.suites[0].status, "FAIL");
});

test("old signatures, changed inputs, foreign, excluded, and uncounted runs cannot indicate flakiness", () => {
  const a = event("one", "PASS");
  const foreign = event("foreign", "FAIL");
  foreign.inCheckout = false;
  const legacy = event("legacy", "FAIL");
  legacy.authScope = "verdict";
  const changed = event("changed", "FAIL");
  changed.post.dirtyHash = "other";
  const excluded = { ...event("ex", "FAIL"), external: ["vendor"] };
  const empty = event("empty", "FAIL");
  empty.suites[0].reportedCounts = null;
  const wrong = event("mismatch", "PASS");
  wrong.suites[0].status = "FAIL";
  const result = triageVerifyEvents([a, foreign, legacy, changed, excluded, empty, wrong]);
  assert.equal(result.inconsistent, 0);
  assert.deepEqual(result.suites[0].passes, ["one"]);
  assert.equal(result.suites.length, 1);
});

test("forge verify triage reads real signed pass and fail events for one checkout", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-triage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  mkdirSync(root);
  writeFileSync(join(root, ".gitignore"), ".forge/\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "triage-fixture", scripts: { test: "node --test" } }),
  );
  writeFileSync(
    join(root, "counter.test.cjs"),
    "require('node:test')('fixture', () => require('node:assert/strict').equal(process.env.TRIAGE_FIXTURE_INPUT,'pass'));\n",
  );
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "initial",
  );
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  function invoke(args, input) {
    const r = spawnSync(process.execPath, [cli, ...args, "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FORGE_HOME: join(dir, "home"),
        FORGE_NO_HINT: "1",
        TRIAGE_FIXTURE_INPUT: input,
      },
    });
    return { status: r.status, value: JSON.parse(r.stdout) };
  }
  assert.equal(invoke(["verify"], "pass").status, 0);
  assert.notEqual(invoke(["verify"], "fail").status, 0);
  const history = invoke(["verify", "triage"], "fail");
  assert.equal(history.value.inconsistent, 1, JSON.stringify(history.value));
  assert.equal(history.value.suites[0].passes.length, 1);
  assert.equal(history.value.suites[0].failures.length, 1);
});
