// Automatic recommendations require observed, comparable work on a currently listed
// provider model. An exact selection belongs to the operator; it carries no quality claim.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordRoute, routeRef } from "./cost_report.js";
import { printableLine, SAFE_MODEL_ID } from "./model_catalog.js";
import { inventoryRouteForRef, modelInventory } from "./model_inventory.js";
import { describeResolution, MODELS, resolveTierModel } from "./model_tiers.js";
import { activeProvider, envModelOverride, inventoryProfiles } from "./providers.js";
import { restrictedModel } from "./route_policy.js";
import { readOutcomes, taskRef } from "./router/index.js";
import { firstAttempts, wilson } from "./router/measured.js";

/** @param {string} root @param {string} task @param {any} options */
export function routeTask(root, task, options = {}) {
  if (typeof task !== "string" || !task.trim() || task.length > 16384)
    throw new Error("Supply a task of at most 16384 characters");
  return chooseRoute(root, task, options);
}

export function defaultDispatchModel(root, prompt, profile) {
  const rec = chooseRoute(root, prompt, { profile });
  if (!rec.model)
    throw Object.assign(
      new Error(
        `${rec.reasons.join(". ")}. Configure an exact model with forge config model --exact <id> --profile <name> or FORGE_MODEL.`,
      ),
      { code: "FORGE_MODEL_REQUIRED" },
    );
  return rec.model.id;
}

/** @param {string} root @param {string} task @param {any} options */
function chooseRoute(root, task, options) {
  const provider = options.profile
    ? inventoryProfiles(root).find((p) => p.name === options.profile)
    : activeProvider(root);
  if (!provider) throw new Error("Unknown or inactive model profile");
  const base = {
    profile: provider.name,
    key: null,
    tier: null,
    model: null,
    score: null,
    interval: null,
    expectedCost: null,
    llm: null,
    reasons: [],
    modelOverride: undefined,
    evidence: null,
    modelControl: "forge-http",
    nativeAgent: "host-managed",
  };
  const abstain = (reason) => ({
    ...base,
    ok: false,
    status: "unrated",
    reasons: [reason],
    provenance: { path: "insufficient-evidence" },
  });
  const selected = envModelOverride(provider) || provider.selectedModel;
  if (selected && !options.band && !options.objective && !options.workload) {
    if (selected === restrictedModel(root, provider, true))
      return abstain("The configured model is disabled by the top-tier authorization");
    if (!SAFE_MODEL_ID.test(selected))
      return abstain("The configured provider model ID is invalid");
    const listing = modelInventory(root, { profile: provider.name, refresh: false }).profiles[0];
    const known = listing.models.find((m) => m.id === selected);
    if (
      listing.status === "denied" ||
      known?.availability === "denied" ||
      listing.status === "untrusted"
    )
      return abstain("Access to the configured model is denied or the profile is untrusted");
    return {
      ...base,
      ok: true,
      status: "configured",
      key: selected,
      modelOverride: selected,
      model: { id: selected, name: selected },
      availability: known?.availability ?? "unknown",
      provenance: { path: "operator-selection" },
      reasons: ["Exact model selected by configuration"],
    };
  }
  if (!existsSync(join(root, ".forge", "route_outcomes.jsonl")))
    return abstain("No verified task outcomes have been recorded in this repository");
  const evidence = inventoryRouteForRef(root, taskRef(task), {
    profile: provider.name,
    workload: options.workload,
    band: options.band,
    objective: options.objective,
    maxDepth: 1,
    allowTop: options.allowTop,
    refresh: false,
  });
  if (!("cascade" in evidence)) return { ...abstain(evidence.reason), evidence };
  const best = evidence.cascade[0];
  return {
    ...base,
    ok: true,
    status: "measured",
    key: best.wireId,
    tier: best.band,
    model: { id: best.wireId, name: best.wireId },
    score: evidence.pSuccess,
    interval: evidence.interval,
    expectedCost: evidence.expectedCost,
    availability: "listed",
    evidence,
    provenance: { path: "verified-outcomes" },
    reasons: [`First attempts on ${evidence.fit.n} verified task(s) in ${evidence.workload}`],
  };
}

export function describeRoute(rec) {
  if (!rec.model) return `No model recommendation. ${rec.reasons.join(". ")}.`;
  if (rec.status === "configured")
    return `Configured model ${rec.model.id} (availability: ${rec.availability}).`;
  return `Measured model ${rec.model.id}. Verified success ${(100 * rec.score).toFixed(1)}% on ${rec.interval.n} paired task(s), 95% Wilson interval ${(100 * rec.interval.low).toFixed(1)}–${(100 * rec.interval.high).toFixed(1)}%, mean reported attempt cost $${rec.expectedCost.toFixed(4)}.`;
}

// Leave one task out for each model. The Jeffreys posterior mean predicts its verdict
// from the other tasks; a Brier score describes calibration on this workload.
export function calibrateRouting(root = process.cwd(), workload = "repo-verified") {
  const models = [];
  for (const [id, tasks] of firstAttempts(readOutcomes(root), workload)) {
    if (tasks.size < 2) continue;
    const rows = [...tasks.values()];
    const n = rows.length;
    const passed = rows.filter((r) => r.passed).length;
    const brier =
      rows.reduce((sum, row) => {
        const actual = Number(row.passed);
        return sum + ((passed - actual + 0.5) / n - actual) ** 2;
      }, 0) / n;
    models.push({ id, interval: wilson(passed, n), leaveOneTaskOutBrier: brier });
  }
  return {
    status: models.length ? "measured" : "unrated",
    workload,
    models,
    verifiedFields: ["passed"],
  };
}

export function meterRoute(root, task, rec) {
  // Accept historical telemetry records supplied by integrations that pin a tier.
  const id = rec?.model?.id ?? rec?.tier;
  if (!id) return;
  try {
    recordRoute(root, { tier: id, ref: routeRef(task), escalateTo: rec.llm?.escalateTo });
  } catch {}
}

// Existing client-requested gateway aliases. These are protocol configuration.
const GATEWAY_TIERS = ["haiku", "sonnet", "opus"];
const ANTHROPIC_UPSTREAM = {
  name: "anthropic",
  type: "anthropic",
  baseUrl: "https://api.anthropic.com",
};

/** Emit a LiteLLM config exposing the complexity tiers as aliases (request the one `forge route` picks).
 *  Provider-aware: each tier's model id is RESOLVED (model_tiers.resolveTierModel) — the newest
 *  model of the tier's family in the upstream's live catalog (OpenRouter's for an OpenRouter
 *  provider, the Anthropic Models API otherwise), else the shipped snapshot — behind the LiteLLM
 *  prefix for that upstream (anthropic/ or openrouter/). Each alias says where its id came from.
 *  Returns `{ ok: false, reason }` for hosted gateways the user cannot configure.
 *  @param {string} [root]
 *  @param {{fetchImpl?: Function, env?: Record<string, string|undefined>}} [opts] catalog test seams */
export function emitGatewayConfig(root = process.cwd(), { fetchImpl, env } = {}) {
  const prov = activeProvider(root);
  if (prov._autoDetected && prov._source === "LITELLM_BASE_URL") {
    return {
      ok: false,
      reason:
        `Hosted LiteLLM gateway detected at ${prov.baseUrl}. ` +
        `No local config needed — requests go directly to the hosted gateway. ` +
        `Use standard model names (the gateway handles routing).`,
    };
  }
  const openrouter = prov.type === "openrouter";
  const prefix = openrouter ? "openrouter/" : "anthropic/";
  // The config's upstream: OpenRouter for an OpenRouter provider; otherwise LiteLLM's anthropic/
  // provider, i.e. the Anthropic API itself (even when the active provider is this gateway).
  const upstream = openrouter ? prov : ANTHROPIC_UPSTREAM;
  const resolved = GATEWAY_TIERS.map((tier) => ({
    m: MODELS[tier],
    r: resolveTierModel(tier, { root, provider: upstream, fetchImpl, env }),
  }));
  const bare = (id) => String(id).split("/").pop();
  // Ids and display names come from a LIVE catalog (a gateway's or OpenRouter's /v1/models) and
  // land in a file the user feeds to LiteLLM as routing config. A display name carrying a
  // newline would otherwise splice in a SECOND entry for a tier alias, and LiteLLM's
  // simple-shuffle would then send a share of that tier's prompts to the spliced model. So every
  // catalog-sourced value is a double-quoted YAML scalar with control characters escaped, and
  // every comment is collapsed to one line.
  const yamlStr = (s) => {
    let out = '"';
    for (const ch of String(s)) {
      const n = ch.charCodeAt(0);
      if (ch === "\\" || ch === '"') out += `\\${ch}`;
      else if (n < 32 || n === 127) out += `\\x${n.toString(16).padStart(2, "0")}`;
      else out += ch;
    }
    return `${out}"`;
  };
  // One printable line for a comment: the same rule the catalog applies to display names.
  const comment = printableLine;
  const aliases = resolved.map(({ m, r }) =>
    [
      `  - model_name: forge-${m.tier.padEnd(8)} # ${comment(r.displayName ?? m.name)} — ${comment(m.use)}`,
      `    # id: ${comment(describeResolution(r))}`,
      `    litellm_params: { model: ${yamlStr(prefix + r.id)} }`,
    ].join("\n"),
  );
  // Passthrough: each resolved id, plus the snapshot id when it differs and the upstream is
  // Anthropic — a client still pinned to the older id keeps working through the gateway.
  const passIds = [];
  for (const { m, r } of resolved)
    for (const id of [r.id, openrouter ? null : m.id])
      if (id && !passIds.includes(id)) passIds.push(id);
  const passthrough = passIds.map(
    (id) =>
      `  - model_name: ${yamlStr(bare(id))}\n    litellm_params: { model: ${yamlStr(prefix + id)} }`,
  );
  const path = join(root, "litellm.config.yaml");
  const body = `# Forge Preflight — LiteLLM routing config (complexity tier -> model).
# LiteLLM forwards the requested model name. Clients may choose an explicit alias
# (forge-simple/medium/complex) or request a listed provider model ID. A normal claude-* request passes through
# unchanged — pointing ANTHROPIC_BASE_URL here never breaks existing traffic.
#   pip install "litellm[proxy]==<pin an exact verified version>"   # supply-chain: pin exact, no floating tag
#   litellm --config litellm.config.yaml       # then export ANTHROPIC_BASE_URL=http://localhost:4000
# Provider: ${prov.label || prov.name} (${prov.type})
# Model ids were resolved when this file was written (each "# id:" line says from where);
# re-run 'forge route gateway' to pick up newer models, 'forge models' to preview them.
model_list:
  # Client-requested aliases
${aliases.join("\n")}
  # Passthrough — a normal claude-* request still works when pointed at the gateway.
${passthrough.join("\n")}
${prov.envKey ? `litellm_settings:\n  drop_params: true\n  set_verbose: false` : ""}
router_settings:
  routing_strategy: simple-shuffle
`;
  writeFileSync(path, body);
  return path;
}
