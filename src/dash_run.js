// Local browser intake uses the same model, policy, verifier and budget ledger as MCP.
import { randomUUID } from "node:crypto";
import { loadHarnessConfig, nativeHarnessPolicy } from "./harness_config.js";
import { createHarnessIntake } from "./harness_gateway.js";
import { runProjectHarness } from "./harness_runtime.js";

import { harnessDigest } from "./harness_trace.js";
import { sourceWorkspaceRoot } from "./sources.js";

const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

/** At most one run from this dashboard at a time. Send 202 only after a durable
 * checkpoint. Retrying the same idempotency key and input reopens the same run. */
export function createDashboardLauncher(root) {
  const intake = createHarnessIntake();
  let active;
  return async (body, key = randomUUID()) => {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((field) => !["task", "acceptance"].includes(field)) ||
      typeof key !== "string" ||
      !uuid.test(key)
    ) {
      return {
        code: 400,
        body: { error: "Expected a task, optional acceptance criteria and a valid request key." },
      };
    }
    let profile, workspace;
    try {
      workspace = nativeHarnessPolicy(root)?.root ?? sourceWorkspaceRoot(root);
      profile = loadHarnessConfig(workspace).policy.nativeProfile;
    } catch {
      return {
        code: 409,
        body: {
          error:
            "Review the project’s harness setup and trust its configuration before starting a run.",
        },
      };
    }
    let request;
    try {
      request = intake(body, {
        id: `dash-${key.toLowerCase()}`,
        channel: "api",
        actor: "dashboard",
        profile,
      });
    } catch (err) {
      return { code: err.message.includes("limit") ? 429 : 400, body: { error: err.message } };
    }
    const inputDigest = harnessDigest([request.task, request.acceptance]);
    const conflict = {
      code: 409,
      body: {
        error: "This request key belongs to a different task or set of acceptance criteria.",
      },
    };
    if (active?.id === request.id && active.inputDigest !== inputDigest) return conflict;
    if (active && active.id !== request.id) {
      return {
        code: 409,
        body: {
          error: "Another run from this dashboard is still running. Open Runs to follow it.",
        },
      };
    }
    if (active) return active.ready;
    const accepted = { code: 202, body: { id: request.id, status: "accepted" } };
    // A replay of a completed run returns without making another checkpoint.
    const ready = new Promise((resolve) => {
      runProjectHarness(workspace, request, { inputDigest, onCheckpoint: () => resolve(accepted) })
        .then(
          () => resolve(accepted),
          (err) => {
            if (err.code === "RUN_INPUT_CONFLICT") return resolve(conflict);
            if (err.code === "EEXIST" || err.code === "HARNESS_WRITER_BUSY")
              return resolve({
                code: 409,
                body: { error: "The run is already open. Refresh Runs to inspect its status." },
              });
            resolve({
              code: 500,
              body: {
                error:
                  "The run could not be recorded. Check the project configuration and private storage.",
              },
            });
          },
        )
        .finally(() => {
          active = undefined;
        });
    });
    active = { id: request.id, ready, inputDigest };
    return ready;
  };
}
