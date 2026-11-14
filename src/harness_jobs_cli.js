// CLI adapter only. Cron, webhooks and conditions enqueue; only "work" calls the host.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  conveneCouncil,
  delegationPlan,
  getCouncil,
  recordShapeTrial,
  runDelegation,
  shapeDecision,
  synthesizeCouncil,
} from "./harness_council.js";
import { verifyHarnessWebhook } from "./harness_gateway.js";
import {
  dispatchNext,
  enqueueJob,
  enqueueTrigger,
  findJob,
  jobHistory,
  listJobs,
  queueMetrics,
  releaseJob,
  tickSchedules,
} from "./harness_jobs.js";
import { readHarnessRun } from "./harness_trace.js";

function input(root, name, limit = 4 * 1024 * 1024) {
  const target = resolve(root, name);
  // Canonical parents support macOS /var aliases; the input itself may never be
  // a symlink, device or pipe. Never trust a changing file's original size.
  const canonicalTarget = join(realpathSync.native(dirname(target)), basename(target));
  if (lstatSync(canonicalTarget).isSymbolicLink())
    throw new Error("Linked job inputs are unsupported");
  const fd = openSync(
    canonicalTarget,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > limit)
      throw new Error("Input must be a bounded, single-linked regular file");
    const bytes = Buffer.alloc(st.size);
    let pos = 0;
    while (pos < bytes.length) {
      const count = readSync(fd, bytes, pos, bytes.length - pos, null);
      if (!count) throw new Error("Job input changed while being read");
      pos += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null))
      throw new Error("Job input grew while being read");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export async function handleHarnessJobs(root, group, argv, { config, run }) {
  const [action, ...args] = argv;
  const json = (name) => JSON.parse(input(root, name).toString("utf8"));
  if (group === "council") {
    if (action === "run" && args.length === 1) return runDelegation(root, json(args[0]), run);
    if (action === "plan" && args.length === 1) return delegationPlan(root, json(args[0]));
    if (action === "convene" && args.length === 1) return conveneCouncil(root, json(args[0]), run);
    if (action === "synthesize" && args.length === 1) return synthesizeCouncil(root, json(args[0]));
    if (action === "get" && args.length === 1) return getCouncil(root, args[0]);
    if (action === "status" && [1, 2].includes(args.length))
      return shapeDecision(root, args[0], args[1] ?? "default");
    if (action === "trial" && [3, 4].includes(args.length))
      return recordShapeTrial(root, args[0], json(args[1]), json(args[2]), {
        taskClass: args[3] ?? "default",
      });
    throw new Error(
      "council: plan|run|convene|synthesize <spec.json>, get <id>, status <shape> [class], trial <shape> <frozen.json> <observations.json> [class]",
    );
  }
  if (group !== "jobs") throw new Error("Expected jobs or council");
  if (action === "metrics" && !args.length) return queueMetrics(root);
  if (action === "list" && !args.length) return listJobs(root);
  if (action === "tick" && !args.length) return tickSchedules(root, config.jobs);
  if (action === "release" && args.length === 1) return releaseJob(root, args[0]);
  if (action === "show" && args.length === 1)
    return { job: findJob(root, args[0]), events: jobHistory(root, args[0]) };
  if (action === "enqueue" && args.length === 1) return enqueueJob(root, json(args[0]));
  if (action === "work" && !args.length)
    return dispatchNext(root, (request, opts) => {
      if (opts.resume) {
        try {
          readHarnessRun(root, request.id);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          // A previous lease may have died before the first horizon was persisted.
          return run(request, { ...opts, resume: false });
        }
      }
      return run(request, opts);
    });
  if ((action === "webhook" && args.length === 5) || (action === "trigger" && args.length === 3)) {
    const kind = action === "trigger" ? "condition" : "webhook";
    const definitions = config.jobs?.triggers ?? [];
    const found = definitions.filter((d) => d.name === args[0] && d.kind === kind);
    if (found.length !== 1 || found[0].enabled === false)
      throw new Error("Unknown, disabled or duplicate trigger");
    const def = found[0];
    if (kind === "condition")
      return enqueueTrigger(root, def, json(args[2]), { deliveryId: args[1] });
    if (typeof def.secretEnv !== "string" || !/^[A-Z_][A-Z0-9_]{0,100}$/.test(def.secretEnv))
      throw new Error("Configure this webhook's secretEnv");
    const raw = input(root, args[4], 65536);
    const verified = verifyHarnessWebhook({
      body: raw,
      timestamp: args[2],
      id: args[1],
      signature: args[3],
      secret: process.env[def.secretEnv],
      actor: def.owner,
    });
    return enqueueTrigger(
      root,
      def,
      { task: verified.task, acceptance: verified.acceptance },
      { deliveryId: verified.id, authenticated: true },
    );
  }
  throw new Error(
    "jobs: list|metrics|tick|work, show|release <id>, enqueue <job.json>, trigger <name> <event-id> <payload.json>, webhook <name> <delivery-id> <epoch-seconds> <sha256=hex> <body.json>",
  );
}
