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
