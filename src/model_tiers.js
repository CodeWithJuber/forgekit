// forge model tiers — the routing target table. Cheapest capable model per complexity tier.
// Costs are per-million tokens (input/output). The premise: a prime-number finder does not
// need Fable 5. Size the model to the task.
//
// A tier names a model FAMILY (its key: haiku/sonnet/opus/fable). The concrete id and price are
// RESOLVED at the point of use (resolveTierModel / resolveTierPrice): the newest model of that
// family in the active provider's live catalog, priced from OpenRouter's public catalog (see
// src/model_catalog.js). model_tiers.json is the shipped SNAPSHOT — the data of last resort when
// no catalog is reachable — and keeps its `pricingVerified` date so `forge doctor` can say when
// the snapshot itself went stale. Nothing on the hook hot path resolves; only the places that
// need a concrete id or price do (the LLM runner, the gateway config, the cost estimate,
// `forge route`, `forge models`).
import { readFileSync } from "node:fs";
import {
  canonicalKey,
  catalogHost,
  catalogPrice,
  catalogSource,
  fetchCatalog,
  inFamily,
  namespaceOf,
  newestInFamily,
} from "./model_catalog.js";
import { loadRegistry } from "./router/registry.js";

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
 * @param {Record<string, any>} [models] the tier table; defaults to model_tiers.json
 * @returns {{inCost:number, outCost:number}|null}
 */
export function priceOf(key, date = today(), models = MODELS) {
  const m = models[key];
  if (!m) return null;
  for (const w of m.prices || []) {
    if (date >= w.effectiveFrom && (!w.effectiveUntil || date <= w.effectiveUntil)) {
      return { inCost: w.inCost, outCost: w.outCost };
    }
  }
  return { inCost: m.inCost, outCost: m.outCost };
}

/** Every distinct price pair across flat + scheduled windows — used by the docs check so a
 *  documented introductory/standard price isn't flagged as stale.
 *  @param {Record<string, any>} [models] the tier table; defaults to model_tiers.json */
export function allPricePairs(models = MODELS) {
  const pairs = [];
  for (const m of Object.values(models)) {
    pairs.push({ inCost: m.inCost, outCost: m.outCost });
    for (const w of m.prices || []) pairs.push({ inCost: w.inCost, outCost: w.outCost });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Runtime resolution: family → newest concrete id, id → live price.
// ---------------------------------------------------------------------------

/** The family word a tier stands for (its key, unless the table names one explicitly). */
export const familyOfTier = (tier) => MODELS[tier]?.family ?? tier;

/** The tier whose family a model id belongs to (whole-token match), or null. */
export function tierOfModel(modelId) {
  return TIER_ORDER.find((t) => inFamily({ id: modelId }, familyOfTier(t))) ?? null;
}

/** True when `id` (vendor namespace ignored) is the shipped snapshot's id — for `tier` when
 *  given, else for any tier: a family placeholder a catalog may replace, as opposed to an explicit
 *  id someone configured on purpose.
 *  @param {string|null|undefined} id
 *  @param {string} [tier] */
export function isSnapshotId(id, tier) {
  if (!id) return false;
  const bare = String(id).split("/").pop();
  const rows = tier ? [MODELS[tier]].filter(Boolean) : Object.values(MODELS);
  return rows.some((m) => m.id === bare);
}

/**
 * @typedef {object} ResolveOpts
 * @property {string|null} [root] project root; catalogs persist under `<root>/.forge/cache/` (null = memory only)
 * @property {any} [provider] the active provider (providers.js); omitted → derived from env like llm.js
 * @property {Record<string, string|undefined>} [env] environment to read keys/base URLs from (default process.env)
 * @property {Function} [fetchImpl] injectable transport `({url, headers, timeoutMs}) => {status, headers, body}|null`
 * @property {number} [timeoutMs] per-request timeout
 * @property {number} [now] clock for cache freshness (epoch ms)
 */

/**
 * @typedef {object} ResolvedModel
 * @property {string} id concrete model id to send
 * @property {string} family the family word the tier names
 * @property {"catalog"|"snapshot"|"config"} source where the id came from
 * @property {string} [createdAt] catalog creation time (ISO), catalog source only
 * @property {string} [displayName]
 * @property {string} [catalog] catalog URL, catalog source only
 * @property {string} [cache] fresh | revalidated | network | stale
 * @property {string} [reason] why the catalog was not used (snapshot source)
 */

/**
 * Resolve a tier to a concrete model id. Chain, each step only when the previous is unavailable:
 *   1. an explicit, non-snapshot id configured for the tier (a gateway alias, another vendor's
 *      model) is honored verbatim — `source: "config"`;
 *   2. the newest model of the tier's family in the provider's live catalog (fresh cache, or a
 *      revalidated/refetched response, or the last cached copy when the request fails) —
 *      `source: "catalog"`;
 *   3. the shipped snapshot id (model_tiers.json, or the provider's configured snapshot id) —
 *      `source: "snapshot"`, with the reason the catalog was not used.
 * Never throws; network calls are short and only happen here, never on import.
 * @param {string} tier
 * @param {ResolveOpts} [opts]
 * @returns {ResolvedModel|null} null for an unknown tier
 */
export function resolveTierModel(tier, opts = {}) {
  const m = MODELS[tier];
  if (!m) return null;
  const family = familyOfTier(tier);
  const configured = opts.provider?.models?.[tier] ?? null;
  if (configured && !isSnapshotId(configured, tier))
    return { id: configured, family, source: "config" };
  const snapshotId = configured ?? m.id;
  /** @type {ResolvedModel} */
  const snapshot = { id: snapshotId, family, source: "snapshot", displayName: m.name };
  try {
    const src = /** @type {any} */ (catalogSource(opts));
    if (!src.kind) return { ...snapshot, reason: src.reason };
    const host = catalogHost(src.url);
    const cat = fetchCatalog(src, opts);
    if (!cat) return { ...snapshot, reason: `${host} catalog unavailable` };
    const pick = newestInFamily(cat.models, family, { namespace: namespaceOf(snapshotId) });
    if (!pick) return { ...snapshot, reason: `no ${family} model in the ${host} catalog` };
    return {
      id: pick.id,
      family,
      source: "catalog",
      ...(pick.createdAt ? { createdAt: pick.createdAt } : {}),
      ...(pick.displayName ? { displayName: pick.displayName } : {}),
      catalog: cat.url,
      cache: cat.cache,
    };
  } catch {
    return snapshot;
  }
}

/**
 * @typedef {object} ResolvedPrice
 * @property {number} inCost USD per million input tokens
 * @property {number} outCost USD per million output tokens
 * @property {"catalog"|"snapshot"} source
 * @property {"exact"|"registry"|"family"} [basis] snapshot only: the id's own row, the registry's row, or the family tier's
 * @property {string} [matchedId] the catalog/registry row that priced it
 * @property {string} [catalog]
 * @property {string} [cache]
 */

// Snapshot prices for an id, most specific first: the tier table's own row (with its dated
// windows), then the universal router's registry (data/models.json + .forge/models.json), then the
// tier of the id's family. The registry is read lazily and once.
let _registry = null;
function registryModels(root) {
  if (!_registry || _registry.root !== root)
    _registry = { root, models: loadRegistry(root ?? null).models };
  return _registry.models;
}

/**
 * @param {string} modelId
 * @param {{date?: string, root?: string|null}} [opts]
 * @returns {ResolvedPrice|null}
 */
function snapshotPrice(modelId, { date, root } = {}) {
  const key = canonicalKey(modelId);
  const own = TIER_ORDER.find((t) => canonicalKey(MODELS[t].id) === key);
  if (own)
    return { ...priceOf(own, date), source: "snapshot", basis: "exact", matchedId: MODELS[own].id };
  for (const r of registryModels(root)) {
    if (r.price_in == null || r.price_out == null) continue;
    const ids = [r.id, r.run_model_id, ...Object.values(r.providers ?? {})].filter(Boolean);
    if (ids.some((id) => canonicalKey(id) === key))
      return {
        inCost: r.price_in,
        outCost: r.price_out,
        source: "snapshot",
        basis: "registry",
        matchedId: r.id,
      };
  }
  const tier = tierOfModel(modelId);
  if (tier)
    return {
      ...priceOf(tier, date),
      source: "snapshot",
      basis: "family",
      matchedId: MODELS[tier].id,
    };
  return null;
}

/**
 * Price an arbitrary model id (per million tokens): the live OpenRouter catalog, else the
 * snapshot (exact row → registry → the family's tier). null when nothing prices it — callers
 * report it as unpriced rather than guessing a number.
 * @param {string} modelId
 * @param {ResolveOpts & {date?: string, priceCatalog?: any}} [opts] priceCatalog: a catalog from
 *   model_catalog.fetchPriceCatalog, to price many ids with one lookup
 * @returns {ResolvedPrice|null}
 */
export function resolveModelPrice(modelId, opts = {}) {
  if (!modelId) return null;
  try {
    const live = catalogPrice(modelId, opts);
    if (live) return { ...live, source: "catalog" };
  } catch {}
  try {
    return snapshotPrice(modelId, opts);
  } catch {
    return null;
  }
}

/**
 * The price of a tier's RESOLVED model: live when OpenRouter lists that id, else the tier's
 * snapshot price (its dated window for `opts.date`) — but only for a model of the tier's own
 * family: a configured id from another vendor or a gateway alias is not priced as a Claude tier
 * (null = unknown). Pass `resolved` to reuse a resolution.
 * @param {string} tier
 * @param {ResolveOpts & {date?: string, resolved?: ResolvedModel|null}} [opts]
 * @returns {ResolvedPrice|null}
 */
export function resolveTierPrice(tier, opts = {}) {
  if (!MODELS[tier]) return null;
  const resolved = opts.resolved ?? resolveTierModel(tier, opts);
  if (!resolved) return null;
  try {
    const live = catalogPrice(resolved.id, opts);
    if (live) return { ...live, source: "catalog" };
  } catch {}
  if (!inFamily(resolved, familyOfTier(tier))) return null;
  const exact = canonicalKey(resolved.id) === canonicalKey(MODELS[tier].id);
  return {
    ...priceOf(tier, opts.date),
    source: "snapshot",
    basis: exact ? "exact" : "family",
    matchedId: MODELS[tier].id,
  };
}

/**
 * Every tier resolved at once — the data behind `forge models`.
 * @param {ResolveOpts & {date?: string}} [opts]
 */
export function resolveTiers(opts = {}) {
  return TIER_ORDER.map((tier) => {
    const model = resolveTierModel(tier, opts);
    const price = resolveTierPrice(tier, { ...opts, resolved: model });
    return { tier, class: MODELS[tier].tier, family: familyOfTier(tier), model, price };
  });
}

/**
 * One line saying where a resolved id came from — shown by `forge route`, `forge models` and the
 * gateway config, so a user can always see WHY a tier maps to the id it does.
 * @param {ResolvedModel|null} r
 * @returns {string}
 */
export function describeResolution(r) {
  if (!r) return "";
  if (r.source === "catalog") {
    const created = r.createdAt ? `, created ${r.createdAt.slice(0, 10)}` : "";
    const stale = r.cache === "stale" ? ", last cached copy (catalog unreachable)" : "";
    return `newest ${r.family} in the ${catalogHost(r.catalog)} catalog${created}${stale}`;
  }
  if (r.source === "config") return "configured for this provider";
  return `shipped snapshot, pricing verified ${PRICING_VERIFIED}${r.reason ? ` (${r.reason})` : ""}`;
}
