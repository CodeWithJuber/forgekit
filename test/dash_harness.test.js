import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dashData, serve } from "../src/dash.js";
import { dashHarness } from "../src/dash_harness.js";
import { initHarness } from "../src/harness_config.js";
import { runHarness } from "../src/harness_loop.js";
import { defaultHarnessPolicy } from "../src/harness_policy.js";
import { openHarnessRun } from "../src/harness_trace.js";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-dash-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("setup distinguishes project markers, selected native/generic hosts, drift and changed trust", (t) => {
  const root = workspace(t);
  mkdirSync(join(root, ".claude"));
  const empty = dashHarness(root);
  assert.equal(empty.state, "unconfigured");
  assert.deepEqual(empty.runs, []);
  const claude = empty.hosts.find((h) => h.id === "claude");
  assert.equal(claude.detected, true);
  assert.equal(claude.selected, false);
  assert.equal(claude.wiring, "not-checked");
  initHarness(root, { supervised: true, hosts: ["claude", "generic"] });
  const active = dashHarness(root);
  assert.equal(active.state, "active");
  assert.equal(active.mode, "supervised");
  assert.equal(active.hosts.find((h) => h.id === "claude").wiring, "needs-attention");
  assert.equal(active.hosts.find((h) => h.id === "generic").wiring, "manual");
  assert.equal(active.hosts.find((h) => h.id === "kimi").selected, false);
  const file = join(root, "harness", "policy.yaml");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.hosts.push("codex");
  writeFileSync(file, JSON.stringify(policy));
  assert.equal(dashHarness(root).state, "needs-trust");
  writeFileSync(file, "null");
  assert.equal(dashHarness(root).state, "invalid");
});

test("local run summaries show verified outcomes, redact secrets and omit payloads from shared dashboard data", async (t) => {
  const root = workspace(t);
  const run = await runHarness({
    root,
    request: {
      id: "check-status",
      task: "Inspect jwt auth=private-value",
      acceptance: ["status matches"],
    },
    policy: defaultHarnessPolicy(),
    model: async () => ({ finalText: "private answer canary", tokens: 3, costUsd: 0 }),
    verify: async () => ({ ok: true, command: "fixture", output: "private test output canary" }),
  });
  assert.equal(run.status, "done", run.reason);
  const server = serve(root, { port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/harness`);
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.equal(summary.runs.length, 1);
  const row = summary.runs[0];
  assert.equal(row.id, "check-status");
  assert.equal(row.verified, true);
  assert.equal(row.costUsd, 0);
  assert.equal(row.command, "forge harness show check-status");
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private-value|private answer canary|private test output canary|record\.json/,
  );
  assert.doesNotMatch(JSON.stringify(dashData(root)), /check-status/);
  assert.deepEqual(dashHarness(root, false), {
    state: "private",
    mode: null,
    hosts: [],
    runs: [],
    moreRuns: false,
    runsUnavailable: false,
  });
  const shared = serve(root, { host: "0.0.0.0", port: 0 });
  await new Promise((resolve) => shared.once("listening", resolve));
  t.after(() => shared.close());
  const privateView = await (
    await fetch(`http://127.0.0.1:${shared.address().port}/api/harness`)
  ).json();
  assert.equal(privateView.state, "private");
  assert.equal(privateView.runs.length, 0);
});

test("recent runs are capped, tolerate an unreadable record and do not mix workspaces", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 22; i++) {
    const entry = openHarnessRun(root, `run-${i}`);
    try {
      const record = {
        version: 1,
        id: entry.id,
        status: "running",
        request: { task: "Inspect retry" },
        events: [],
        usage: {},
      };
      entry.save(record);
      if (i === 21) {
        const path = entry.view(record).tracePath;
        truncateSync(path, 3 * 1024 * 1024);
        const newest = new Date(Date.now() + 60000);
        utimesSync(path, newest, newest);
      }
    } finally {
      entry.release();
    }
  }
  const out = dashHarness(root);
  assert.equal(out.moreRuns, true);
  assert.equal(out.runsUnavailable, true);
  assert.ok(out.runs.length > 0 && out.runs.length <= 20);
  assert.ok(out.runs.every((run) => run.verified === false && run.costUsd === null));
  assert.deepEqual(dashHarness(workspace(t)).runs, []);
});
