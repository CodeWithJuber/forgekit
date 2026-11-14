// The queue holds requests. Only the caller's normal harness runner can execute them.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedHarnessPython } from "./harness_python.js";
import { outsideWorkspace, physicalPath } from "./private_paths.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { contentHash, userStateDir } from "./util.js";

const service = fileURLToPath(new URL("./harness_jobs_store.py", import.meta.url));
export function queueStore(root, op, data = {}) {
  const project = sourceWorkspaceRoot(root);
  const privateRoot = outsideWorkspace(
    project,
    userStateDir(),
    "FORGE_HOME must be outside the working tree",
  );
  const directory = join(privateRoot, "harness-jobs", contentHash(project));
  if (physicalPath(directory) !== directory)
    throw new Error("Queue workspace namespace cannot point to another directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const stat = lstatSync(join(directory, `jobs.sqlite3${suffix}`), { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1))
      throw new Error("Queue database must be a private regular file");
  }
  const input = JSON.stringify({ op, data });
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error("Queue input exceeds 8 MiB");
  const exec = spawnSync(installedHarnessPython(project), ["-I", "-B", service, directory], {
    input,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (exec.error) throw new Error(`Queue needs Python 3 with sqlite3: ${exec.error.message}`);
  if (exec.status !== 0)
    throw new Error(exec.stderr.trim().slice(0, 600) || "Queue transaction failed");
  return JSON.parse(exec.stdout);
}

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const IDENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
function ident(text, field) {
  if (typeof text !== "string" || !IDENT.test(text)) throw new Error(`Invalid ${field}`);
  return text;
}
function integer(n, min, max, field) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${field}`);
  return n;
}
function queueRequest({
  key,
  request,
  priority = request?.priority ?? "P2",
  maxAttempts = 3,
  availableAt = 0,
}) {
  ident(key, "job key");
  if (
    !request ||
    typeof request.task !== "string" ||
    !request.task.trim() ||
    request.task.length > 16384 ||
    Buffer.byteLength(JSON.stringify(request)) > 32768 ||
    hasSecret(request.task)
  )
    throw new Error("Job needs a bounded, non-secret task");
  const keys = new Set([
    "task",
    "acceptance",
    "profile",
    "channel",
    "actor",
    "budget",
    "triggerEvidence",
  ]);
  for (const key of Object.keys(request))
    if (!keys.has(key)) throw new Error(`Unsupported job request field: ${key}`);
  for (const key of ["profile", "channel", "actor"])
    if (request[key] !== undefined) ident(request[key], key);
  if (hasSecret(JSON.stringify(request)))
    throw new Error("Job request contains secret-shaped material");
  if (!PRIORITIES.includes(priority)) throw new Error("Priority must be P0–P3");
  if (
    request.acceptance !== undefined &&
    (!Array.isArray(request.acceptance) ||
      request.acceptance.length > 32 ||
      request.acceptance.some(
        (a) => typeof a !== "string" || !a.trim() || a.length > 2000 || hasSecret(a),
      ))
  )
    throw new Error("Invalid job acceptance criteria");
  return {
    key,
    request: { ...request, priority, background: true },
    priority: PRIORITIES.indexOf(priority),
    maxAttempts: integer(maxAttempts, 1, 10, "attempt limit"),
    availableAt: integer(availableAt, 0, Number.MAX_SAFE_INTEGER, "availability"),
  };
}

export function enqueueJob(root, input, { now = Date.now() } = {}) {
  return queueStore(root, "enqueue", { job: queueRequest(input), now });
}
export function listJobs(root, { limit = 50 } = {}) {
  return queueStore(root, "list", { limit: integer(limit, 1, 200, "list limit") });
}
export function queueMetrics(root) {
  return queueStore(root, "metrics");
}
export function findJob(root, id) {
  return queueStore(root, "lookup", { id: ident(id, "job ID") });
}
export function jobHistory(root, id) {
  return queueStore(root, "history", { id: ident(id, "job ID") });
}
export function releaseJob(root, id, { now = Date.now() } = {}) {
  return queueStore(root, "release", { id: ident(id, "job ID"), now });
}
export function tickSchedules(root, definitions, { now = Date.now() } = {}) {
  const jobs = Array.isArray(definitions) ? definitions : definitions?.jobs;
  if (!Array.isArray(jobs) || jobs.length > 100)
    throw new Error("jobs must be an array of at most 100 schedules");
  const names = new Set();
  const schedules = jobs.map((j) => {
    const name = ident(j.name, "schedule name");
    if (names.has(name)) throw new Error("Duplicate schedule name");
    names.add(name);
    if (
      typeof j.cron !== "string" ||
      j.cron.length > 150 ||
      !["run_once", "skip", "catch_up"].includes(j.missed_runs ?? "run_once")
    )
      throw new Error("Invalid cron or missed_runs");
    const request = {
      task: j.task,
      channel: "schedule",
      actor: j.owner ?? "scheduler",
      profile: j.profile ?? "reviewer",
      ...(j.acceptance ? { acceptance: j.acceptance } : {}),
      ...(j.budget ? { budget: j.budget } : {}),
    };
    return {
      name,
      cron: j.cron,
      missed: j.missed_runs ?? "run_once",
      enabled: j.enabled !== false,
      job: queueRequest({ key: name, request, priority: j.priority, maxAttempts: j.maxAttempts }),
    };
  });
  return queueStore(root, "tick", { schedules, now });
}

// The transport verifies the signature before passing authenticated=true. Incoming
// payloads can supply evidence, never a profile, tool permission, command or budget.
export function enqueueTrigger(
  root,
  def,
  payload,
  { deliveryId = undefined, authenticated = false, now = Date.now() } = {},
) {
  const name = ident(def?.name, "trigger name"),
    owner = ident(def.owner, "trigger owner");
  if (def.enabled === false) throw new Error("Trigger disabled");
  if (!["webhook", "condition"].includes(def.kind) || (def.kind === "webhook" && !authenticated))
    throw new Error("Authenticated webhook or local condition required");
  if (typeof deliveryId !== "string" || !deliveryId.trim() || deliveryId.length > 200)
    throw new Error("Stable delivery ID required");
  const json = JSON.stringify(payload);
  if (typeof json !== "string" || Buffer.byteLength(json) > 8192 || hasSecret(json))
    throw new Error("Trigger evidence must be bounded and non-secret");
  const job = queueRequest({
    key: contentHash(`${name}\0${deliveryId}`),
    priority: def.priority,
    request: {
      actor: owner,
      profile: def.profile ?? "reviewer",
      channel: def.kind === "webhook" ? "webhook" : "schedule",
      task: def.task,
      acceptance: def.acceptance,
      budget: def.budget,
      triggerEvidence: { name, certainty: "L2", data: payload },
    },
  });
  return queueStore(root, "trigger", {
    name,
    job,
    now,
    limit: integer(def.perMinute ?? 5, 1, 1000, "trigger rate"),
  });
}

export async function dispatchNext(root, run, { now = undefined, leaseMs = 60000 } = {}) {
  const clock = () => now ?? Date.now();
  integer(leaseMs, 1000, 3600000, "lease duration");
  const token = randomUUID();
  const job = queueStore(root, "claim", { now: clock(), leaseMs, token });
  if (!job) return null;
  const controller = new AbortController();
  const heartbeat = setInterval(
    () => {
      try {
        if (!queueStore(root, "pulse", { id: job.id, now: clock(), leaseMs, token }))
          controller.abort();
      } catch {
        controller.abort();
      }
    },
    Math.max(250, Math.floor(leaseMs / 3)),
  );
  heartbeat.unref();
  let status,
    reason,
    approval = null,
    amount = null,
    verified = false;
  try {
    const outcome = await run(
      { ...job.request, id: job.id },
      { resume: job.resume, signal: controller.signal },
    );
    status = outcome?.status ?? "invalid_result";
    const spend = outcome?.usage?.costUsd;
    if (Number.isFinite(spend) && spend >= 0) amount = spend;
    verified =
      status === "done" &&
      outcome?.evidence?.ok === true &&
      outcome?.certainty?.verification === "L3";
    reason = redactSecrets(String(outcome?.reason ?? status)).slice(0, 500);
    approval = outcome?.approval ?? null;
  } catch {
    status = "dispatch_error";
    reason = "Runner unavailable; reconcile the prior trace before retry";
  } finally {
    clearInterval(heartbeat);
  }
  return queueStore(root, "finish", {
    id: job.id,
    token,
    status,
    reason,
    approval,
    amount,
    verified,
    now: clock(),
  });
}
