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

// ── fact forwarding and the equal-budget ladder (He et al., arXiv 2611.32606) ──────────

const forwardWorkers = (extra = {}) =>
  members.slice(0, 3).map((m) => ({ ...m, facts: [`fact-${m.id}`], ...(extra[m.id] ?? {}) }));

test("forward: each worker sees only its private facts; one deduplicated packet; team usage recorded", async (t) => {
  const root = workspace(t);
  const spec = { ...input(), shape: "forward", id: "fwd", workers: forwardWorkers() };
  const seen = new Map();
  const run = async (req) => {
    seen.set(req.actor, req.task);
    return {
      status: "done",
      evidence: { ok: true },
      usage: { tokens: 100, costUsd: 0.01, toolCalls: 1, milliseconds: 1000 + seen.size * 10 },
      answer: JSON.stringify({
        findings: [
          { finding: `${req.actor} holds its fact`, source: `fact-${req.actor}` },
          { finding: "everyone noticed this", source: "shared" },
        ],
        verdict: "forwarded",
        blocker: null,
      }),
    };
  };
  const rec = await runDelegation(root, spec, run);
  for (const m of members) {
    const task = seen.get(m.id);
    assert.match(task, /PRIVATE slice/);
    assert.ok(task.includes(`fact-${m.id}`));
    assert.ok(!task.includes("logs/system"), "no shared evidence pack");
    for (const o of members.filter((o) => o.id !== m.id)) assert.ok(!task.includes(`fact-${o.id}`));
  }
  assert.equal(rec.forwarded.filter((f) => f.finding === "everyone noticed this").length, 1);
  assert.equal(rec.forwarded.length, 4);
  assert.deepEqual(rec.usage, {
    tokens: 300,
    costUsd: 0.03,
    toolCalls: 3,
    milliseconds: 3060,
    wallMilliseconds: 1030,
  });
  assert.equal(rec.task, spec.task);
  assert.equal(rec.information.private, 3);
  assert.equal(rec.verifiedCombinedChange, false, "the hub integrates and verifies");
});

test("the information advisory: shared packs, debate, and forward teams without private facts", (t) => {
  const root = workspace(t);
  const parallel = delegationPlan(root, { ...input(), shape: "parallel" });
  assert.equal(parallel.information.private, 0);
  assert.match(parallel.information.advisory, /same evidence pack/);
  const council = delegationPlan(root, { ...input(), shape: "council" });
  assert.match(council.information.advisory, /Debate over a shared evidence pack/);
  const sameFacts = delegationPlan(root, {
    ...input(),
    shape: "forward",
    workers: forwardWorkers({
      code: { facts: ["same"] },
      ops: { facts: ["same"] },
      audit: { facts: ["same"] },
    }),
  });
  assert.equal(sameFacts.information.private, 0);
  assert.match(sameFacts.information.advisory, /Fewer than two workers hold a private fact/);
  assert.throws(
    () => delegationPlan(root, { ...input(), shape: "forward", workers: members.slice(0, 2) }),
    /private facts/,
  );
});

/** A 20-task trial whose candidate arm is a lead run plus a forward delegation (`group`), and
 *  whose pool holds independent single-agent runs. `poolPasses(i)` = passing pool runs on task i. */
async function ladderTrial(root, { leadPasses, poolPasses, poolSize = 2 }) {
  const { frozen, measurements } = trial();
  for (const [i, t] of frozen.spec.tasks.entries()) {
    const row = measurements.runs.find((r) => r.id === t.id);
    const base = `base-${t.id}`;
    const lead = `lead-${t.id}`;
    await actualReceipt(root, base, t.task, t.acceptance, false, "requirement missing");
    await actualReceipt(
      root,
      lead,
      t.task,
      t.acceptance,
      leadPasses,
      leadPasses ? "all passed" : "failed",
    );
    const group = `grp-${t.id}`;
    await runDelegation(
      root,
      { ...input(), id: group, shape: "forward", task: t.task, workers: forwardWorkers() },
      async (req) => ({
        status: "done",
        evidence: { ok: true },
        // 3 workers × 2 tokens on top of a 4-token lead run: the team spends n_B = 2.5 agents.
        usage: { tokens: 2, costUsd: 0, toolCalls: 0, milliseconds: 5 },
        answer: JSON.stringify({
          findings: [{ finding: `${req.actor} fact`, source: `fact-${req.actor}` }],
          verdict: "forwarded",
          blocker: null,
        }),
      }),
    );
    row.baseline.evidence = `run:${base}`;
    row.candidate = { ...row.candidate, evidence: `run:${lead}`, group };
    row.pool = [];
    for (let j = 0; j < poolSize; j++) {
      const id = `pool-${t.id}-${j}`;
      const ok = j < poolPasses(i);
      await actualReceipt(root, id, t.task, t.acceptance, ok, ok ? "all passed" : "failed");
      row.pool.push({ evidence: `run:${id}` });
    }
  }
  return { frozen, measurements };
}

test("ladder trial: a team that beats the compute-matched best-of-n is kept", async (t) => {
  const root = workspace(t);
  const { frozen, measurements } = await ladderTrial(root, {
    leadPasses: true,
    poolPasses: () => 0,
  });
  const rec = recordShapeTrial(root, "forward", frozen, measurements);
  assert.equal(rec.evaluation.ladder.level, 3);
  assert.equal(rec.decision, "keep");
  assert.ok(rec.pairedEvidence.every((p) => p.pool.length === 2));
  assert.ok(
    rec.pairedEvidence.every((p) => p.candidate.tokens > p.baseline.tokens),
    "the candidate arm pays for its workers",
  );
});

test("ladder trial: a team the old threshold rule would keep, but that does not beat pass@n, is reverted", async (t) => {
  const root = workspace(t);
  // Baseline always fails (old rule: +100 quality → keep); but 2 of 3 independent runs pass, so
  // pass@n at the team's budget (n_B = 2.5 → between pass@2 and pass@3, both 1) is already 1.
  const { frozen, measurements } = await ladderTrial(root, {
    leadPasses: true,
    poolPasses: () => 2,
  });
  const rec = recordShapeTrial(root, "forward", frozen, measurements);
  assert.equal(rec.evaluation.qualityDelta, 100, "the fixed-threshold view sees a win");
  assert.ok(rec.evaluation.ladder.level < 3);
  assert.equal(rec.decision, "revert");
});

test("ladder trial: pools on some tasks but not all are refused", async (t) => {
  const root = workspace(t);
  const { frozen, measurements } = await ladderTrial(root, {
    leadPasses: true,
    poolPasses: () => 0,
  });
  measurements.runs[0].pool = [];
  assert.throws(
    () => recordShapeTrial(root, "forward", frozen, measurements),
    /every frozen task an independent pool/,
  );
});
