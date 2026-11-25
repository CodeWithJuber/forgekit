// The only composition point used by the CLI, MCP and queue. Callers choose a
// transport, never a second executor that can bypass the run policy.
import { harnessBudget, loadHarnessConfig, localVerifier } from "./harness_config.js";
import { loadHarnessExtensions } from "./harness_extensions.js";
import { normalizeHarnessRequest } from "./harness_gateway.js";
import { createHarnessHooks } from "./harness_hooks.js";
import { runHarness } from "./harness_loop.js";
import { createHarnessMemory } from "./harness_memory.js";
import { createHarnessModel, describeHarnessRoutes } from "./harness_router.js";
import { createHarnessTools } from "./harness_tools.js";
import { readHarnessRun } from "./harness_trace.js";
import { createHarnessVerifier } from "./harness_verify.js";
import { cleanModelEndpoint, inventoryProfiles, trustedModelProfile } from "./providers.js";

/** User choices can narrow the harness's configured routes; credential authorization remains at dispatch. */
export function selectHarnessRoute(
  root,
  routing,
  { route = undefined, model = undefined, modelProfile = undefined } = {},
) {
  if (route === undefined && model === undefined && modelProfile === undefined) return null;
  let matches = describeHarnessRoutes(routing);
  if (route !== undefined) matches = matches.filter((r) => r.id === route);
  if (model !== undefined) matches = matches.filter((r) => r.model === model);
  if (modelProfile !== undefined) {
    const p = inventoryProfiles(root).find((p) => p.name === modelProfile);
    if (!p || !trustedModelProfile(root, p)) throw new Error("Unknown or untrusted model profile");
    if (p.format !== "openai" && !["litellm", "openrouter"].includes(p.type))
      throw new Error("This provider profile does not declare a Chat Completions transport");
    const base = cleanModelEndpoint(p.baseUrl);
    const endpoint = p.type === "litellm" && !base.endsWith("/v1") ? `${base}/v1` : base;
    matches = matches.filter(
      (r) => r.baseUrl === endpoint && (r.apiKeyEnv || "") === (p.envKey || ""),
    );
  }
  if (matches.length !== 1)
    throw new Error(
      "Choose one configured harness route matching the requested provider and model",
    );
  const match = matches[0];
  return {
    id: match.id,
    model: match.model,
    fingerprint: match.fingerprint,
    modelProfile: modelProfile ?? null,
  };
}

/** @param {string} root @param {any} raw @param {any} options */
export async function runProjectHarness(root, raw, options = {}) {
  const config = loadHarnessConfig(root);
  const resumed = options.resume
    ? readHarnessRun(root, typeof options.resume === "string" ? options.resume : raw.id)
    : null;
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
  const previous = resumed?.request?.routeSelection;
  const selection = selectHarnessRoute(root, config.routing, {
    route: options.route ?? previous?.id,
    model: options.model ?? previous?.model,
    modelProfile: options.modelProfile ?? previous?.modelProfile ?? undefined,
  });
  if (previous && previous.fingerprint !== selection?.fingerprint)
    throw new Error("Selected model route changed since this run started");
  if (selection) {
    Object.assign(request, { routeSelection: selection });
    model = Object.assign(
      (args) => route({ ...args, pin: selection.id, pinReason: "selected run route" }),
      route,
    );
  }
  const releaseExtensions = () => {
    for (const item of extensions.active) extensions.unload(item.name);
  };
  try {
    return await runHarness({
      root,
      request,
      policy: config.policy,
      budget,
      model,
      verify: createHarnessVerifier(options.verifier ?? (await localVerifier(root))),
      memory: createHarnessMemory(root, {
        team: config.policy.memory?.team,
        personal: config.policy.memory?.personal === true,
      }),
      hooks,
      policyDigest: config.digest,
      releaseExtensions,
      tools: () => (worker ? [] : [...builtin, ...extensions.tools]),
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
