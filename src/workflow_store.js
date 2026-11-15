import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claimHarnessLease, harnessDigest } from "./harness_trace.js";
import {
  parseWorkflowReport,
  sameWorkflowCheckout,
  WORKFLOW_ROUTES,
  workflowInput,
  workflowStage,
  workflowText,
} from "./workflow_contract.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

export function workflowDirectory(root, id) {
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
  )
    throw new Error("Invalid workflow ID");
  return join(privateWorkspaceFile(root, "workflows").replace(/\.json$/, ""), id);
}

function readJson(file, limit = 2 * 1024 * 1024) {
  const fd = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > limit ||
      realpathSync.native(file) !== file
    )
      throw new Error("Workflow input must be a private bounded regular file");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) throw new Error("Workflow input changed while reading");
      offset += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null))
      throw new Error("Workflow input changed while reading");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    closeSync(fd);
  }
}

function validateState(state, id) {
  if (
    state?.version !== 1 ||
    state.id !== id ||
    !["ready", "running", "approval_pending", "blocked", "done"].includes(state.status)
  )
    throw new Error("Invalid workflow state");
  const { size } = workflowInput(state);
  if (!sameWorkflowCheckout(state.baseline, state.baseline))
    throw new Error("Invalid workflow checkout binding");
  if (!Array.isArray(state.stages) || state.stages.length !== WORKFLOW_ROUTES[size].length)
    throw new Error("Invalid workflow route");
  for (const [i, stage] of state.stages.entries()) {
    if (
      stage.name !== WORKFLOW_ROUTES[size][i] ||
      !["pending", "running", "completed", "skipped", "approval_pending", "blocked"].includes(
        stage.status,
      ) ||
      !Array.isArray(stage.attempts) ||
      stage.attempts.length > 3
    )
      throw new Error("Invalid workflow stage record");
    const definition = workflowStage(stage.name);
    if (stage.feedback !== null) workflowText(stage.feedback, "workflow retry reason", 1000);
    for (const [n, attempt] of stage.attempts.entries()) {
      if (attempt.runId !== `wf-${id}-${stage.name}-${n + 1}`)
        throw new Error("Invalid workflow run binding");
      if (
        attempt.request?.id !== attempt.runId ||
        attempt.request.profile !== definition.profile ||
        attempt.request.channel !== "cli" ||
        attempt.request.actor !== "local" ||
        attempt.request.priority !== "P1" ||
        JSON.stringify(attempt.request.acceptance) !== JSON.stringify(state.acceptance) ||
        !sameWorkflowCheckout(attempt.before, attempt.before) ||
        (attempt.checkout && !sameWorkflowCheckout(attempt.checkout, attempt.checkout))
      )
        throw new Error("Invalid workflow request or checkout binding");
      workflowText(attempt.request.task, "workflow task", 16384);
      if (attempt.report) {
        parseWorkflowReport(stage.name, JSON.stringify(attempt.report));
        if (
          attempt.digest !== harnessDigest(attempt.report) ||
          attempt.artifact !== `${stage.name}-${n + 1}.json`
        )
          throw new Error("Invalid workflow artifact digest");
      } else if (attempt.artifact || attempt.digest)
        throw new Error("Workflow artifact requires a validated report");
      if (
        attempt.approval &&
        (!definition.gate ||
          attempt.approval.digest !== attempt.digest ||
          !sameWorkflowCheckout(attempt.approval.checkout, attempt.checkout))
      )
        throw new Error("Invalid historical workflow approval");
    }
    const attempt = stage.attempts.at(-1);
    if (stage.status === "running" && !attempt)
      throw new Error("Running workflow stage requires a checkpoint");
    if (["completed", "skipped", "approval_pending"].includes(stage.status)) {
      if (
        !attempt?.report ||
        attempt.status !== "done" ||
        attempt.evidence?.ok !== true ||
        !sameWorkflowCheckout(attempt.checkout, attempt.checkout) ||
        attempt.report.blockers.length ||
        attempt.report.decision !== (stage.status === "skipped" ? "skip" : "proceed")
      )
        throw new Error("Finished workflow stage requires a successful report");
      if (definition.readOnly && !sameWorkflowCheckout(attempt.before, attempt.checkout))
        throw new Error("Read-only workflow checkout changed");
      if (
        definition.projectCheck &&
        (!["project-suites", "isolated-command", "file-assertions"].includes(
          attempt.evidence.scope,
        ) ||
          !sameWorkflowCheckout(attempt.evidence.checkout, attempt.checkout))
      )
        throw new Error("Finished workflow stage lacks checkout-bound verification");
      if (
        (stage.status === "approval_pending" && !definition.gate) ||
        (stage.status === "completed" && definition.gate && !stage.approval)
      )
        throw new Error("Workflow approval gate is missing");
    }
    if (
      stage.approval &&
      (stage.approval.digest !== stage.attempts.at(-1)?.digest ||
        !definition.gate ||
        stage.status !== "completed" ||
        !sameWorkflowCheckout(stage.approval.checkout, attempt.checkout) ||
        !attempt.approval ||
        harnessDigest(stage.approval) !== harnessDigest(attempt.approval))
    )
      throw new Error("Invalid workflow approval binding");
  }
  const next = state.stages.findIndex((stage) => !["completed", "skipped"].includes(stage.status));
  const expected =
    next < 0
      ? "done"
      : state.stages[next].status === "pending"
        ? "ready"
        : state.stages[next].status;
  if (
    state.status !== expected ||
    (next >= 0 && state.stages.slice(next + 1).some((stage) => stage.status !== "pending"))
  )
    throw new Error("Invalid workflow progression");
  return state;
}

export function readWorkflowState(root, id) {
  const directory = workflowDirectory(root, id);
  if (realpathSync.native(directory) !== directory) throw new Error("Unsafe workflow directory");
  return validateState(readJson(join(directory, "state.json")), id);
}

export function checkWorkflowArtifact(directory, attempt) {
  const report = readJson(join(directory, attempt.artifact), 65536);
  if (harnessDigest(report) !== attempt.digest) throw new Error("Workflow artifact digest changed");
  return report;
}

export function openWorkflowState(root, id, { create = false } = {}) {
  const directory = workflowDirectory(root, id);
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync.native(directory) !== directory) throw new Error("Unsafe workflow directory");
  const lease = claimHarnessLease(directory);
  try {
    const file = join(directory, "state.json");
    const exists = lstatSync(file, { throwIfNoEntry: false });
    if (create && exists) throw new Error("Workflow already exists");
    const state = exists ? validateState(readJson(file), id) : null;
    if (!create && !state) throw new Error("Workflow state not found");
    return {
      state,
      directory,
      release: lease.release,
      save(value) {
        validateState(value, id);
        value.updatedAt = new Date().toISOString();
        const bytes = JSON.stringify(value, null, 2);
        if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
          throw new Error("Workflow history exceeds 2 MiB");
        const temp = join(directory, `${randomUUID()}.tmp`);
        const fd = openSync(temp, "wx", 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          renameSync(temp, file);
        } catch (error) {
          unlinkSync(temp);
          throw error;
        }
      },
      artifact(attempt) {
        const target = join(directory, attempt.artifact);
        try {
          writeFileSync(target, `${JSON.stringify(attempt.report, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          checkWorkflowArtifact(directory, attempt);
        }
      },
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}
