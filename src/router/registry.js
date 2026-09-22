// The model registry is data, not code: which models exist, who serves them, what they cost,
// and where any prior evidence about them came from. The shipped file (data/models.json) is a
// starting point; `.forge/models.json` in a project adds models, overrides prices or provider
// ids, and can disable entries. No model, vendor or tier is named anywhere in router code.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHIPPED = new URL("../../data/models.json", import.meta.url);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string|null} root project root (for .forge/models.json), or null
 * @returns {{models: object[], sources: string[]}}
 */
export function loadRegistry(root) {
  const base = readJson(SHIPPED) ?? { models: [] };
  const byId = new Map(base.models.map((m) => [m.id, { ...m }]));
  const sources = ["data/models.json"];
  const localPath = root ? join(root, ".forge", "models.json") : null;
  if (localPath && existsSync(localPath)) {
    const local = readJson(localPath);
    if (local?.models) {
      sources.push(".forge/models.json");
      for (const m of local.models) {
        if (!m?.id) continue;
        const prev = byId.get(m.id) ?? {};
        byId.set(m.id, {
          ...prev,
          ...m,
          providers: { ...(prev.providers ?? {}), ...(m.providers ?? {}) },
        });
      }
    }
  }
  const models = [...byId.values()].filter((m) => m.enabled !== false);
  return { models, sources };
}

/**
 * Registry ids a provider can serve. "any" returns every enabled model (advice only: the caller
 * must still map ids to a provider before applying).
 * @param {{models: object[]}} registry
 * @param {string} provider
 */
export function servableBy(registry, provider) {
  if (!provider || provider === "any") return registry.models.map((m) => m.id);
  return registry.models.filter((m) => m.providers?.[provider]).map((m) => m.id);
}
