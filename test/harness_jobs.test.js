import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dispatchNext,
  enqueueJob,
  enqueueTrigger,
  jobHistory,
  listJobs,
  queueStore,
  releaseJob,
  tickSchedules,
} from "../src/harness_jobs.js";

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "forge-queue-"));
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
test("a 3am schedule defers an approval, releases no effects and resumes its original run", async (t) => {
  const root = workspace(t),
    now = Date.UTC(2026, 10, 14, 3);
  const jobs = [
    { name: "nightly", cron: "0 3 * * *", profile: "maintainer", task: "Check nightly report" },
  ];
  const [queued] = tickSchedules(root, jobs, { now });
  assert.deepEqual(tickSchedules(root, jobs, { now }), []);
  let approved = false,
    sent = 0;
  const run = async (req, { resume }) => {
    assert.equal(req.background, true);
    assert.equal(req.id, queued.id);
    assert.equal(req.channel, "schedule");
    if (!approved) return { status: "approval_pending", approval: { id: "approval-for-nightly" } };
    assert.equal(resume, true);
    sent++;
    return { status: "done" };
  };
  const pending = await dispatchNext(root, run, { now });
  assert.equal(pending.state, "awaiting_approval");
  assert.equal(pending.approval.id, "approval-for-nightly");
  assert.equal(await dispatchNext(root, run, { now }), null);
  assert.equal(sent, 0);
  approved = true;
  releaseJob(root, queued.id, { now });
  assert.equal((await dispatchNext(root, run, { now })).state, "done");
  assert.equal(sent, 1);
});
test("priority and aged P3, idempotency conflict, lease fencing, backoff and ambiguous effects", async (t) => {
  const root = workspace(t),
    day = 86400000;
  const task = (key, priority, now) =>
    enqueueJob(root, { key, request: { task: key }, priority }, { now });
  const old = task("optional", "P3", 0);
  assert.equal(task("optional", "P3", 0).id, old.id);
  assert.throws(() => task("optional", "P2", 1), /different work/);
  const same = task("event", "P2", day),
    urgent = task("incident", "P0", day);
  const claim = (token, now) => queueStore(root, "claim", { token, now, leaseMs: 1000 });
  assert.equal(claim("lease1", day).id, urgent.id);
  const replacement = claim("lease2", day + 1001);
  assert.equal(replacement.id, urgent.id);
  assert.equal(replacement.resume, true);
  assert.throws(
    () =>
      queueStore(root, "finish", {
        id: urgent.id,
        token: "lease1",
        status: "done",
        now: day + 1002,
      }),
    /stale worker/,
  );
  queueStore(root, "finish", {
    id: urgent.id,
    token: "lease2",
    status: "interrupted",
    reason: "Ambiguous effect",
    approval: null,
    now: day + 1002,
  });
  assert.equal(listJobs(root).find((j) => j.id === urgent.id).state, "dead_letter");
  assert.ok(jobHistory(root, urgent.id).some((e) => e.event === "lease_expired"));
  assert.equal(
    (await dispatchNext(root, async () => ({ status: "done" }), { now: day + 1003 })).id,
    old.id,
  );
  const failed = await dispatchNext(
    root,
    async () => {
      throw Error("offline");
    },
    { now: day + 1004 },
  );
  assert.equal(failed.id, same.id);
  assert.equal(failed.state, "queued");
  assert.equal(await dispatchNext(root, async () => assert.fail(), { now: day + 1005 }), null);
});
test("cron recovery bounded and atomic across repeated ticks, triggers owner/rate/delivery scoped", async (t) => {
  const root = workspace(t),
    base = Date.UTC(2026, 0, 1);
  const jobs = ["skip", "run_once", "catch_up"].map((name) => ({
    name,
    task: "Review queue",
    cron: "*/2 * * * *",
    missed_runs: name,
  }));
  assert.equal(tickSchedules(root, jobs, { now: base }).length, 3);
  const recovered = tickSchedules(root, jobs, { now: base + 41 * 60000 });
  assert.equal(recovered.filter((j) => j.key.includes("catch_up")).length, 16);
  assert.equal(recovered.filter((j) => j.key.includes("run_once")).length, 1);
  assert.equal(recovered.filter((j) => j.key.includes("skip")).length, 0);
  assert.deepEqual(tickSchedules(root, jobs, { now: base + 41 * 60000 }), []);
  const def = {
    name: "ops",
    owner: "team",
    kind: "webhook",
    task: "Summarize the event",
    perMinute: 1,
  };
  const data = { task: "malicious replacement", actor: "boss" };
  assert.throws(
    () => enqueueTrigger(root, def, data, { deliveryId: "A", now: base }),
    /Authenticated/,
  );
  const opts = { authenticated: true, deliveryId: "A", now: base };
  const one = enqueueTrigger(root, def, data, opts);
  assert.equal(enqueueTrigger(root, def, data, opts).id, one.id);
  assert.throws(() => enqueueTrigger(root, def, data, { ...opts, deliveryId: "B" }), /rate limit/);
  assert.throws(() => enqueueTrigger(root, { ...def, enabled: false }, data, opts), /disabled/);
  assert.throws(
    () => tickSchedules(root, [{ ...jobs[0], cron: "*/0 * * * *" }], { now: base }),
    /out of range/,
  );
});

test("a monetary ceiling pauses that queue class until UTC rollover or explicit release", async (t) => {
  const root = workspace(t),
    now = Date.UTC(2026, 10, 14, 23, 30);
  const add = (key, priority, at) =>
    enqueueJob(root, { key, request: { task: `budget ${key}` }, priority }, { now: at });
  const first = add("one", "P2", now);
  add("two", "P2", now + 1);
  const daily = await dispatchNext(
    root,
    async () => ({ status: "budget_exhausted", reason: "daily_spend_ceiling" }),
    { now: now + 2 },
  );
  assert.equal(daily.id, first.id);
  assert.equal(daily.state, "queued");
  assert.equal(await dispatchNext(root, () => assert.fail(), { now: now + 3 }), null);
  const urgent = add("urgent", "P1", now + 3);
  assert.equal(
    (await dispatchNext(root, async () => ({ status: "done" }), { now: now + 4 })).id,
    urgent.id,
  );
  const tomorrow = Date.UTC(2026, 10, 15, 0, 1);
  const project = await dispatchNext(
    root,
    async () => ({ status: "budget_exhausted", reason: "project_spend_ceiling" }),
    { now: tomorrow },
  );
  assert.equal(project.state, "budget_paused");
  assert.equal(await dispatchNext(root, () => assert.fail(), { now: tomorrow + 86400000 }), null);
  releaseJob(root, project.id, { now: tomorrow + 5 });
  assert.equal(
    (await dispatchNext(root, async () => ({ status: "done" }), { now: tomorrow + 8 })).state,
    "done",
  );
});

test("signed webhook intake queues once; the CLI worker resumes the same real harness approval", async (t) => {
  const { handleHarnessJobs } = await import("../src/harness_jobs_cli.js");
  const { runHarness } = await import("../src/harness_loop.js");
  const { approvalStore, defaultHarnessPolicy } = await import("../src/harness_policy.js");
  const { createHarnessTools } = await import("../src/harness_tools.js");
  const { createHmac } = await import("node:crypto");
  const { existsSync, writeFileSync, readFileSync } = await import("node:fs");
  const root = workspace(t);
  const name = "FORGE_QUEUE_FIXTURE_KEY",
    before = process.env[name];
  process.env[name] = `local-fixture-signature-key${".".repeat(32)}`;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
  const config = {
    jobs: {
      triggers: [
        {
          name: "incoming",
          owner: "review-ops",
          kind: "webhook",
          secretEnv: name,
          profile: "coder",
          task: "Write bounded report",
          acceptance: ["file matches"],
          perMinute: 1,
        },
      ],
    },
  };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ task: "Review event", actor: "superuser", profile: "admin" });
  const sig = `sha256=${createHmac("sha256", process.env[name]).update(`${timestamp}.delivery.${body}`).digest("hex")}`;
  writeFileSync(join(root, "payload.json"), body);
  const invoke = async (args, run = () => assert.fail()) =>
    handleHarnessJobs(root, "jobs", args, { config, run });
  const invalid = [
    "webhook",
    "incoming",
    "delivery",
    timestamp,
    `sha256=${"0".repeat(64)}`,
    "payload.json",
  ];
  await assert.rejects(invoke(invalid), /authentication failed/);
  const args = ["webhook", "incoming", "delivery", timestamp, sig, "payload.json"];
  const job = await invoke(args);
  assert.equal((await invoke(args)).id, job.id);
  const policy = defaultHarnessPolicy();
  policy.profiles.coder.tools.write_file = "approval";
  const filename = join(root, "nightly.txt");
  let calls = 0;
  const verify = async () => ({
    ok: existsSync(filename) && readFileSync(filename, "utf8") === "written",
    output: "receipt",
    command: "read nightly.txt",
  });
  const model = async () =>
    calls++ === 0
      ? {
          toolCalls: [
            {
              name: "write_file",
              args: { path: "nightly.txt", expectedSha256: null, content: "written" },
            },
          ],
          tokens: 6,
          costUsd: 0,
        }
      : { finalText: "completed", tokens: 3, costUsd: 0 };
  const run = async (request, opts) => {
    assert.equal(request.actor, "review-ops");
    assert.equal(request.profile, "coder");
    assert.equal(request.task, "Write bounded report");
    return runHarness({
      root,
      request,
      model,
      verify,
      tools: createHarnessTools(),
      policy,
      signal: opts.signal,
      resume: opts.resume ? request.id : undefined,
    });
  };
  const pending = await invoke(["work"], run);
  assert.equal(pending.state, "awaiting_approval");
  assert.equal(existsSync(filename), false);
  await invoke(["release", job.id]);
  assert.equal((await invoke(["work"], run)).state, "awaiting_approval");
  assert.equal(existsSync(filename), false);
  approvalStore(root).grant(pending.approval.id);
  await invoke(["release", job.id]);
  assert.equal((await invoke(["work"], run)).state, "done");
  assert.equal(readFileSync(filename, "utf8"), "written");
  const metrics = await invoke(["metrics"]);
  assert.equal(metrics.withCostReceipts, 1);
  assert.equal(metrics.verifiedTasks, 1);
  assert.equal(metrics.costPerVerifiedTaskUsd, 0);
});

test("queue rejects linked private database and aliased worktree namespaces", {
  skip: process.platform === "win32",
}, async (t) => {
  const { symlinkSync, writeFileSync } = await import("node:fs");
  const { contentHash } = await import("../src/util.js");
  const { realpathSync } = await import("node:fs");
  const root = workspace(t),
    base = process.env.FORGE_HOME;
  const owner = join(base, "harness-jobs");
  mkdirSync(owner, { recursive: true });
  const ns = join(owner, contentHash(realpathSync(root)));
  const other = join(base, "unrelated");
  mkdirSync(other);
  symlinkSync(other, ns);
  assert.throws(() => listJobs(root), /namespace/);
  rmSync(ns);
  mkdirSync(ns);
  const victim = join(base, "elsewhere");
  writeFileSync(victim, "private");
  symlinkSync(victim, join(ns, "jobs.sqlite3"));
  assert.throws(() => listJobs(root), /regular file/);
  const { handleHarnessJobs } = await import("../src/harness_jobs_cli.js");
  symlinkSync(victim, join(root, "job.json"));
  await assert.rejects(
    handleHarnessJobs(root, "jobs", ["enqueue", "job.json"], {
      config: { jobs: {} },
      run: () => {},
    }),
    /Linked/,
  );
});
