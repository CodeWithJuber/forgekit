// The only composition point used by the CLI, MCP and queue. Callers choose a
// transport, never a second executor that can bypass the run policy.
import { harnessBudget, loadHarnessConfig, localVerifier } from "./harness_config.js";
import { loadHarnessExtensions } from "./harness_extensions.js";
import { normalizeHarnessRequest } from "./harness_gateway.js";
import { createHarnessHooks } from "./harness_hooks.js";
import { runHarness } from "./harness_loop.js";
import { createHarnessMemory } from "./harness_memory.js";
import { createHarnessModel } from "./harness_router.js";
import { createHarnessTools } from "./harness_tools.js";
import { readHarnessRun } from "./harness_trace.js";
import { createHarnessVerifier } from "./harness_verify.js";
import { workflowStage, workflowVerifier } from "./workflow_contract.js";

/** @param {string} root @param {any} raw @param {any} options */
export async function runProjectHarness(root, raw, options = {}) {
  const config = loadHarnessConfig(root);
  let resumed = null;
  if (options.resume) {
    try {
      resumed = readHarnessRun(root, typeof options.resume === "string" ? options.resume : raw.id);
    } catch (error) {
      // The workflow checkpoint may precede the harness's first checkpoint.
      // Only the coordinator can resubmit that exact persisted request.
      if (error.code !== "ENOENT" || !options.workflowStage) throw error;
    }
  }
  if (resumed && options.workflowStage && resumed.request.workflowStage !== options.workflowStage)
    throw new Error("Cannot change a saved workflow stage");
  const input = resumed?.request ?? raw;
  const request = normalizeHarnessRequest(input, {
    channel: input.channel ?? "cli",
    actor: input.actor ?? "local",
    profile: input.profile ?? "coder",
    priority: input.priority,
    id: input.id,
  });
  if (input.background || ["webhook", "schedule", "worker"].includes(request.channel))
    request.background = true;
  const profile = config.policy.profiles[request.profile];
  if (!profile) throw new Error(`Unknown harness profile ${request.profile}`);
  const stageName = options.workflowStage ?? resumed?.request.workflowStage;
  const stage = stageName ? workflowStage(stageName) : null;
  if (stage && request.profile !== stage.profile)
    throw new Error("Workflow stage does not match its harness profile");
  // Keep stage restrictions on direct operator `harness resume` too. Raw intake
  // cannot select this field or opt into report-only verification.
  if (stage) Object.assign(request, { workflowStage: stageName });
  const worker = request.channel === "worker";
  if (input.triggerEvidence) request.triggerEvidence = input.triggerEvidence;
  const hooks = createHarnessHooks();
  const extensions = loadHarnessExtensions({
    root,
    task: request.task,
    host: options.host,
    hooks,
    policy: config.policy,
  });
  const builtin = createHarnessTools();
  const budget = harnessBudget(
    config,
    request.priority,
    options.budget ?? resumed?.budget ?? input.budget ?? {},
  );
  const route = createHarnessModel(config.routing, { root, ceilings: config.budgets.ceilings });
  let model = route;
  if (options.route) {
    if (!config.routing.routes.some((r) => r.id === options.route))
      throw new Error("Unknown worker route");
    model = Object.assign(
      (args) => route({ ...args, pin: options.route, pinReason: "assigned council role" }),
      route,
    );
  }
  const releaseExtensions = () => {
    for (const item of extensions.active) extensions.unload(item.name);
  };
  try {
    const projectVerifier = createHarnessVerifier(options.verifier ?? (await localVerifier(root)));
    return await runHarness({
      root,
      request,
      policy: config.policy,
      budget,
      model,
      verify: stage ? workflowVerifier(stageName, projectVerifier) : projectVerifier,
      memory: createHarnessMemory(root, {
        team: config.policy.memory?.team,
        personal: config.policy.memory?.personal === true,
      }),
      hooks,
      policyDigest: config.digest,
      releaseExtensions,
      tools: () =>
        worker
          ? []
          : [...builtin, ...extensions.tools].filter((t) => !stage?.readOnly || t.risk === "read"),
      working: () => [
        ...extensions.skills.map((s) => ({ id: s.name, text: s.instructions, score: 1 })),
        ...(input.triggerEvidence
          ? [
              {
                id: `Trigger event ${input.triggerEvidence.name}`,
                text: JSON.stringify(input.triggerEvidence.data),
                score: 1,
              },
            ]
          : []),
      ],
      resume: resumed?.id,
      signal: options.signal,
      onCheckpoint: options.onCheckpoint,
      inputDigest: options.inputDigest,
    });
  } finally {
    releaseExtensions();
  }
}
