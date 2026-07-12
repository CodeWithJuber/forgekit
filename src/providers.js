// forge providers — multi-provider model configuration. Supports Anthropic (default),
// OpenRouter, and custom API endpoints. Config lives in .forge/providers.json; defaults
// are hardcoded so the system works with zero config. Never stores API keys — only env
// var names (the key is resolved at runtime from the environment).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MODELS } from "./model_tiers.js";

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
  try {
    const out = execFileSync(
      "curl",
      ["-sf", "-o", "/dev/null", "-w", "%{http_code}", `${baseUrl}/health`],
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
    if (provider) return { name, ...provider };
  }

  const detected = autoDetectProvider();
  if (detected) {
    const { source, ...rest } = detected;
    return { ...rest, _autoDetected: true, _source: source };
  }

  return { name: "anthropic", ...BUILTIN_PROVIDERS.anthropic };
}

/** Explicit model override from the environment — bypasses tier-based routing when set. */
export function envModelOverride() {
  return process.env.ANTHROPIC_MODEL?.trim() || process.env.FORGE_MODEL?.trim() || null;
}

/** Resolve a tier key (haiku/sonnet/opus/fable) to the active provider's model ID. */
export function resolveModel(root, tierKey) {
  const override = envModelOverride();
  if (override) return override;
  const provider = activeProvider(root);
  return provider.models?.[tierKey] ?? MODELS[tierKey]?.id ?? null;
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
 * @param {{type?: string, label?: string, baseUrl?: string, envKey?: string, models?: Record<string,string>}} cfg
 */
export function addProvider(root, name, cfg) {
  if (!name || !cfg.baseUrl) {
    return { ok: false, reason: "name and --base-url are required" };
  }
  const config = loadProviders(root);
  config.providers[name] = {
    type: cfg.type || "custom",
    label: cfg.label || name,
    baseUrl: cfg.baseUrl,
    envKey: cfg.envKey || "",
    models: cfg.models || Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.id])),
  };
  saveProviders(root, config);
  return { ok: true, name, provider: config.providers[name] };
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
    return { name: "openrouter", ...BUILTIN_PROVIDERS.openrouter, source: "OPENROUTER_API_KEY" };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return { name: "anthropic", ...BUILTIN_PROVIDERS.anthropic, source: "ANTHROPIC_API_KEY" };
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
  const customUrl =
    prov.baseUrl && prov.baseUrl.replace(/\/+$/, "").toLowerCase() !== ANTHROPIC_DEFAULT_URL;
  if (prov.type === "litellm") {
    const reachable = probeHealth(prov.baseUrl);
    checks.push({
      id: "gateway",
      ok: reachable,
      detail: reachable
        ? `LiteLLM gateway reachable at ${prov.baseUrl}`
        : `LiteLLM gateway NOT reachable at ${prov.baseUrl}`,
    });
  } else if (customUrl) {
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
    { key: "ANTHROPIC_AUTH_TOKEN", set: Boolean(process.env.ANTHROPIC_AUTH_TOKEN) },
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
 * @param {{settingsPath?: string}} [opts]
 */
export function applyRoute(tierKey, { settingsPath } = {}) {
  const target = settingsPath || join(homedir(), ".claude", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(target, "utf8"));
  } catch {}
  const modelId = MODELS[tierKey]?.id;
  if (!modelId) return { ok: false, reason: `unknown tier "${tierKey}"` };
  const prev = settings.model;
  settings.model = tierKey;
  writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  return { ok: true, model: tierKey, modelId, prev, path: target };
}
