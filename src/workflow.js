import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { harnessDigest } from "./harness_trace.js";
import { redactSecrets } from "./secrets.js";
import {
  workflowCheckout as checkout,
  parseWorkflowReport,
  sameWorkflowCheckout as sameCheckout,
  WORKFLOW_CREDIT,
  WORKFLOW_ROUTES,
  workflowInput,
  workflowPrompt,
  workflowStage,
  workflowText,
} from "./workflow_contract.js";
import {
  checkWorkflowArtifact,
  openWorkflowState,
  readWorkflowState,
  workflowDirectory,
} from "./workflow_store.js";

const finished = (stage) => ["completed", "skipped"].includes(stage.status);
const current = (state) => state.stages.find((stage) => !finished(stage));
const latest = (stage) => stage.attempts.at(-1);
function requireDeliveryProof(state, code) {
  const checked = state.stages
    .filter((s) => finished(s) && workflowStage(s.name).projectCheck)
    .at(-1);
  if (!checked || !sameCheckout(latest(checked)?.checkout, code))
    throw new Error(
      "Delivery checkout lacks current project verification; retry solo, implement or test",
    );
}
function view(root, state) {
  const result = structuredClone(state);
  result.directory = workflowDirectory(root, state.id);
  result.credit = WORKFLOW_CREDIT;
  for (const stage of result.stages)
    for (const a of stage.attempts) if (a.artifact) a.artifact = join(result.directory, a.artifact);
  return result;
}

export function createWorkflow(root, input) {
  const request = workflowInput(input),
    id = randomUUID();
  const baseline = checkout(root);
  const store = openWorkflowState(root, id, { create: true });
  try {
    const state = {
      version: 1,
      id,
      ...request,
      baseline,
      status: "ready",
      reason: null,
      createdAt: new Date().toISOString(),
      stages: WORKFLOW_ROUTES[request.size].map((name) => ({
        name,
        status: "pending",
        approval: null,
        attempts: [],
        feedback: null,
      })),
    };
    store.save(state);
    return view(root, state);
  } finally {
    store.release();
  }
}

export function getWorkflow(root, id) {
  return view(root, readWorkflowState(root, id));
}

export function approveWorkflow(root, id, { stage: name, digest }) {
  const store = openWorkflowState(root, id);
  try {
    const state = store.state,
      stage = current(state),
      attempt = stage && latest(stage);
    if (
      state.status !== "approval_pending" ||
      stage?.name !== name ||
      stage.status !== "approval_pending"
    )
      throw new Error("No matching workflow approval is pending");
    if (typeof digest !== "string" || digest !== attempt.digest)
      throw new Error("Approval digest does not match the pending report");
    checkWorkflowArtifact(store.directory, attempt);
    const code = checkout(root);
    if (!sameCheckout(code, attempt.checkout))
      throw new Error(
        "Checkout changed since this report; retry the affected stage before approval",
      );
    if (name === "summary") requireDeliveryProof(state, code);
    stage.approval = { digest, checkout: attempt.checkout, at: new Date().toISOString() };
    attempt.approval = stage.approval;
    stage.status = "completed";
    state.status = current(state) ? "ready" : "done";
    state.reason = null;
    store.save(state);
    return view(root, state);
  } finally {
    store.release();
  }
}

export function retryWorkflow(root, id, { from, reason }) {
  const feedback = workflowText(reason, "retry reason", 1000);
  const store = openWorkflowState(root, id);
  try {
    const state = store.state,
      index = state.stages.findIndex((s) => s.name === from);
    if (
      index < 0 ||
      (!state.stages[index].attempts.length && state.stages[index].status !== "blocked")
    )
      throw new Error("Retry must name a stage that was attempted");
    if (state.stages.slice(index).some((s) => s.attempts.length >= 3))
      throw new Error("Workflow stage attempt limit reached; create a newly scoped workflow");
    for (const stage of state.stages.slice(index)) {
      stage.status = "pending";
      stage.approval = null;
      stage.feedback = feedback;
    }
    // Explicit rework adopts the current checkout, but never keeps downstream approval.
    state.baseline = checkout(root);
    state.status = "ready";
    state.reason = null;
    store.save(state);
    return view(root, state);
  } finally {
    store.release();
  }
}

function block(state, stage, reason) {
  stage.status = "blocked";
  state.status = "blocked";
  state.reason = redactSecrets(String(reason)).slice(0, 2000);
}

/** run is the normal project harness composition point, injected for deterministic tests.
 * Stage IDs are persisted before execution; resume uses the same ID and original request. */
export async function runWorkflow(root, id, run, { resume = false, signal = undefined } = {}) {
  const store = openWorkflowState(root, id);
  try {
    const state = store.state;
    if (
      ["done", "approval_pending"].includes(state.status) ||
      (state.status === "blocked" && !resume)
    )
      return view(root, state);
    let stage;
    while ((stage = current(state))) {
      signal?.throwIfAborted();
      const definition = workflowStage(stage.name);
      let attempt = latest(stage);
      const continuing = ["running", "blocked"].includes(stage.status);
      if (continuing && !attempt) throw new Error("Missing workflow run checkpoint");
      if (!continuing) {
        if (stage.attempts.length >= 3) throw new Error("Workflow stage attempt limit reached");
        if (!sameCheckout(checkout(root), state.baseline)) {
          block(
            state,
            stage,
            "Checkout changed outside the workflow; explicitly retry the affected stage",
          );
          store.save(state);
          return view(root, state);
        }
        if (stage.name === "summary") {
          try {
            requireDeliveryProof(state, state.baseline);
          } catch (error) {
            block(state, stage, error.message);
            store.save(state);
            return view(root, state);
          }
        }
        const runId = `wf-${id}-${stage.name}-${stage.attempts.length + 1}`;
        attempt = {
          runId,
          status: "running",
          startedAt: new Date().toISOString(),
          request: {
            id: runId,
            task: workflowPrompt(state, stage),
            acceptance: state.acceptance,
            profile: definition.profile,
            channel: "cli",
            actor: "local",
            priority: "P1",
          },
          before: state.baseline,
        };
        stage.attempts.push(attempt);
      }
      stage.status = "running";
      state.status = "running";
      state.reason = null;
      store.save(state);
      try {
        const outcome = await run(attempt.request, {
          workflowStage: stage.name,
          signal,
          ...(continuing && resume ? { resume: attempt.runId } : {}),
        });
        if (outcome?.id !== attempt.runId)
          throw new Error("Harness returned a mismatched workflow run ID");
        attempt.status = outcome.status;
        attempt.reason = redactSecrets(String(outcome.reason ?? outcome.status)).slice(0, 1000);
        attempt.usage = outcome.usage ?? null;
        attempt.evidence = outcome.evidence ?? null;
        attempt.checkout = checkout(root);
        if (definition.readOnly && !sameCheckout(attempt.before, attempt.checkout))
          throw new Error("Read-only workflow stage changed the checkout");
        if (
          outcome.status !== "done" ||
          outcome.evidence?.ok !== true ||
          outcome.certainty?.verification !== "L3"
        )
          throw new Error(`Harness ${outcome.status}: ${attempt.reason}`);
        if (
          definition.projectCheck &&
          !["project-suites", "isolated-command", "file-assertions"].includes(
            outcome.evidence.scope,
          )
        )
          throw new Error("Coding and test stages require project verification evidence");
        if (definition.projectCheck && !sameCheckout(outcome.evidence.checkout, attempt.checkout))
          throw new Error("Checkout changed since project verification; retry the checked stage");
        const report = parseWorkflowReport(stage.name, outcome.answer);
        attempt.report = report;
        attempt.digest = harnessDigest(report);
        attempt.artifact = `${stage.name}-${stage.attempts.length}.json`;
        attempt.finishedAt = new Date().toISOString();
        store.artifact(attempt);
        state.baseline = attempt.checkout;
        if (report.blockers.length || report.decision === "rework") {
          block(state, stage, report.blockers.join("; ") || report.summary);
        } else if (definition.gate) {
          stage.status = "approval_pending";
          state.status = "approval_pending";
          state.reason = `Operator approval required for ${stage.name}`;
        } else {
          stage.status = report.decision === "skip" ? "skipped" : "completed";
          state.status = "ready";
        }
      } catch (error) {
        block(state, stage, error.message);
        attempt.error = state.reason;
      }
      store.save(state);
      if (state.status !== "ready") return view(root, state);
      resume = false;
    }
    return view(root, state);
  } finally {
    store.release();
  }
}
