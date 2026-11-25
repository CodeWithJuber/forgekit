// forge providers — multi-provider model configuration. Supports Anthropic (default),
// OpenRouter, and custom API endpoints. Config lives in .forge/providers.json; defaults
// are hardcoded so the system works with zero config. Never stores API keys — only env
// var names (the key is resolved at runtime from the environment).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SAFE_MODEL_ID } from "./model_catalog.js";
import { isSnapshotId, MODELS, resolveTierModel } from "./model_tiers.js";
import { bindingDigest, readPrivateBinding, savePrivateBinding } from "./remote_endpoints.js";

const PROVIDERS_FILE = "providers.json";
const PROVIDERS_DIR = ".forge";

const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com";

function anthropicKeyEnv() {
  if (process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (process.env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
  return "ANTHROPIC_API_KEY";
}

// A PRIOR, not a verdict: hostname vocabulary suggests a gateway, and the /health
// probe in providerStatus() supplies the behavioral evidence (a proxy that answers
// /health IS a LiteLLM-style gateway regardless of what its hostname says — pin the
// corrected classification with `forge config provider add`). Detection itself stays
// pure and network-free because it runs inside per-prompt hooks.
function isLikelyGateway(url) {
  return /\b(gateway|litellm|aigateway|llmproxy|llm-proxy)\b/i.test(url);
}

/** curl {baseUrl}/health, 2xx → true. Best-effort behavioral probe (5s cap). */
function probeHealth(baseUrl) {
  if (process.env.FORGE_NO_CATALOG_FETCH === "1") return false;
  try {
    const base = cleanModelEndpoint(baseUrl);
    const out = execFileSync(
      "curl",
      ["-sf", "-o", "/dev/null", "-w", "%{http_code}", "--", `${base}/health`],
      { encoding: "utf8", timeout: 5000 },
    );
    return out.startsWith("2");
  } catch {
    return false;
  }
}

function providersPath(root) {
  return join(root, PROVIDERS_DIR, PROVIDERS_FILE);
}

const BUILTIN_PROVIDERS = {
  anthropic: {
    type: "anthropic",
    label: "Anthropic (direct)",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    models: Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.id])),
  },
  openrouter: {
    type: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    models: Object.fromEntries(
      Object.entries(MODELS).map(([key, m]) => [key, `anthropic/${m.id}`]),
    ),
  },
  litellm: {
    type: "litellm",
    label: "LiteLLM Gateway",
    baseUrl: "http://localhost:4000",
    envKey: "ANTHROPIC_API_KEY",
    models: {
      haiku: "forge-simple",
      sonnet: "forge-medium",
      opus: "forge-complex",
      fable: "forge-complex",
    },
  },
  // OpenAI and Gemini are reached over their OpenAI-compatible chat/completions
  // surface (format: "openai" — see src/llm.js), so a native key works with zero
  // config. Tier→model maps size the model to the task, same as the Anthropic table;
  // rotate them via `forge config provider add` when the vendor rolls the lineup.
  openai: {
    type: "openai",
    format: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    models: {
      haiku: "gpt-5-nano",
      sonnet: "gpt-5-mini",
      opus: "gpt-5",
      fable: "gpt-5",
    },
  },
  gemini: {
    type: "gemini",
    format: "openai",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    models: {
      haiku: "gemini-2.5-flash-lite",
      sonnet: "gemini-2.5-flash",
      opus: "gemini-2.5-pro",
      fable: "gemini-2.5-pro",
    },
  },
};

export function builtinModelProfiles() {
  return Object.entries(BUILTIN_PROVIDERS).map(([name, p]) => ({
    name,
    type: p.type,
    aliases: Object.keys(p.models),
  }));
}

/** Resolve the Gemini key env var name (GEMINI_API_KEY preferred, GOOGLE_API_KEY alias). */
function geminiKeyEnv() {
  if (process.env.GEMINI_API_KEY) return "GEMINI_API_KEY";
  if (process.env.GOOGLE_API_KEY) return "GOOGLE_API_KEY";
  return null;
}

function defaults() {
  return {
    active: "anthropic",
    providers: { ...BUILTIN_PROVIDERS },
  };
}

/** Load providers config, falling back to built-in defaults. */
export function loadProviders(root = process.cwd()) {
  const path = providersPath(root);
  if (!existsSync(path)) return defaults();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const merged = defaults();
    if (data.active) merged.active = data.active;
    if (data.providers) {
      for (const [name, cfg] of Object.entries(data.providers)) {
        merged.providers[name] = { ...merged.providers[name], ...cfg };
      }
    }
    return merged;
  } catch {
    return defaults();
  }
}

/** Write providers config. */
function saveProviders(root, config) {
  const dir = join(root, PROVIDERS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(providersPath(root), `${JSON.stringify(config, null, 2)}\n`);
}

/** The active provider config. Explicit .forge/providers.json wins; otherwise auto-detects from env. */
export function activeProvider(root = process.cwd()) {
  if (existsSync(providersPath(root))) {
    const config = loadProviders(root);
    const name = config.active;
    const provider = config.providers[name];
    if (provider) {
      const p = { ...provider, name };
      return { ...p, _catalogTrusted: trustedModelProfile(root, p) };
    }
  }

  const detected = autoDetectProvider();
  if (detected) {
    const { source, ...rest } = detected;
    return { ...rest, _autoDetected: true, _source: source };
  }

  return { name: "anthropic", ...BUILTIN_PROVIDERS.anthropic };
}

/** Explicit model override from the environment — bypasses tier-based routing when set. */
export function envModelOverride(provider = activeProvider()) {
  const anthropic = ["anthropic", "litellm"].includes(provider.type);
  return (
    (anthropic && process.env.ANTHROPIC_MODEL?.trim()) || process.env.FORGE_MODEL?.trim() || null
  );
}

/** Resolve a tier key (haiku/sonnet/opus/fable) to the active provider's model ID.
 *  A configured id that is only the shipped snapshot's placeholder (a stock id, bare or
 *  namespaced) resolves through the provider's live catalog to the newest model of the tier's
 *  family (model_tiers.resolveTierModel — a custom gateway's /v1/models, the Anthropic Models API,
 *  or OpenRouter's list), falling back to that snapshot id. Explicit aliases (a gateway's
 *  forge-simple, another vendor's model) are returned untouched. */
export function resolveModel(root, tierKey) {
  const provider = activeProvider(root);
  const override = envModelOverride(provider) || provider.selectedModel;
  if (override) return override;
  const configured = provider.models?.[tierKey] ?? MODELS[tierKey]?.id ?? null;
  if (!isSnapshotId(configured, tierKey)) return configured;
  return resolveTierModel(tierKey, { root, provider })?.id ?? configured;
}

/** Pin the default exact request for this profile. A per-call exact argument wins. */
export function setProfileModel(root, name, model) {
  if (!SAFE_MODEL_ID.test(model ?? "")) throw new Error("Expected an exact provider model ID");
  const cfg = loadProviders(root);
  if (!existsSync(providersPath(root))) {
    const active = autoDetectProvider();
    if (active) {
      const { name: activeName, source, ...transport } = active;
      cfg.active = activeName;
      cfg.providers[activeName] = transport;
    }
  }
  if (!Object.hasOwn(cfg.providers, name)) throw new Error("Unknown model profile");
  cfg.providers[name] = { ...cfg.providers[name], selectedModel: model };
  saveProviders(root, cfg);
  return { profile: name, model };
}

/** Switch the active provider. Returns the new active config. */
export function setProvider(root, name) {
  const config = loadProviders(root);
  if (!config.providers[name]) {
    return {
      ok: false,
      reason: `unknown provider "${name}" — add it first with forge config provider add`,
    };
  }
  config.active = name;
  saveProviders(root, config);
  return { ok: true, name, provider: config.providers[name] };
}

/**
 * Register a custom provider.
 * @param {string} root
 * @param {string} name
 * @param {{type?: string, label?: string, baseUrl?: string, envKey?: string, format?: string, models?: Record<string,string>}} cfg
 */
export function addProvider(root, name, cfg) {
  if (!name || !cfg.baseUrl) {
    return { ok: false, reason: "name and --base-url are required" };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,54}$/.test(name) || name in Object.prototype)
    return { ok: false, reason: "Invalid provider name" };
  try {
    cleanModelEndpoint(cfg.baseUrl);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (cfg.format && !["openai", "anthropic"].includes(cfg.format))
    return { ok: false, reason: "--format expects openai or anthropic" };
  if (cfg.envKey && !/^[A-Za-z_][A-Za-z_0-9]*$/.test(cfg.envKey))
    return { ok: false, reason: "Invalid credential variable name" };
  const config = loadProviders(root);
  config.providers[name] = {
    type: cfg.type || "custom",
    ...(cfg.format ? { format: cfg.format } : {}),
    label: cfg.label || name,
    baseUrl: cfg.baseUrl,
    envKey: cfg.envKey || "",
    models: cfg.models || Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.id])),
  };
  savePrivateBinding(root, `model-${name}`, profileBinding(config.providers[name]));
  saveProviders(root, config);
  return { ok: true, name, provider: config.providers[name] };
}

export function cleanModelEndpoint(raw) {
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw new Error(
      "Use an HTTPS model endpoint or HTTP loopback without credentials, query or fragment",
    );
  return u.href.replace(/\/+$/, "");
}

function profileBinding(p) {
  return {
    url: cleanModelEndpoint(p.baseUrl),
    tokenEnv: p.envKey || "",
    type: p.type,
    format: p.format || null,
  };
}

// Repo config can name a profile. Only operator environment or a privately pinned endpoint may
// receive authentication or prompts. Include protocol and credential *name* in the pin.
export function trustedModelProfile(root, p) {
  try {
    const binding = profileBinding(p);
    const stock = BUILTIN_PROVIDERS[p.name];
    if (
      p.name === "gemini" &&
      stock &&
      p.envKey === "GOOGLE_API_KEY" &&
      bindingDigest(profileBinding({ ...stock, envKey: "GOOGLE_API_KEY" })) ===
        bindingDigest(binding)
    )
      return true;
    if (stock && bindingDigest(profileBinding(stock)) === bindingDigest(binding)) return true;
    const detected = autoDetectProvider();
    if (
      detected?.name === p.name &&
      bindingDigest(profileBinding(detected)) === bindingDigest(binding)
    )
      return true;
    return Boolean(readPrivateBinding(root, `model-${p.name}`, bindingDigest(binding)));
  } catch {
    return false;
  }
}

export function inventoryProfiles(root) {
  const cfg = loadProviders(root);
  const found = new Map();
  const add = (p) => found.set(p.name, p);
  const detected = autoDetectProvider();
  const active = existsSync(providersPath(root)) ? cfg.active : (detected?.name ?? cfg.active);
  for (const [name, value] of Object.entries(cfg.providers)) {
    if (
      name === active ||
      !BUILTIN_PROVIDERS[name] ||
      (name !== "litellm" &&
        !(
          name === "anthropic" &&
          (process.env.ANTHROPIC_BASE_URL || process.env.LITELLM_BASE_URL)
        ) &&
        process.env[value.envKey]) ||
      JSON.stringify(value) !== JSON.stringify(BUILTIN_PROVIDERS[name])
    )
      add({ ...value, name });
  }
  if (detected && (!existsSync(providersPath(root)) || !found.has(detected.name))) add(detected);
  if (
    process.env.ANTHROPIC_AUTH_TOKEN &&
    !found.has("anthropic") &&
    !process.env.ANTHROPIC_BASE_URL &&
    !process.env.LITELLM_BASE_URL
  )
    add({ ...BUILTIN_PROVIDERS.anthropic, name: "anthropic", envKey: "ANTHROPIC_AUTH_TOKEN" });
  if (process.env.GOOGLE_API_KEY && !found.has("gemini"))
    add({ ...BUILTIN_PROVIDERS.gemini, name: "gemini", envKey: "GOOGLE_API_KEY" });
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The standard credential alias is scoped to the matching vendor origin and credential slot. */
export function profileCredential(p) {
  let name = p.envKey;
  if (!process.env[name]) {
    if (
      p.type === "gemini" &&
      cleanModelEndpoint(p.baseUrl) === BUILTIN_PROVIDERS.gemini.baseUrl &&
      name === "GEMINI_API_KEY"
    )
      name = "GOOGLE_API_KEY";
    if (
      p.type === "anthropic" &&
      cleanModelEndpoint(p.baseUrl) === ANTHROPIC_DEFAULT_URL &&
      name === "ANTHROPIC_API_KEY"
    )
      name = "ANTHROPIC_AUTH_TOKEN";
  }
  return { value: name ? (process.env[name] ?? "") : "", bearer: name === "ANTHROPIC_AUTH_TOKEN" };
}

/** List all configured providers. */
export function listProviders(root = process.cwd()) {
  const config = loadProviders(root);
  return Object.entries(config.providers).map(([name, p]) => ({
    name,
    active: name === config.active,
    type: p.type,
    label: p.label || name,
    baseUrl: p.baseUrl,
    envKey: p.envKey,
    hasKey: p.envKey ? Boolean(process.env[p.envKey]) : false,
  }));
}

/**
 * Auto-detect the best provider from environment variables.
 * Pure read — never writes config. Returns null if nothing detected.
 */
export function autoDetectProvider() {
  const litellmUrl = (process.env.LITELLM_BASE_URL || "").replace(/\/+$/, "");
  if (litellmUrl) {
    return {
      name: "litellm",
      type: "litellm",
      label: "LiteLLM Gateway (hosted)",
      baseUrl: litellmUrl,
      envKey: process.env.LITELLM_API_KEY ? "LITELLM_API_KEY" : anthropicKeyEnv(),
      models: Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.id])),
      source: "LITELLM_BASE_URL",
    };
  }

  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
  if (baseUrl && baseUrl.toLowerCase() !== ANTHROPIC_DEFAULT_URL) {
    const gateway = isLikelyGateway(baseUrl);
    return {
      name: gateway ? "litellm-gateway" : "anthropic-proxy",
      type: gateway ? "litellm" : "anthropic",
      label: gateway ? "LiteLLM Gateway (via ANTHROPIC_BASE_URL)" : "Anthropic (via proxy)",
      baseUrl,
      envKey: anthropicKeyEnv(),
      models: Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.id])),
      source: "ANTHROPIC_BASE_URL",
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      ...BUILTIN_PROVIDERS.openrouter,
      source: "OPENROUTER_API_KEY",
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: "anthropic",
      ...BUILTIN_PROVIDERS.anthropic,
      source: "ANTHROPIC_API_KEY",
    };
  }

  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      name: "anthropic",
      ...BUILTIN_PROVIDERS.anthropic,
      envKey: "ANTHROPIC_AUTH_TOKEN",
      source: "ANTHROPIC_AUTH_TOKEN",
    };
  }

  // Anthropic stays the default when its credentials are present; OpenAI and Gemini
  // are picked up only as the sole configured provider (zero-config fallback).
  if (process.env.OPENAI_API_KEY) {
    return { name: "openai", ...BUILTIN_PROVIDERS.openai, source: "OPENAI_API_KEY" };
  }

  const geminiKey = geminiKeyEnv();
  if (geminiKey) {
    return { name: "gemini", ...BUILTIN_PROVIDERS.gemini, envKey: geminiKey, source: geminiKey };
  }

  return null;
}

/** List all providers that could be auto-detected from the current environment. */
export function listDetectedProviders() {
  const detected = [];
  const litellmUrl = (process.env.LITELLM_BASE_URL || "").replace(/\/+$/, "");
  if (litellmUrl) {
    detected.push({
      name: "litellm",
      type: "litellm",
      label: "LiteLLM Gateway (hosted)",
      source: "LITELLM_BASE_URL",
      available: true,
    });
  }
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
  if (baseUrl && baseUrl.toLowerCase() !== ANTHROPIC_DEFAULT_URL) {
    const gateway = isLikelyGateway(baseUrl);
    detected.push({
      name: gateway ? "litellm-gateway" : "anthropic-proxy",
      type: gateway ? "litellm" : "anthropic",
      label: gateway ? "LiteLLM Gateway (via ANTHROPIC_BASE_URL)" : "Anthropic (via proxy)",
      source: "ANTHROPIC_BASE_URL",
      available: true,
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    detected.push({
      name: "openrouter",
      type: "openrouter",
      label: "OpenRouter",
      source: "OPENROUTER_API_KEY",
      available: true,
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    detected.push({
      name: "anthropic",
      type: "anthropic",
      label: "Anthropic (direct)",
      source: "ANTHROPIC_API_KEY",
      available: true,
    });
  }
  if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_AUTH_TOKEN) {
    detected.push({
      name: "anthropic",
      type: "anthropic",
      label: "Anthropic (via auth token)",
      source: "ANTHROPIC_AUTH_TOKEN",
      available: true,
    });
  }
  if (process.env.OPENAI_API_KEY) {
    detected.push({
      name: "openai",
      type: "openai",
      label: "OpenAI",
      source: "OPENAI_API_KEY",
      available: true,
    });
  }
  const geminiKey = geminiKeyEnv();
  if (geminiKey) {
    detected.push({
      name: "gemini",
      type: "gemini",
      label: "Google Gemini",
      source: geminiKey,
      available: true,
    });
  }
  return detected;
}

/** Check provider health: env key set, gateway reachable (litellm), base URL valid. */
export function providerStatus(root = process.cwd()) {
  const prov = activeProvider(root);
  const checks = [];

  if (prov._autoDetected) {
    checks.push({
      id: "auto-detect",
      ok: true,
      detail: `Auto-detected from ${prov._source}`,
    });
  }

  if (prov.envKey) {
    checks.push({
      id: "api-key",
      ok: Boolean(process.env[prov.envKey]),
      detail: process.env[prov.envKey]
        ? `${prov.envKey} is set`
        : `${prov.envKey} is NOT set — get it from the Anthropic Console (console.anthropic.com/settings/keys) or your provider's dashboard`,
    });
  }
  if (prov._catalogTrusted === false) {
    checks.push({
      id: "endpoint-trust",
      ok: false,
      detail: "Model endpoint needs local authorization",
    });
  }
  const customUrl =
    prov.baseUrl && prov.baseUrl.replace(/\/+$/, "").toLowerCase() !== ANTHROPIC_DEFAULT_URL;
  if (prov.type === "litellm" && prov._catalogTrusted !== false) {
    const reachable = probeHealth(prov.baseUrl);
    checks.push({
      id: "gateway",
      ok: reachable,
      detail: reachable
        ? `LiteLLM gateway reachable at ${prov.baseUrl}`
        : `LiteLLM gateway NOT reachable at ${prov.baseUrl}`,
    });
  } else if (prov._catalogTrusted !== false && customUrl) {
    // Behavioral evidence beats hostname spelling: an "anthropic-proxy" that answers
    // /health is actually a LiteLLM-style gateway the URL prior missed. Advisory.
    const behavesLikeGateway = probeHealth(prov.baseUrl);
    checks.push({
      id: "gateway-behavior",
      ok: true,
      detail: behavesLikeGateway
        ? `${prov.baseUrl} answers /health like a LiteLLM gateway — pin it with \`forge config provider add\``
        : `${prov.baseUrl} does not answer /health (plain proxy, or unreachable from here)`,
    });
  }

  const envScan = [
    { key: "LITELLM_BASE_URL", set: Boolean(process.env.LITELLM_BASE_URL) },
    { key: "LITELLM_API_KEY", set: Boolean(process.env.LITELLM_API_KEY) },
    { key: "ANTHROPIC_BASE_URL", set: Boolean(process.env.ANTHROPIC_BASE_URL) },
    { key: "OPENROUTER_API_KEY", set: Boolean(process.env.OPENROUTER_API_KEY) },
    { key: "OPENAI_API_KEY", set: Boolean(process.env.OPENAI_API_KEY) },
    { key: "GEMINI_API_KEY", set: Boolean(process.env.GEMINI_API_KEY) },
    { key: "GOOGLE_API_KEY", set: Boolean(process.env.GOOGLE_API_KEY) },
    { key: "ANTHROPIC_API_KEY", set: Boolean(process.env.ANTHROPIC_API_KEY) },
    {
      key: "ANTHROPIC_AUTH_TOKEN",
      set: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    },
    { key: "ANTHROPIC_MODEL", set: Boolean(process.env.ANTHROPIC_MODEL) },
  ];

  return {
    provider: prov.name,
    type: prov.type,
    autoDetected: Boolean(prov._autoDetected),
    source: prov._source || null,
    checks,
    envScan,
  };
}

/**
 * Apply a routed model recommendation to ~/.claude/settings.json.
 * @param {string} tierKey - the recommended tier (haiku/sonnet/opus/fable)
 * @param {{settingsPath?: string,exactId?:string}} [opts]
 */
export function applyRoute(tierKey, { settingsPath, exactId = undefined } = {}) {
  const target = settingsPath || join(homedir(), ".claude", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(target, "utf8"));
  } catch {}
  const modelId = MODELS[tierKey]?.id;
  if (!modelId) return { ok: false, reason: `unknown tier "${tierKey}"` };
  const prev = settings.model;
  if (exactId && !SAFE_MODEL_ID.test(exactId)) return { ok: false, reason: "Invalid model id" };
  settings.model = exactId || tierKey;
  writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  return { ok: true, model: settings.model, modelId: exactId || modelId, prev, path: target };
}
