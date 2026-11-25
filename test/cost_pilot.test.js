import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAND } from "../src/brand.js";
import { costWorksheet } from "../src/cost_pilot.js";
import { evaluateRollout, freezeSuite } from "../src/rollout_eval.js";

// All outcomes in this file are synthetic. Exercising the observed-input branch
// tests the decision logic and never promotes a real configuration.
function suite(n = 100) {
  return {
    version: 1,
    purpose: "cost",
    baseline: "fixture A",
    candidate: "fixture B",
    controls: "same verifier, budget and repair policy",
    pilot: {
      consented: true,
      consentRef: "synthetic test only",
      heldOut: true,
      selection: "frozen fixture cases",
      forgeRevision: "c".repeat(40),
      billingScope: "fixture provider, tools, verifier, retries and cached calls included",
      qualityMarginPoints: 5,
      completionMargin: 0.05,
    },
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `case-${i}`,
      repo: `fixture-${i}`,
      revision: "a".repeat(40),
      task: `case for ${i}`,
      acceptance: "fixture verifier",
      stratum: ["repeat-heavy", "mixed", "cold"][i % 3],
    })),
  };
}
function worksheet(frozen) {
  const paper = costWorksheet(frozen);
  Object.assign(paper, {
    source: "simulation",
    runId: "synthetic-01",
    billingDate: "2026-01-10",
    allAttempts: true,
    independentVerifier: true,
  });
  for (const run of paper.runs)
    for (const k of ["baseline", "candidate"]) {
      Object.assign(run[k], {
        status: "verified",
        quality: 80,
        actualUsd: k === "baseline" ? 2 : 1,
        evidence: `synthetic-${run.id}-${k}`,
        billingEvidence: `fixture-invoice-${k}`,
      });
    }
  return paper;
}
test("paired cost pilot calculates cost per verified completion and bounded noninferiority intervals", () => {
  const f = freezeSuite(suite()),
    r = worksheet(f);
  const report = evaluateRollout(f, r);
  assert.equal(report.verdict, "simulation-only");
  assert.ok(Object.values(report.checks).every(Boolean));
  assert.deepEqual(report.comparison.costDifferenceUsdPerVerified, {
    estimate: -1,
    lower: -1,
    upper: -1,
    draws: 2000,
    unit: "USD per verified task",
  });
  assert.equal(report.baseline.usdPerVerifiedInterval.lower, 2);
  assert.equal(report.candidate.usdPerVerifiedInterval.upper, 1);
  assert.ok(report.comparison.qualityPoints.lower < 0);
  assert.ok(report.comparison.completionRate.lower < 0);
  r.source = "observed";
  assert.equal(evaluateRollout(f, r).verdict, "eligible");
  r.runs[0].candidate.status = "abandoned";
  const changed = evaluateRollout(f, r);
  assert.equal(changed.candidate.usdPerVerified, 100 / 99);
  assert.equal(changed.candidate.abandonedRate, 0.01);
  assert.equal(changed.checks.completionNoninferior, false);
  r.runs.forEach((t) => {
    t.candidate.quality = 40;
  });
  assert.equal(evaluateRollout(f, r).checks.qualityNoninferior, false);
});
test("missing invoices, empty completion denominators and underpowered workloads keep baseline", () => {
  const f = freezeSuite(suite(20)),
    r = worksheet(f);
  r.source = "observed";
  r.runs[0].baseline.actualUsd = null;
  r.runs[1].candidate.actualUsd = 0;
  const a = evaluateRollout(f, r);
  assert.equal(a.baseline.missingBills, 1);
  assert.equal(a.baseline.totalSpendUsd, null);
  assert.equal(a.baseline.knownSpendUsd, 38);
  assert.equal(a.candidate.totalSpendUsd, 19);
  assert.equal(a.comparison.costDifferenceUsdPerVerified, null);
  assert.equal(a.checks.minimumTasks, false);
  assert.equal(a.verdict, "keep-baseline");
  r.runs[0].baseline.actualUsd = 2;
  r.runs.forEach((t) => {
    t.candidate.status = "failed";
  });
  const b = evaluateRollout(f, r);
  assert.equal(b.candidate.verified, 0);
  assert.equal(b.candidate.usdPerVerified, null);
  assert.equal(b.checks.lowerCost, false);
});
test("frozen controls, consent, distinct evidence and exact workload identity are enforced", () => {
  const raw = suite(20),
    f = freezeSuite(raw),
    r = worksheet(f);
  for (const [key, value] of [
    ["revision", "f".repeat(40)],
    ["taskHash", "changed"],
    ["config", "different"],
  ]) {
    const mismatch = structuredClone(r);
    mismatch.runs[0].candidate[key] = value;
    assert.throws(() => evaluateRollout(f, mismatch), /Both arms/);
  }
  r.runs[0].candidate.evidence = r.runs[0].baseline.evidence;
  assert.throws(() => evaluateRollout(f, r), /distinct evidence/);
  r.allAttempts = false;
  assert.throws(() => evaluateRollout(f, r), /Attest/);
  raw.pilot.consented = false;
  assert.throws(() => freezeSuite(raw), /consented/);
  raw.pilot.consented = true;
  raw.tasks[1] = { ...raw.tasks[0], id: "other-id" };
  assert.throws(() => freezeSuite(raw), /Duplicate frozen cost workload/);
});
test("cost pilot CLI creates a frozen worksheet and compares it offline", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-p8-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function run(args) {
    const result = spawnSync(
      process.execPath,
      [join(BRAND.root, "src/cli.js"), "cost", "pilot", ...args],
      { cwd: dir, encoding: "utf8", env: { ...process.env, FORGE_NO_HINT: "1", PATH: dir } },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  run(["init", "suite.json"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "suite.json"), "utf8")).pilot.consented, false);
  writeFileSync(join(dir, "suite.json"), JSON.stringify(suite()));
  run(["freeze", "suite.json", "frozen.json"]);
  run(["template", "frozen.json", "runs.json"]);
  const frozen = JSON.parse(readFileSync(join(dir, "frozen.json"), "utf8"));
  const output = worksheet(frozen);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")).runs[0].baseline.taskHash,
    output.runs[0].baseline.taskHash,
  );
  writeFileSync(join(dir, "runs.json"), JSON.stringify(output));
  const report = JSON.parse(run(["compare", "frozen.json", "runs.json", "--json"]));
  assert.equal(report.verdict, "simulation-only");
  assert.equal(report.checks.lowerCost, true);
});
