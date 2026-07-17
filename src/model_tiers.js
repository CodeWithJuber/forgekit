// forge model tiers — the routing target table. Cheapest capable model per complexity tier.
// Costs are per-million tokens (input/output). The premise: a prime-number finder does not
// need Fable 5. Size the model to the task. Data lives in model_tiers.json so rotation is
// a config change, not a code change.
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("./model_tiers.json", import.meta.url), "utf8"));

/** Currency for every inCost/outCost below. */
export const PRICING_CURRENCY = data.pricingCurrency;
/** Date the prices were last checked. `forge doctor` warns when this goes stale (re-verify via dev-radar). */
export const PRICING_VERIFIED = data.pricingVerified;

export const MODELS = data.models;

/** Cheap → expensive. */
export const TIER_ORDER = data.tierOrder;

/** Today as an ISO date (YYYY-MM-DD). Isolated so callers can inject a date in tests. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Resolve a model's price for a given date. A model may carry a `prices` schedule of
 * `{effectiveFrom, effectiveUntil?, inCost, outCost}` windows (e.g. an introductory rate);
 * the active window for `date` wins, otherwise we fall back to the flat inCost/outCost
 * (steady-state). This is why a single `pricingVerified` date is no longer enough (P0-12).
 * @param {string} key model key (haiku/sonnet/opus/fable)
 * @param {string} [date] ISO date; defaults to today
 * @returns {{inCost:number, outCost:number}|null}
 */
export function priceOf(key, date = today()) {
  const m = MODELS[key];
  if (!m) return null;
  for (const w of m.prices || []) {
    if (date >= w.effectiveFrom && (!w.effectiveUntil || date <= w.effectiveUntil)) {
      return { inCost: w.inCost, outCost: w.outCost };
    }
  }
  return { inCost: m.inCost, outCost: m.outCost };
}

/** Every distinct price pair across flat + scheduled windows — used by the docs check so a
 *  documented introductory/standard price isn't flagged as stale. */
export function allPricePairs() {
  const pairs = [];
  for (const m of Object.values(MODELS)) {
    pairs.push({ inCost: m.inCost, outCost: m.outCost });
    for (const w of m.prices || []) pairs.push({ inCost: w.inCost, outCost: w.outCost });
  }
  return pairs;
}
