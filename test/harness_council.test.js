import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  conveneCouncil,
  delegationPlan,
  getCouncil,
  recordShapeTrial,
  runDelegation,
  shapeDecision,
  synthesizeCouncil,
} from "../src/harness_council.js";
import { runHarness } from "../src/harness_loop.js";
import { defaultHarnessPolicy } from "../src/harness_policy.js";
import { freezeSuite } from "../src/rollout_eval.js";

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "forge-council-"));
  const before = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(dir, "private");
  const root = join(dir, "workspace");
  mkdirSync(root);
  t.after(() => {
    if (before === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = before;
    rmSync(dir, { recursive: true, force: true });
  });
  return root;
}
async function actualReceipt(root, id, task, acceptance, ok, output) {
  return runHarness({
    root,
    request: { id, task, acceptance: [acceptance], profile: "reviewer" },
    policy: defaultHarnessPolicy(),
    tools: [],
    budget: { repairs: 0 },
    model: async () => ({ finalText: "reviewed", tokens: 4, costUsd: 0 }),
    verify: async () => ({ ok, output, command: "fixture checks" }),
  });
}
function trial() {
  const tasks = Array.from({ length: 20 }, (_, i) => ({
    id: `task-${i}`,
    repo: "repo",
    revision: "a1",
    task: `block missing ownership ${i}`,
    acceptance: "suite passes",
  }));
  const frozen = freezeSuite({
    version: 1,
    purpose: "parallel",
    baseline: "solo",
    candidate: "review pair",
    controls: "Same suite, verified fixture",
    tasks,
  });
  const arm = {
    seconds: 10,
    tokens: 60,
    costUsd: 0.02,
    toolCalls: 3,
    newDuplicates: 0,
    wrongPackages: 0,
    quality: 70,
    accepted: true,
  };
  const measurements = {
    suiteHash: frozen.hash,
    source: "observed",
    runs: tasks.map((t) => ({
      id: t.id,
      baseline: { ...arm, evidence: `log:base/${t.id}` },
      candidate: { ...arm, seconds: 8, evidence: `log:pair/${t.id}` },
    })),
  };
  return { frozen, measurements };
}
const child = { turns: 4, tokens: 1000, milliseconds: 4000, toolCalls: 4, costUsd: 0 };
const parent = { turns: 20, tokens: 4000, milliseconds: 25000, toolCalls: 20, costUsd: 0 };
const members = ["code", "ops", "audit"].map((v, i) => ({
  id: v,
  expertise: 0.9 - i / 10,
  calibration: 0.8,
  trackRecord: `logs/${v}`,
  profile: "reviewer",
  route: `route-${i}`,
  task: `Assess ${v}`,
  acceptance: ["Evidence attached"],
  scopes: [v],
  evidence: "A test run",
  returnFormat: "JSON fields",
  escalation: "Report to lead",
  budget: child,
}));
const input = () => ({
  id: "design",
  domain: "runtime",
  problem: "Choose a retry policy",
  task: "Investigate retries",
  trial: true,
  budget: parent,
  acceptance: ["Reproducible evidence"],
  constraints: ["Keep request bounded"],
  evidence: ["logs/system", "results/code", "results/ops", "results/audit", "results/load"],
  members,
  workers: members,
});
test("workload shape defaults to one, a measured win unlocks class, immutable rows and simulations", async (t) => {
  const root = workspace(t);
  const { frozen, measurements } = trial();
  assert.equal(shapeDecision(root, "parallel").decision, "single");
  assert.throws(() => recordShapeTrial(root, "parallel", frozen, measurements), /local run/);
  for (const t of frozen.spec.tasks) {
    const a = `base-${t.id}`,
      b = `pair-${t.id}`;
    await actualReceipt(root, a, t.task, t.acceptance, false, "requirement missing");
    await actualReceipt(root, b, t.task, t.acceptance, true, "all passed");
    const row = measurements.runs.find((r) => r.id === t.id);
    row.baseline.evidence = `run:${a}`;
    row.candidate.evidence = `run:${b}`;
  }
  const recorded = recordShapeTrial(root, "parallel", frozen, measurements);
  assert.equal(recorded.evaluation.qualityDelta, 100);
  assert.equal(recorded.decision, "keep");
  assert.equal(recorded.pairedEvidence.length, 20);
  assert.deepEqual(shapeDecision(root, "parallel"), recorded);
  const plan = delegationPlan(root, { ...input(), trial: false, shape: "parallel" });
  assert.equal(plan.mode, "measured");
  assert.equal(plan.workers.length, 3);
  assert.equal(
    delegationPlan(root, { ...input(), trial: false, shape: "parallel", taskClass: "architecture" })
      .shape,
    "single",
  );
  assert.throws(
    () => recordShapeTrial(root, "parallel", frozen, { ...measurements, source: "simulation" }),
    /observed/,
  );
  measurements.runs[0].candidate.seconds = 800000;
  assert.deepEqual(recordShapeTrial(root, "parallel", frozen, measurements), recorded);
  const losing = {
    ...measurements,
    runs: measurements.runs.map((r) => ({ ...r, baseline: r.candidate, candidate: r.baseline })),
  };
  assert.throws(() => recordShapeTrial(root, "parallel", frozen, losing), /different recorded/);
  assert.equal(
    recordShapeTrial(root, "parallel", frozen, losing, { taskClass: "regressed" }).decision,
    "revert",
  );
  assert.throws(
    () =>
      delegationPlan(root, {
        ...input(),
        shape: "parallel",
        workers: [members[0], { ...members[1], scopes: ["code/api"] }],
      }),
    /overlap/,
  );
  assert.throws(
    () => delegationPlan(root, { ...input(), shape: "parallel", budget: child }),
    /exceed/,
  );
});
test("council collects independent rounds plus dissent, weighted synthesis and record replay", async (t) => {
  const root = workspace(t),
    spec = input();
  const proven = await actualReceipt(
    root,
    "procedure",
    "Verify retries",
    "capture logs",
    true,
    "Retries persisted",
  );
  const contrary = await actualReceipt(
    root,
    "load",
    "Verify load",
    "capture load",
    true,
    "New load affects retries",
  );
  const loc = `run:${proven.id}#${proven.events.find((e) => e.type === "verify.passed").n}`;
  const dissentLoc = `run:${contrary.id}#${contrary.events.find((e) => e.type === "verify.passed").n}`;
  spec.evidence.push(loc, dissentLoc);
  const observed = [];
  const run = async (req, options) => {
    const { stage, member } = options;
    observed.push({ stage, member, task: req.task, options, id: req.id });
    assert.deepEqual(options.tools, []);
    assert.equal(options.budget.turns, 1);
    let answer;
    if (stage === "propose")
      answer = {
        summary: `Evidence for ${member}`,
        claims: [
          {
            id: "measure",
            claim: "Retries persisted",
            certainty: "L3",
            evidence: loc,
          },
        ],
      };
    if (stage === "challenge")
      answer = {
        challenges: members
          .filter((m) => m.id !== member)
          .map((m) => ({ target: m.id, claim: "measure", question: "How was this reproduced?" })),
      };
    if (stage === "rebut")
      answer = {
        responses: members
          .filter((m) => m.id !== member)
          .map((m) => ({
            from: m.id,
            claim: "measure",
            response: "Attached reproduction",
            disposition: "defended",
          })),
      };
    if (stage === "dissent")
      answer = {
        dissents:
          member === "audit"
            ? [
                {
                  point: "New load affects retries",
                  trigger: "Repeat under higher load",
                  certainty: "L3",
                  evidence: dissentLoc,
                },
              ]
            : [],
      };
    return { status: "done", evidence: { ok: true }, answer: JSON.stringify(answer) };
  };
  const record = await conveneCouncil(root, { ...spec, irreversible: true }, run);
  assert.equal(observed.length, 12);
  assert.equal(new Set(observed.map((o) => o.id)).size, 12);
  assert.ok(
    observed.filter((x) => x.stage === "propose").every((x) => !x.task.includes("Evidence for")),
  );
  assert.equal(record.verdict, "needs_review");
  assert.equal(record.selected, null);
  assert.equal(record.ranked[0].member, "code");
  assert.deepEqual(getCouncil(root, spec.id), record);
  assert.deepEqual(
    await conveneCouncil(root, { ...spec, irreversible: true }, () =>
      assert.fail("already synthesized"),
    ),
    record,
  );
  assert.throws(
    () =>
      synthesizeCouncil(root, { ...record, id: "missing", challenges: record.challenges.slice(1) }),
    /Each member/,
  );
  const forged = synthesizeCouncil(root, {
    ...record,
    id: "forged",
    proposals: record.proposals.map((p) => ({
      ...p,
      claims: p.claims.map((c) => ({ ...c, claim: "An invented unrelated fact" })),
    })),
  });
  assert.ok(forged.proposals.every((p) => p.claims.every((c) => c.certainty === "L1")));
  assert.equal(forged.selected, null);
  const reversible = synthesizeCouncil(root, { ...record, id: "reversible", irreversible: false });
  assert.equal(reversible.selected, "code");
});

test("read-only author and reviewer use distinct routes, budgeted calls and stable verified handoffs", async (t) => {
  const root = workspace(t);
  const spec = { ...input(), shape: "author-reviewer", id: "pair", workers: members.slice(0, 2) };
  const invokes = [];
  const run = async (req, opts) => {
    invokes.push({ req, opts });
    assert.deepEqual(opts.tools, []);
    const answer = {
      findings: [{ finding: "Investigate retry marker", source: "logs/retry" }],
      verdict: "Inspect failure before accepting",
      blocker: null,
    };
    return { status: "done", evidence: { ok: true }, answer: JSON.stringify(answer) };
  };
  const report = await runDelegation(root, spec, run);
  assert.equal(report.verifiedCombinedChange, false);
  assert.equal(invokes.length, 2);
  assert.equal(invokes[0].opts.route, "route-0");
  assert.equal(invokes[1].opts.route, "route-1");
  assert.ok(invokes[1].req.task.includes("Investigate retry marker"));
  assert.ok(!invokes[0].req.task.includes("Investigate retry marker"));
  assert.deepEqual(await runDelegation(root, spec, () => assert.fail()), report);
  await assert.rejects(
    runDelegation(root, { ...spec, evidence: ["different observation"] }, run),
    /immutable delegation/,
  );
});
