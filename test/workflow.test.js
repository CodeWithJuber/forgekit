import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeHarnessRequest } from "../src/harness_gateway.js";
import {
  approveWorkflow,
  createWorkflow,
  getWorkflow,
  retryWorkflow,
  runWorkflow,
} from "../src/workflow.js";
import {
  parseWorkflowReport,
  WORKFLOW_ROUTES,
  workflowCheckout,
  workflowInput,
  workflowPrompt,
  workflowVerifier,
} from "../src/workflow_contract.js";

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "forge-workflow-"));
  const previous = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(dir, "private");
  const root = join(dir, "project");
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "example.txt"), "original\n");
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return root;
}

const report = (stage, decision = "proceed") => ({
  summary: `${stage} report`,
  details: `Observed the current example and recorded the ${stage} result.`,
  evidence: ["example.txt was inspected"],
  blockers: [],
  decision,
});
const latest = (flow, name) => flow.stages.find((s) => s.name === name).attempts.at(-1);
const approve = (root, flow, stage) =>
  approveWorkflow(root, flow.id, { stage, digest: latest(flow, stage).digest });
const create = (root, size = "medium") =>
  createWorkflow(root, { task: "Update the example", size, acceptance: ["Example is correct"] });
const runner =
  (root, calls, decisions = {}) =>
  async (request, options) => {
    calls.push({ request, options });
    return {
      id: request.id,
      status: "done",
      answer: JSON.stringify(report(options.workflowStage, decisions[options.workflowStage])),
      evidence: {
        ok: true,
        scope: "project-suites",
        output: "fixture test passed",
        checkout: workflowCheckout(root),
      },
      certainty: { verification: "L3", answer: "L1" },
      usage: { costUsd: 0, tokens: 20 },
    };
  };

test("medium delivery stops for exact requirement approval, uses fresh roles, then final acceptance", async (t) => {
  const root = workspace(t),
    flow = create(root),
    calls = [];
  assert.equal(flow.status, "ready");
  assert.equal(calls.length, 0);
  const pending = await runWorkflow(root, flow.id, runner(root, calls));
  assert.equal(pending.status, "approval_pending");
  assert.deepEqual(
    calls.map((c) => c.options.workflowStage),
    ["requirement"],
  );
  assert.throws(
    () => approveWorkflow(root, flow.id, { stage: "design", digest: "a".repeat(64) }),
    /approval/i,
  );
  assert.throws(
    () => approveWorkflow(root, flow.id, { stage: "requirement", digest: "a".repeat(64) }),
    /digest/i,
  );
  await runWorkflow(root, flow.id, runner(root, calls));
  assert.equal(calls.length, 1);
  approve(root, pending, "requirement");
  const final = await runWorkflow(root, flow.id, runner(root, calls, { knowledge: "skip" }));
  assert.equal(final.status, "approval_pending");
  assert.deepEqual(
    calls.map((c) => c.options.workflowStage),
    ["requirement", "design", "implement", "review", "test", "knowledge", "summary"],
  );
  assert.equal(new Set(calls.map((c) => c.request.id)).size, 7);
  assert.equal(calls.find((c) => c.options.workflowStage === "review").request.profile, "reviewer");
  assert.equal(calls.find((c) => c.options.workflowStage === "implement").request.profile, "coder");
  assert.equal(final.stages.find((s) => s.name === "knowledge").status, "skipped");
  assert.equal(
    JSON.parse(readFileSync(latest(final, "review").artifact, "utf8")).summary,
    "review report",
  );
  assert.equal(approve(root, final, "summary").status, "done");
  await runWorkflow(root, flow.id, runner(root, calls));
  assert.equal(calls.length, 7, "completed delivery is idempotent");
});

test("small delivery omits planning roles but still requires final acceptance", async (t) => {
  const root = workspace(t),
    flow = create(root, "small"),
    calls = [];
  const done = await runWorkflow(root, flow.id, runner(root, calls));
  assert.deepEqual(
    calls.map((c) => c.options.workflowStage),
    ["solo", "summary"],
  );
  assert.equal(done.status, "approval_pending");
  assert.equal(approve(root, done, "summary").status, "done");
});

test("rework blocks progression; retry keeps old evidence and invalidates downstream approvals", async (t) => {
  const root = workspace(t),
    flow = create(root),
    calls = [];
  approve(root, await runWorkflow(root, flow.id, runner(root, calls)), "requirement");
  const blocked = await runWorkflow(root, flow.id, runner(root, calls, { review: "rework" }));
  assert.equal(blocked.status, "blocked");
  assert.equal(calls.at(-1).options.workflowStage, "review");
  await runWorkflow(root, flow.id, runner(root, calls));
  assert.equal(calls.length, 4);
  const original = latest(blocked, "implement").runId;
  retryWorkflow(root, flow.id, { from: "implement", reason: "Fix the review findings" });
  const final = await runWorkflow(root, flow.id, runner(root, calls));
  assert.notEqual(latest(final, "implement").runId, original);
  assert.match(
    calls.filter((c) => c.options.workflowStage === "implement").at(-1).request.task,
    /review report/,
    "implementation rework receives the prior review findings",
  );
  assert.equal(final.stages.find((s) => s.name === "implement").attempts.length, 2);
  assert.equal(
    final.stages.find((s) => s.name === "requirement").approval.digest,
    latest(final, "requirement").digest,
  );
  retryWorkflow(root, flow.id, { from: "requirement", reason: "Revise acceptance" });
  const reset = getWorkflow(root, flow.id).stages[0];
  assert.equal(reset.approval, null);
  assert.equal(
    reset.attempts[0].approval.digest,
    reset.attempts[0].digest,
    "retry retains the historical approval",
  );
});

test("failed verification and malformed reports never become delivery evidence", async (t) => {
  const root = workspace(t),
    flow = create(root, "small");
  const failed = await runWorkflow(root, flow.id, async (req) => ({
    id: req.id,
    status: "done",
    answer: JSON.stringify(report("solo")),
    evidence: { ok: false },
    certainty: { verification: "L3" },
  }));
  assert.equal(failed.status, "blocked");
  assert.equal(failed.stages[1].attempts.length, 0);
  retryWorkflow(root, flow.id, { from: "solo", reason: "Correct the failed verification" });
  const malformed = await runWorkflow(root, flow.id, async (req) => ({
    id: req.id,
    status: "done",
    answer: "All good!",
    evidence: { ok: true, scope: "project-suites", checkout: workflowCheckout(root) },
    certainty: { verification: "L3" },
  }));
  assert.equal(malformed.status, "blocked");
  assert.match(malformed.reason, /report|JSON/i);
});

test("resume retains the original run ID; no new execution is silently started", async (t) => {
  const root = workspace(t),
    flow = create(root, "small"),
    calls = [];
  const paused = await runWorkflow(root, flow.id, async (request) => {
    calls.push(request.id);
    return { id: request.id, status: "approval_pending", reason: "Tool approval required" };
  });
  assert.equal(paused.status, "blocked");
  await runWorkflow(root, flow.id, async () => assert.fail("run must not retry blocked work"));
  const resumed = await runWorkflow(
    root,
    flow.id,
    async (request, options) => {
      if (options.workflowStage === "solo") {
        assert.equal(request.id, calls[0]);
        assert.equal(options.resume, calls[0]);
      }
      return runner(root, [])(request, options);
    },
    { resume: true },
  );
  assert.equal(resumed.status, "approval_pending");
  assert.equal(resumed.stages[0].attempts.length, 1);
});

test("a changed checkout or modified artifact cannot receive stale acceptance", async (t) => {
  const root = workspace(t),
    flow = create(root);
  const pending = await runWorkflow(root, flow.id, runner(root, []));
  writeFileSync(join(root, "example.txt"), "changed\n");
  assert.throws(() => approve(root, pending, "requirement"), /checkout|changed/i);
  writeFileSync(join(root, "example.txt"), "original\n");
  writeFileSync(latest(pending, "requirement").artifact, JSON.stringify(report("altered")));
  assert.throws(() => approve(root, pending, "requirement"), /artifact|digest/i);
});

test("concurrent run and approval mutations cannot replace an active writer", async (t) => {
  const root = workspace(t),
    flow = create(root);
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const running = runWorkflow(root, flow.id, async (request, options) => {
    entered();
    await wait;
    return runner(root, [])(request, options);
  });
  await started;
  await assert.rejects(runWorkflow(root, flow.id, runner(root, [])), /writer/i);
  assert.throws(
    () => retryWorkflow(root, flow.id, { from: "requirement", reason: "competing change" }),
    /writer/i,
  );
  release();
  assert.equal((await running).status, "approval_pending");
});

test("retrying only summary cannot accept code changed after project verification", async (t) => {
  const root = workspace(t),
    flow = create(root, "small");
  await runWorkflow(root, flow.id, runner(root, []));
  writeFileSync(join(root, "example.txt"), "changed after tests\n");
  retryWorkflow(root, flow.id, { from: "summary", reason: "Refresh the summary" });
  const blocked = await runWorkflow(root, flow.id, async () =>
    assert.fail("Stale proof must stop before calling the model"),
  );
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /project verification/i);
  retryWorkflow(root, flow.id, { from: "solo", reason: "Verify the new code" });
  const checked = await runWorkflow(root, flow.id, runner(root, []));
  assert.equal(approve(root, checked, "summary").status, "done");
});

test("checkout drift before a first attempt can be explicitly retried", async (t) => {
  const root = workspace(t),
    flow = create(root);
  writeFileSync(join(root, "example.txt"), "new baseline\n");
  const blocked = await runWorkflow(root, flow.id, async () => assert.fail());
  assert.equal(blocked.status, "blocked");
  retryWorkflow(root, flow.id, { from: "requirement", reason: "Inspect the changed baseline" });
  assert.equal((await runWorkflow(root, flow.id, runner(root, []))).status, "approval_pending");
});

test("recovered harness success cannot be rebound to code edited after its verification", async (t) => {
  const root = workspace(t),
    flow = create(root, "small");
  let cached;
  await runWorkflow(root, flow.id, async (request, options) => {
    cached = await runner(root, [])(request, options);
    throw new Error("Coordinator interrupted after harness completed");
  });
  writeFileSync(join(root, "example.txt"), "changed after the harness finished\n");
  let calls = 0;
  const blocked = await runWorkflow(
    root,
    flow.id,
    async () => {
      calls++;
      return cached;
    },
    { resume: true },
  );
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /checkout|verification/i);
  assert.equal(calls, 1);
  assert.equal(blocked.stages[1].attempts.length, 0);
});

test("private state corruption cannot remove an approval gate or change a saved role", async (t) => {
  const root = workspace(t),
    flow = create(root);
  const pending = await runWorkflow(root, flow.id, runner(root, []));
  const file = join(pending.directory, "state.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  for (const change of [
    (state) => {
      state.stages[0].status = "completed";
      state.status = "ready";
    },
    (state) => {
      state.stages[0].attempts[0].request.profile = "coder";
    },
    (state) => {
      state.stages[0].attempts[0].request.id = "some-other-run";
    },
    (state) => {
      state.baseline = {};
    },
    (state) => {
      state.status = "done";
    },
  ]) {
    const changed = structuredClone(original);
    change(changed);
    writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => getWorkflow(root, flow.id), /workflow|approval|checkout/i);
  }
});

test("read-only checkout drift and exhausted retries stop before downstream work", async (t) => {
  const root = workspace(t),
    flow = create(root);
  const changed = await runWorkflow(root, flow.id, async (request, options) => {
    writeFileSync(join(root, "example.txt"), "unexpected mutation\n");
    return runner(root, [])(request, options);
  });
  assert.equal(changed.status, "blocked");
  assert.match(changed.reason, /read-only/i);
  for (let n = 0; n < 2; n++) {
    retryWorkflow(root, flow.id, { from: "requirement", reason: "Reinspect" });
    await runWorkflow(root, flow.id, runner(root, [], { requirement: "rework" }));
  }
  assert.throws(
    () => retryWorkflow(root, flow.id, { from: "requirement", reason: "One more" }),
    /attempt limit/i,
  );
  assert.equal(getWorkflow(root, flow.id).stages[1].attempts.length, 0);
});

test("invalid sizes, traversal IDs, empty criteria and unbindable workspaces are rejected", (t) => {
  const root = workspace(t);
  assert.throws(
    () => createWorkflow(root, { task: "x", size: "unknown", acceptance: ["x"] }),
    /size/i,
  );
  assert.throws(() => createWorkflow(root, { task: "x", acceptance: [] }), /acceptance/i);
  assert.throws(() => getWorkflow(root, "../escape"), /ID/i);
  assert.throws(() => createWorkflow(root, { task: "", acceptance: ["x"] }), /task/i);
  // A directory outside this Git repository cannot bind a delivery approval.
  assert.throws(() => createWorkflow(tmpdir(), { task: "x", acceptance: ["x"] }), /Git|checkout/i);
});

test("report validation is structural; coding stages must also pass the selected project verifier", async (t) => {
  const root = workspace(t);
  assert.throws(
    () => parseWorkflowReport("review", JSON.stringify(report("review", "skip"))),
    /skip|decision/i,
  );
  assert.throws(() => parseWorkflowReport("requirement", "{}"), /report/i);
  for (const evidence of [["   "], ["\u0000"]])
    assert.throws(
      () =>
        parseWorkflowReport(
          "review",
          JSON.stringify({
            ...report("review"),
            evidence,
          }),
        ),
      /report/i,
    );
  const input = { answer: JSON.stringify(report("design")) };
  const structural = await workflowVerifier("design", async () => assert.fail())(input);
  assert.equal(structural.ok, true);
  assert.equal(structural.scope, "workflow-report");
  assert.match(structural.output, /structure|claims/i);
  const failure = await workflowVerifier("implement", async () => ({
    ok: false,
    output: "tests failed",
  }))({
    root,
    answer: JSON.stringify(report("implement")),
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.output, "tests failed");
  const success = await workflowVerifier("implement", async () => ({
    ok: true,
    scope: "project-suites",
    output: "PASS",
  }))({ root, answer: JSON.stringify(report("implement")) });
  assert.deepEqual(success.checkout, workflowCheckout(root));
  const drift = await workflowVerifier("implement", async () => {
    writeFileSync(join(root, "example.txt"), "changed while verifying\n");
    return { ok: true, output: "PASS" };
  })({ root, answer: JSON.stringify(report("implement")) });
  assert.equal(drift.ok, false);
  assert.match(drift.output, /checkout changed/i);
});

test("maximum-size and escaped multibyte reports fit every stage's harness task budget", () => {
  for (const text of ["x", "界", "😀", '\n"\\']) {
    const filled = (length) => text.repeat(Math.floor(length / text.length));
    const stages = WORKFLOW_ROUTES.large.map((name) => ({
      name,
      status: "completed",
      feedback: "界".repeat(333),
      attempts: [
        {
          digest: "a".repeat(64),
          report: parseWorkflowReport(
            name,
            JSON.stringify({
              ...report(name),
              summary: filled(1000),
              details: filled(text === "x" ? 6000 : 1800),
              evidence: [filled(600), filled(600)],
            }),
          ),
        },
      ],
    }));
    const flow = {
      ...workflowInput({ task: "界".repeat(1333), acceptance: ["All stages fit"], size: "large" }),
      stages,
    };
    for (const stage of stages) {
      const task = workflowPrompt(flow, stage);
      assert.ok(task.includes(flow.task), "the original task must remain complete");
      assert.ok(Buffer.byteLength(task) <= 16384);
      assert.doesNotThrow(() => normalizeHarnessRequest({ task, acceptance: flow.acceptance }));
    }
  }
});
