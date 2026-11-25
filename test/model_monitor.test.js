import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { monitorModel } from "../src/model_monitor.js";

function specimen(stable = true) {
  const subject = {
    provider: "fixture",
    model: "model-example",
    revision: "r42",
    protocolSha256: "a".repeat(64),
  };
  let count = 0;
  const run = (a = true, b = true) => ({
    id: `r${++count}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, count)).toISOString(),
    subject: { ...subject },
    outcomes: { a, b },
  });
  return {
    schemaVersion: 1,
    subject,
    anchors: ["a", "b"],
    alpha: 0.2,
    meaningfulDrop: 0.25,
    horizon: 2,
    independentRuns: true,
    stableHistory: true,
    fit: [run(), run()],
    calibration: [
      [run(), run()],
      [run(), run()],
      [run(), run(false, true)],
      [run(false, true), run()],
    ],
    evaluation: [run(stable, stable), run(stable, stable)],
  };
}

test("model regression uses the held-out window maximum, a strict crossing and an independent baseline", () => {
  const normal = specimen(),
    degraded = specimen(false);
  const result = monitorModel(normal),
    bad = monitorModel(degraded);
  assert.equal(result.status, "normal");
  assert.equal(result.boundary, 0.375);
  assert.equal(result.boundary, bad.boundary);
  assert.equal(result.expectedPassRate, 1);
  assert.equal(bad.status, "review");
  assert.equal(bad.evaluationMaximum, 1.75);
  assert.equal(bad.firstCrossingRunId, degraded.evaluation[0].id);
  assert.equal(bad.pValue, 0.2);
  normal.evaluation[1].outcomes.a = false;
  const tie = monitorModel(normal);
  assert.equal(tie.status, "normal");
  assert.equal(tie.pValue, 0.6);
});

test("calibration covers the declared fraction over exchangeable held-out windows", () => {
  const seed = specimen();
  const patterns = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
    [2, 2],
  ];
  let reviewCount = 0;
  for (const heldOut of patterns) {
    const data = structuredClone(seed);
    const windows = [...data.calibration, data.evaluation];
    const assignments = [...patterns.filter((values) => values !== heldOut), heldOut];
    for (const [i, window] of windows.entries()) {
      for (const [j, run] of window.entries()) {
        const fails = assignments[i][j];
        run.outcomes = { a: fails < 1, b: fails < 2 };
      }
    }
    if (monitorModel(data).status === "review") reviewCount++;
  }
  assert.equal(reviewCount / patterns.length, seed.alpha);
});

test("returns cold start for missing fit, an unachievable alarm budget or an unfinished evaluation", () => {
  for (const [edit, reason] of [
    [
      (d) => {
        d.fit = [];
      },
      "missing-fit",
    ],
    [
      (d) => {
        d.alpha = 0.05;
      },
      "insufficient-calibration",
    ],
    [
      (d) => {
        d.evaluation.pop();
      },
      "incomplete-evaluation",
    ],
  ]) {
    const sample = specimen();
    edit(sample);
    const result = monitorModel(sample);
    assert.equal(result.status, "cold-start");
    assert.equal(result.reason, reason);
    assert.equal(Object.hasOwn(result, "boundary"), false);
  }
});

test("rejects changed provenance, pseudoreplication, shifted anchor sets and invalid windows", () => {
  for (const modify of [
    (d) => {
      d.fit[1].subject.revision = "later";
    },
    (d) => {
      d.calibration[0][0].subject.protocolSha256 = "b".repeat(64);
    },
    (d) => {
      d.evaluation[0].id = d.fit[0].id;
    },
    (d) => {
      d.evaluation[0].at = d.fit[0].at;
    },
    (d) => {
      d.evaluation[0].outcomes = { b: true, c: true };
    },
    (d) => {
      d.evaluation[0].outcomes.a = null;
    },
    (d) => {
      d.calibration[0].pop();
    },
    (d) => {
      d.independentRuns = false;
    },
    (d) => {
      d.stableHistory = false;
    },
    (d) => {
      d.alpha = 1;
    },
    (d) => {
      d.fit[0].at = "2026-02-29T00:00:00Z";
    },
  ]) {
    const d = specimen();
    modify(d);
    assert.throws(() => monitorModel(d));
  }
});

test("offline route monitor reports advisory review through the normal CLI entrypoint", (t) => {
  const root = mkdtempSync(join(tmpdir(), "model-monitor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const alias = join(root, "linked-directory");
  mkdirSync(data);
  symlinkSync(data, alias, "junction");
  writeFileSync(join(data, "observations.json"), JSON.stringify(specimen(false)));
  const path = join(alias, "observations.json");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = JSON.parse(
    execFileSync(process.execPath, [cli, "route", "monitor", path, "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORGE_NO_CATALOG_FETCH: "1", FORGE_NO_HINT: "1" },
    }),
  );
  assert.equal(result.status, "review");
  assert.equal(result.advisory, true);
});
