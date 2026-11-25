import { TIER_ORDER } from "./model_tiers.js";
import { resolveRoutePolicy } from "./orchestration.js";

export function restrictedModel(root, profile, explicit = false) {
  // A stored top-tier authorization is an operator boundary. Apply it to that
  // profile's exact endpoint model. Its historical role cannot rate other models.
  const policy = resolveRoutePolicy(root);
  const restricted = policy.topTier === "never" || (policy.topTier === "explicit" && !explicit);
  return restricted ? profile?.models?.[TIER_ORDER.at(-1)] : null;
}

// Matching an explicitly declared review category is used by the development workflow.
// Category words do not participate in model selection.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Which risk categories a task names. A keyword matches as a whole word or phrase,
 * case-insensitive, with an optional plural `s` ("payment" matches "payments", "auth" does not
 * match "author"). Pure.
 * @param {string} task
 * @param {Record<string, string[]>} categories
 * @returns {{category:string, keyword:string}[]} one entry per matching category
 */
export function riskMatches(task, categories = {}) {
  const text = String(task).toLowerCase();
  const out = [];
  for (const [category, words] of Object.entries(categories)) {
    if (!Array.isArray(words)) continue;
    const hit = words.find((w) => {
      const kw = String(w).trim().toLowerCase();
      if (!kw) return false;
      return new RegExp(`(^|[^a-z0-9])${escapeRe(kw)}s?(?=$|[^a-z0-9])`).test(text);
    });
    if (hit) out.push({ category, keyword: hit });
  }
  return out;
}
