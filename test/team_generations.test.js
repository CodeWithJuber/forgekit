// Recursive generations (src/team_generations.js; He et al., arXiv 2611.32606 §3, §4.3–4.4).
// No network and no model: hermetic receipts from the real harness loop, plus a seeded simulation
// of the generation loop's information structure.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyPlaybook,
  delegationPlan,
  recordShapeTrial,
  runDelegation,
} from "../src/harness_council.js";
import { runHarness } from "../src/harness_loop.js";
import { defaultHarnessPolicy } from "../src/harness_policy.js";
import { freezeSuite } from "../src/rollout_eval.js";
import {
  distillPlaybook,
  generationStatus,
  playbookHash,
  proposeGeneration,
  releaseDecision,
  releaseGeneration,
  teamHash,
} from "../src/team_generations.js";
import { rng } from "./_prng.js";

// ── distillation ──────────────────────────────────────────────────────────────────────

const budget = (tokens = 1000) => ({
  turns: 4,
  tokens,
  milliseconds: 4000,
  toolCalls: 4,
  costUsd: 0.5,
});
const report = (member, facts, tokens, b = budget()) => ({
  member,
  findings: Array.from({ length: facts }, (_, i) => ({
    finding: `${member} fact ${i}`,
    source: "s",
  })),
  usage: { tokens, milliseconds: tokens * 2, toolCalls: 0, costUsd: 0.01 },
  budget: b,
});
const derivedFrom = { suites: ["s0"], groups: ["g1", "g2"] };

test("distil: keep only roles that forwarded a fact; trim budgets to 1.25× the verified maximum", () => {
  const records = [
    {
      shape: "forward",
      reports: [report("a", 2, 200), report("b", 1, 300), report("idle", 0, 400)],
    },
    {
      shape: "forward",
      reports: [report("a", 1, 240), report("b", 1, 100), report("idle", 0, 380)],
    },
  ];
  const p = distillPlaybook({ taskClass: "c", generation: 1, records, derivedFrom });
  assert.deepEqual(
    p.roles.map((r) => r.id),
    ["a", "b"],
    "the idle role bought no information",
  );
  const a = p.roles.find((r) => r.id === "a").budget;
  assert.equal(a.tokens, 300, "⌈1.25 × 240⌉");
  assert.equal(a.milliseconds, 600, "⌈1.25 × 480⌉");
  assert.equal(a.toolCalls, 4, "a cap never used keeps its budget");
  assert.equal(a.turns, 4);
  assert.equal(a.costUsd, 0.0125);
  assert.deepEqual(p.hubOrder, ["a", "b"], "a forwards 3 facts / 440 tokens, b 2 / 400");
  assert.equal(p.parent, null);
});

test("distil: never above the parent's budget, never re-adds a role the parent dropped; deterministic", () => {
  const parent = distillPlaybook({
    taskClass: "c",
    generation: 1,
    records: [{ shape: "forward", reports: [report("a", 1, 100), report("b", 1, 100)] }],
    derivedFrom,
  });
  const next = distillPlaybook({
    taskClass: "c",
    generation: 2,
    parent,
    records: [
      { shape: "forward", reports: [report("a", 1, 900), report("b", 1, 50), report("c", 3, 10)] },
    ],
    derivedFrom,
  });
  assert.equal(next.roles.find((r) => r.id === "a").budget.tokens, 125, "the parent's cap holds");
  assert.equal(next.roles.find((r) => r.id === "b").budget.tokens, 63);
  assert.ok(!next.roles.some((r) => r.id === "c"), "a role outside the parent is never added");
  assert.equal(next.parent, parent.hash);
  const again = distillPlaybook({
    taskClass: "c",
    generation: 2,
    parent,
    records: [
      { shape: "forward", reports: [report("b", 1, 50), report("a", 1, 900), report("c", 3, 10)] },
    ],
    derivedFrom: { suites: ["s0"], groups: ["g2", "g1"] },
  });
  assert.equal(again.hash, next.hash, "the same verified runs give the same playbook");
  // A store that sorts keys (Python json, sort_keys) must not change the hash.
  const sorted = JSON.parse(JSON.stringify(next, Object.keys(next).sort()));
  assert.equal(
    playbookHash({ ...next, roles: next.roles.map((r) => ({ budget: r.budget, id: r.id })) }),
    next.hash,
  );
  assert.equal(sorted.hash, next.hash);
});

// ── the release gate ──────────────────────────────────────────────────────────────────

const arm = (accepted, tokens, extra = {}) => ({ accepted, tokens, ...extra });

test("release: a clear paired accuracy gain releases; equal accuracy is flat", () => {
  const better = Array.from({ length: 30 }, (_, i) => ({
    parent: arm(i % 3 === 0, 100),
    candidate: arm(true, 100),
  }));
  const r = releaseDecision(better);
  assert.equal(r.released, true);
  assert.equal(r.basis, "accuracy");
  const same = Array.from({ length: 30 }, (_, i) => ({
    parent: arm(i % 2 === 0, 100),
    candidate: arm(i % 2 === 0, 100),
  }));
  assert.equal(releaseDecision(same).released, false);
  assert.match(releaseDecision(same).reason, /flat/);
});

test("release: with a pool, a cheaper team at equal accuracy is a gain in the equal-budget margin", () => {
  const pool = (k) => Array.from({ length: 6 }, (_, j) => arm(j < k, 100));
  const rows = Array.from({ length: 30 }, (_, i) => ({
    parent: arm(true, 500),
    candidate: arm(true, 300),
    pool: pool(1 + (i % 2)),
  }));
  const r = releaseDecision(rows);
  assert.equal(r.basis, "equal-budget margin");
  assert.deepEqual(r.nB, { parent: 5, candidate: 3 });
  assert.equal(r.released, true, r.reason);
  assert.equal(r.accuracy.candidate, r.accuracy.parent);
});

test("release: health gates block a costlier winner, a significant accuracy loss, wrong packages", () => {
  const winner = (tokC, extra = {}) =>
    Array.from({ length: 30 }, (_, i) => ({
      parent: arm(i % 3 === 0, 100),
      candidate: arm(true, tokC, extra),
    }));
  const costly = releaseDecision(winner(150));
  assert.equal(costly.released, false);
  assert.equal(costly.health.tokens, false);
  assert.match(costly.reason, /tokens/);
  assert.equal(releaseDecision(winner(100, { wrongPackages: 1 })).health.wrongPackages, false);
  // Much cheaper but loses accuracy on a third of the tasks: the margin may rise, health says no.
  const pool = Array.from({ length: 8 }, (_, j) => arm(j < 1, 100));
  const lossy = Array.from({ length: 30 }, (_, i) => ({
    parent: arm(true, 700),
    candidate: arm(i % 3 !== 0, 120),
    pool,
  }));
  const l = releaseDecision(lossy);
  assert.equal(l.health.accuracy, false);
  assert.equal(l.released, false);
});

test("release: pools on some tasks only, or smaller than the budget, are refused", () => {
  const pool = [arm(true, 100), arm(false, 100)];
  assert.throws(
    () =>
      releaseDecision([
        { parent: arm(true, 100), candidate: arm(true, 100), pool },
        { parent: arm(true, 100), candidate: arm(true, 100) },
      ]),
    /every confirmation task an independent pool/,
  );
  assert.throws(
    () =>
      releaseDecision(
        [1, 2].map(() => ({ parent: arm(true, 500), candidate: arm(true, 400), pool })),
      ),
    /at least 5 independent runs/,
  );
});

test("release: on pure noise the gate releases at about its nominal rate (≤ 8% of 200 seeded trials)", () => {
  const next = rng(308);
  let released = 0;
  for (let trial = 0; trial < 200; trial++) {
    const rows = Array.from({ length: 40 }, () => ({
      parent: arm(next() < 0.7, 1000),
      candidate: arm(next() < 0.7, 1000),
    }));
    if (releaseDecision(rows).released) released++;
  }
  assert.ok(released / 200 <= 0.08, `${released} of 200 noise candidates released`);
});

// ── a seeded generation loop ──────────────────────────────────────────────────────────
// Roles a, b, c each hold a decisive fact; `idle` holds none. A role's fact is forwarded only
// when its budget covers the task's need. MODELLING ASSUMPTION (stated, not measured): an agent
// spends need + 30% of whatever slack its budget leaves — so trimming budgets saves tokens.
// The pool is independent single agents, right 20% of the time. This exercises the loop's
// logic; it says nothing about how a real model behaves.

const ROLES = ["a", "b", "c", "idle"];
const SLACK = 0.3;
const LEAD = 400;
function taskRng(seed, task, salt) {
  return rng((seed * 1000003 + task * 7919 + salt * 104729) >>> 0);
}
/** One team run on task `t`: which roles forwarded, the tokens spent, the worker reports. */
function teamRun(team, seed, t, armSalt) {
  const reports = team.map(({ id, budget: b }) => {
    const need = 150 + Math.floor(100 * taskRng(seed, t, ROLES.indexOf(id) + 1)());
    const covered = b.tokens >= need;
    const used = covered ? Math.round(need + SLACK * (b.tokens - need)) : b.tokens;
    return {
      member: id,
      findings: id !== "idle" && covered ? [{ finding: `${id} fact`, source: "s" }] : [],
      usage: { tokens: used, milliseconds: used, toolCalls: 0, costUsd: 0 },
      budget: b,
    };
  });
  const forwarded = new Set(reports.filter((r) => r.findings.length).map((r) => r.member));
  const slip = taskRng(seed, t, 50 + armSalt)() < 0.01;
  return {
    accepted: ["a", "b", "c"].every((r) => forwarded.has(r)) && !slip,
    tokens: LEAD + reports.reduce((s, r) => s + r.usage.tokens, 0),
    record: { shape: "forward", reports },
  };
}
const poolFor = (seed, t) => {
  const next = taskRng(seed, t, 99);
  return Array.from({ length: 12 }, () => arm(next() < 0.2, 300));
};
const teamOf = (playbook) =>
  playbook ? playbook.roles : ROLES.map((id) => ({ id, budget: budget(1000) }));

function generationLoop(seed, rounds = 6, tasks = 40) {
  let current = null;
  let verified = Array.from({ length: tasks }, (_, t) => teamRun(teamOf(null), seed, t, 0))
    .filter((r) => r.accepted)
    .map((r) => r.record);
  const lineage = [];
  for (let round = 1; round <= rounds; round++) {
    const candidate = distillPlaybook({
      taskClass: "sim",
      generation: (current?.generation ?? 0) + 1,
      parent: current,
      records: verified,
      derivedFrom: { suites: [`s${round}`], groups: [] },
    });
    if (current && teamHash(candidate) === teamHash(current)) {
      lineage.push({ outcome: "fixed point" });
      break;
    }
    if (lineage.some((l) => l.team === teamHash(candidate))) {
      lineage.push({ outcome: "already judged" });
      break;
    }
    const suiteSeed = seed + 1000 * round; // a FRESH confirmation suite each round
    const rows = Array.from({ length: tasks }, (_, t) => {
      const p = teamRun(teamOf(current), suiteSeed, t, 1);
      const c = teamRun(teamOf(candidate), suiteSeed, t, 2);
      return { parent: p, candidate: c, pool: poolFor(suiteSeed, t) };
    });
    const v = releaseDecision(rows);
    lineage.push({
      outcome: v.released ? "released" : "flat",
      team: teamHash(candidate),
      gain: v.gain,
      tokens: v.tokens,
    });
    if (v.released) {
      current = candidate;
      verified = rows.filter((r) => r.candidate.accepted).map((r) => r.candidate.record);
    } else
      verified = [
        ...verified,
        ...rows.filter((r) => r.parent.accepted).map((r) => r.parent.record),
      ];
  }
  return { current, lineage };
}

test("simulation: generations climb on their own verified runs, with shrinking gains, then stop", () => {
  const { current, lineage } = generationLoop(2611);
  const released = lineage.filter((l) => l.outcome === "released");
  assert.ok(released.length >= 2, `only ${released.length} release(s): ${JSON.stringify(lineage)}`);
  assert.equal(lineage[0].outcome, "released", "G1 drops the idle role and the bloated budgets");
  assert.ok(released[0].gain > released[1].gain, "each generation gains less than the last");
  assert.ok(!current.roles.some((r) => r.id === "idle"));
  assert.ok(released.at(-1).tokens.candidate < released[0].tokens.parent, "the team got cheaper");
  assert.ok(
    ["flat", "fixed point", "already judged"].includes(lineage.at(-1).outcome) ||
      lineage.length === 6,
    "the loop stops once there is nothing left to gain",
  );
});

test("simulation: the climb holds across seeds (not one lucky draw)", () => {
  // Each team is judged once, so a seed whose G2 gain is too small to clear the gate on its one
  // fresh suite stops at G1 — the gate doing its job, not a failure. Hence "most seeds", not all.
  let recursive = 0;
  for (const seed of [1, 7, 42, 99, 2026]) {
    const { lineage } = generationLoop(seed);
    const released = lineage.filter((l) => l.outcome === "released");
    assert.equal(lineage[0].outcome, "released", `seed ${seed}: G1 is always a clear win here`);
    assert.ok(
      released.every((l) => l.gain <= released[0].gain),
      `seed ${seed}: the first gain is the largest`,
    );
    assert.ok(
      released.every((l) => l.tokens.candidate < l.tokens.parent),
      `seed ${seed}: every release is cheaper`,
    );
    if (released.length >= 2) recursive++;
  }
  assert.ok(recursive >= 4, `only ${recursive} of 5 seeds reached a second generation`);
});

// ── using a playbook ──────────────────────────────────────────────────────────────────

test("applyPlaybook keeps only the playbook's roles, caps budgets, orders by the hub; none = unchanged", () => {
  const workers = ["c", "a", "x"].map((id) => ({ id, budget: budget(1000) }));
  const playbook = {
    roles: [
      { id: "a", budget: budget(200) },
      { id: "c", budget: budget(5000) },
    ],
    hubOrder: ["c", "a"],
  };
  const out = applyPlaybook(workers, playbook);
  assert.deepEqual(
    out.map((w) => w.id),
    ["c", "a"],
  );
  assert.equal(out.find((w) => w.id === "a").budget.tokens, 200);
  assert.equal(
    out.find((w) => w.id === "c").budget.tokens,
    1000,
    "a playbook never raises a budget",
  );
  assert.equal(applyPlaybook(workers, null), workers);
});

// ── end to end on real harness receipts ───────────────────────────────────────────────

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "forge-generations-"));
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
const receipt = (root, id, task, acceptance, ok) =>
  runHarness({
    root,
    request: { id, task, acceptance: [acceptance], profile: "reviewer" },
    policy: defaultHarnessPolicy(),
    tools: [],
    budget: { repairs: 0 },
    model: async () => ({ finalText: "done", tokens: 4, costUsd: 0 }),
    verify: async () => ({ ok, output: ok ? "all passed" : "failed", command: "fixture checks" }),
  });
const suite = (prefix) =>
  freezeSuite({
    version: 1,
    purpose: "parallel",
    baseline: "base team",
    candidate: "next team",
    controls: "Same suite, verified fixture",
    tasks: Array.from({ length: 20 }, (_, i) => ({
      id: `t-${i}`,
      repo: "repo",
      revision: "a1",
      task: `${prefix} ${i}`,
      acceptance: "suite passes",
    })),
  });
const worker = (id, i) => ({
  id,
  profile: "reviewer",
  route: `route-${i}`,
  task: `Read slice ${id}`,
  acceptance: ["Evidence attached"],
  scopes: [id],
  evidence: "A test run",
  returnFormat: "JSON fields",
  escalation: "Report to lead",
  budget: { turns: 4, tokens: 1000, milliseconds: 4000, toolCalls: 4, costUsd: 0 },
  facts: [`fact-${id}`],
});
const WORKERS = ["code", "ops", "audit", "idle"].map(worker);
const spec = (idValue, task, extra = {}) => ({
  id: idValue,
  shape: "forward",
  trial: true,
  task,
  acceptance: ["Reproducible evidence"],
  budget: { turns: 20, tokens: 4000, milliseconds: 25000, toolCalls: 20, costUsd: 0 },
  workers: WORKERS,
  ...extra,
});
/** A fake worker: `idle` finds nothing (it must say so as a blocker); the others forward a fact. */
const fakeWorker = async (req) => ({
  status: "done",
  evidence: { ok: true },
  usage: { tokens: 2, costUsd: 0, toolCalls: 0, milliseconds: 5 },
  answer: JSON.stringify(
    req.actor === "idle"
      ? { findings: [], verdict: "nothing", blocker: "nothing in my slice" }
      : {
          findings: [{ finding: `${req.actor} fact`, source: `fact-${req.actor}` }],
          verdict: "forwarded",
          blocker: null,
        },
  ),
});
const fullArm = {
  seconds: 10,
  tokens: 60,
  costUsd: 0,
  toolCalls: 3,
  newDuplicates: 0,
  wrongPackages: 0,
  quality: 70,
  accepted: true,
};

/** Generation 0: a recorded forward shape trial — the base team's verified runs. */
async function seedBase(root) {
  const base = suite("map the retry path");
  const runs = [];
  for (const task of base.spec.tasks) {
    await receipt(root, `b-${task.id}`, task.task, task.acceptance, false);
    await receipt(root, `l-${task.id}`, task.task, task.acceptance, true);
    await runDelegation(root, spec(`g0-${task.id}`, task.task), fakeWorker);
    runs.push({
      id: task.id,
      baseline: { ...fullArm, evidence: `run:b-${task.id}` },
      candidate: { ...fullArm, evidence: `run:l-${task.id}`, group: `g0-${task.id}` },
    });
  }
  recordShapeTrial(root, "forward", base, { suiteHash: base.hash, source: "observed", runs });
  return base;
}
/** One confirmation round on a fresh suite: both arms are team runs, plus an independent pool. */
async function confirmRound(root, prefix, playbook, candidateLands = true) {
  const confirm = suite(prefix);
  const runs = [];
  for (const task of confirm.spec.tasks) {
    const id = `${prefix.length}-${task.id}`;
    await receipt(root, `p-${id}`, task.task, task.acceptance, true);
    await receipt(root, `c-${id}`, task.task, task.acceptance, candidateLands);
    await runDelegation(root, spec(`gp-${id}`, task.task), fakeWorker);
    await runDelegation(root, spec(`gc-${id}`, task.task, { playbook }), fakeWorker);
    const pool = [];
    for (let j = 0; j < 3; j++) {
      await receipt(root, `pool-${id}-${j}`, task.task, task.acceptance, j === 0);
      pool.push({ evidence: `run:pool-${id}-${j}` });
    }
    runs.push({
      id: task.id,
      parent: { evidence: `run:p-${id}`, group: `gp-${id}` },
      candidate: { evidence: `run:c-${id}`, group: `gc-${id}` },
      pool,
    });
  }
  return { confirm, measurements: { suiteHash: confirm.hash, source: "observed", runs } };
}

test("end to end: propose from the base team's verified runs, release on a fresh suite", async (t) => {
  const root = workspace(t);
  const base = await seedBase(root);
  assert.equal(generationStatus(root, "default").generation, 0);
  const { candidate } = proposeGeneration(root, "default");
  assert.deepEqual(
    candidate.roles.map((r) => r.id),
    ["audit", "code", "ops"],
    "idle dropped",
  );
  assert.equal(candidate.roles[0].budget.tokens, 3, "⌈1.25 × 2⌉");
  assert.equal(generationStatus(root, "default").pending.hash, candidate.hash);

  // A playbook narrows a delegation only when asked to.
  assert.equal(delegationPlan(root, spec("x", "plan only")).workers.length, 4);
  assert.equal(
    delegationPlan(root, spec("x", "plan only", { playbook: candidate.hash })).workers.length,
    3,
  );
  assert.throws(
    () => delegationPlan(root, spec("x", "plan only", { playbook: "f".repeat(40) })),
    /Unknown playbook/,
  );
  assert.throws(
    () => delegationPlan(root, spec("x", "plan only", { shape: "parallel", playbook: "current" })),
    /forward shape/,
  );

  const { confirm, measurements } = await confirmRound(
    root,
    "confirm the ownership check",
    candidate.hash,
  );
  // The suite the candidate was learned from can never judge it.
  assert.throws(
    () => releaseGeneration(root, "default", base, { ...measurements, suiteHash: base.hash }),
    /must be fresh/,
  );
  // An arm whose team ran a different playbook is refused.
  const swapped = {
    ...measurements,
    runs: measurements.runs.map((r) => ({ ...r, candidate: r.parent, parent: r.candidate })),
  };
  assert.throws(
    () => releaseGeneration(root, "default", confirm, swapped),
    /parent arm must be a team run/,
  );

  const rec = releaseGeneration(root, "default", confirm, measurements);
  assert.equal(rec.outcome, "released", rec.round.reason);
  assert.equal(rec.round.basis, "equal-budget margin");
  assert.ok(rec.round.tokens.candidate < rec.round.tokens.parent, "the candidate team is cheaper");
  assert.equal(rec.generation, 1);
  assert.equal(rec.recursive, false, "one release is not recursion");
  const status = generationStatus(root, "default");
  assert.equal(status.playbook.hash, candidate.hash);
  assert.equal(status.pending, null);
  assert.equal(status.lineage.length, 1);
  assert.equal(
    delegationPlan(root, spec("y", "plan only", { playbook: "current" })).workers.length,
    3,
  );

  // Its own verified runs give the same team back: nothing left to learn, nothing to judge.
  assert.match(proposeGeneration(root, "default").reason, /Nothing left to learn/);
  assert.throws(
    () => releaseGeneration(root, "default", confirm, measurements),
    /No pending candidate/,
  );
});

test("end to end: a flat team keeps the parent and is never judged again", async (t) => {
  const root = workspace(t);
  await seedBase(root);
  const { candidate } = proposeGeneration(root, "default");
  const round = await confirmRound(root, "a round the candidate loses", candidate.hash, false);
  const rec = releaseGeneration(root, "default", round.confirm, round.measurements);
  assert.equal(rec.outcome, "flat", rec.round.reason);
  assert.equal(rec.generation, 0);
  assert.equal(rec.playbook, null, "the base team stays");
  assert.equal(
    generationStatus(root, "default").pending,
    null,
    "a judged team is no longer pending",
  );
  // More verified runs of the same team distil to the same candidate: refused, not re-tried.
  assert.match(proposeGeneration(root, "default").reason, /already judged flat/);
  const again = await confirmRound(root, "another fresh suite to try it on", candidate.hash);
  assert.throws(
    () => releaseGeneration(root, "default", again.confirm, again.measurements),
    /No pending candidate/,
  );
});
