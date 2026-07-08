// forge providers — multi-provider model configuration. Supports Anthropic (default),
// OpenRouter, and custom API endpoints. Config lives in .forge/providers.json; defaults
// are hardcoded so the system works with zero config. Never stores API keys — only env
// var names (the key is resolved at runtime from the environment).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MODELS } from "./model_tiers.js";

const PROVIDERS_FILE = "providers.json";
const PROVIDERS_DIR = ".forge";

function providersPath(root) {
  return join(root, PROVIDERS_DIR, PROVIDERS_FILE);
}

const BUILTIN_PROVIDERS = {
  anthropic: {
    type: "anthropic",
    label: "Anthropic (direct)",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    models: Object.fromEntries(
      Object.entries(MODELS).map(([key, m]) => [key, m.id]),
    ),
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
};

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

/** The active provider config. */
export function activeProvider(root = process.cwd()) {
  const config = loadProviders(root);
  const name = config.active;
  const provider = config.providers[name];
  if (!provider) return { name: "anthropic", ...BUILTIN_PROVIDERS.anthropic };
  return { name, ...provider };
}

/** Resolve a tier key (haiku/sonnet/opus/fable) to the active provider's model ID. */
export function resolveModel(root, tierKey) {
  const provider = activeProvider(root);
  return provider.models?.[tierKey] ?? MODELS[tierKey]?.id ?? null;
}

/** Switch the active provider. Returns the new active config. */
export function setProvider(root, name) {
  const config = loadProviders(root);
  if (!config.providers[name]) {
    return { ok: false, reason: `unknown provider "${name}" — add it first with forge config provider add` };
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
    models: cfg.models || Object.fromEntries(
      Object.entries(MODELS).map(([key, m]) => [key, m.id]),
    ),
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
