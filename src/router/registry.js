// The model registry is data, not code: which models exist, who serves them, what they cost,
// and where any prior evidence about them came from. The shipped file (data/models.json) is a
// starting point; `.forge/models.json` in a project adds models, overrides prices or provider
// ids, and can disable entries. No model, vendor or tier is named anywhere in router code.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { violations } from "../schema.js";

/** One `.forge/models.json` entry (review A04): an override is user-edited input, so an entry
 *  with a non-finite or negative price, a non-string provider id, or no id is refused (and
 *  reported in `warnings`) instead of flowing into cost arithmetic. */
const MODEL_SPEC = /** @type {import("../schema.js").Spec} */ ({
  type: "object",
  required: ["id"],
  props: {
    id: { type: "string", nonEmpty: true, max: 200 },
    label: { type: "string", max: 200 },
    org: { type: "string", max: 200 },
    price_in: { type: "number", min: 0, max: 1e6, nullable: true },
    price_out: { type: "number", min: 0, max: 1e6, nullable: true },
    enabled: { type: "boolean" },
    providers: { type: "object" },
  },
});

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
 * @returns {{models: object[], sources: string[], warnings: string[]}}
 */
export function loadRegistry(root) {
  const base = readJson(SHIPPED) ?? { models: [] };
  const byId = new Map(base.models.map((m) => [m.id, { ...m }]));
  const sources = ["data/models.json"];
  /** @type {string[]} */
  const warnings = [];
  const localPath = root ? join(root, ".forge", "models.json") : null;
  if (localPath && existsSync(localPath)) {
    const local = readJson(localPath);
    if (local === null) warnings.push(".forge/models.json is not valid JSON — ignored");
    else if (!Array.isArray(local?.models))
      warnings.push(".forge/models.json has no `models` array — ignored");
    if (Array.isArray(local?.models)) {
      sources.push(".forge/models.json");
      for (const [i, m] of local.models.entries()) {
        const bad = violations(m, MODEL_SPEC, `models[${i}]`);
        const providers = m?.providers ?? {};
        for (const [k, v] of Object.entries(typeof providers === "object" ? providers : {}))
          if (typeof v !== "string") bad.push(`models[${i}].providers.${k}: expected a string`);
        if (bad.length) {
          warnings.push(...bad);
          continue;
        }
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
  return { models, sources, warnings };
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
