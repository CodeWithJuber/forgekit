// forge gateway model map — remap complexity tiers onto a CUSTOM gateway's real model IDs.
//
// The problem: model_tiers.json's snapshot carries public Anthropic IDs (claude-haiku-4-5-…).
// A self-hosted LiteLLM/proxy gateway rarely exposes those exact names — it advertises its
// OWN ids (e.g. "bedrock-claude-haiku", "prod-sonnet", "claude-3-5-sonnet-v2"). Sending a
// stock id straight to such a gateway 404s. So we ask the gateway what it actually serves
// (GET /v1/models, once per process, through src/model_catalog.js) and pick, per tier, the
// NEWEST advertised model of that tier's family — the same generic rule resolveTierModel applies
// to the Anthropic Models API: family word as a whole token, then catalog creation time, then the
// parsed version. The overlap score (src/math.js setOverlap) is still reported so a pick can be
// inspected.
//
// Contract (zero breaking change):
//   - Only engages for a NON-default gateway base URL. Direct api.anthropic.com → no-op here
//     (direct users resolve through resolveTierModel, which needs ANTHROPIC_API_KEY).
//   - FAIL-SAFE. No gateway, unreachable, unparseable, or no family match → returns the stock
//     id unchanged. Callers are byte-identical to before when there is nothing to remap.
//   - The MODELS export shape is untouched; nothing here mutates model_tiers.
import { setOverlap } from "./math.js";
import {
  CATALOG_TIMEOUT_MS,
  envGatewayBase,
  fetchCatalog,
  gatewayKey,
  gatewaySource,
  newestInFamily,
  tokenize,
  versionOf,
} from "./model_catalog.js";
import { familyOfTier, MODELS, TIER_ORDER } from "./model_tiers.js";

export { versionOf };

// Process-lifetime cache: base URL -> string[] (advertised ids) | null (fetched, none usable).
// "Once per process" is the whole point — the ambient LLM path must not re-probe on every call.
const _catalogCache = new Map();

/** Clear the per-process /v1/models cache (tests only). */
export function _resetGatewayCache() {
  _catalogCache.clear();
}

/**
 * The active gateway base URL to remap against, or null when there is nothing to remap.
 * Mirrors llm.js resolution (LITELLM_BASE_URL wins, then ANTHROPIC_BASE_URL). The default
 * Anthropic endpoint returns null so direct-API users never trigger a gateway probe or remap.
 * @returns {string|null}
 */
export function gatewayBase() {
  return envGatewayBase(process.env);
}

/** GET {base}/v1/models through the shared catalog fetcher (memory only, never persisted here). */
function defaultFetch(base, timeoutMs) {
  const cat = fetchCatalog(gatewaySource(base, gatewayKey(process.env)), { timeoutMs });
  return cat ? cat.models.map((m) => m.id) : null;
}

/**
 * Fetch (and cache once per process) the model ids a gateway advertises at /v1/models.
 * @param {string} base gateway base URL (no trailing slash)
 * @param {{timeoutMs?: number, fetchImpl?: (base:string)=>string[]}} [opts] fetchImpl is injectable for tests
 * @returns {string[]|null} advertised ids, or null on any failure
 */
export function fetchModelIds(base, { timeoutMs = CATALOG_TIMEOUT_MS, fetchImpl } = {}) {
  if (!base) return null;
  if (_catalogCache.has(base)) return _catalogCache.get(base);
  let ids = null;
  try {
    ids = fetchImpl ? fetchImpl(base) : defaultFetch(base, timeoutMs);
  } catch {
    ids = null;
  }
  const clean = Array.isArray(ids)
    ? [...new Set(ids.filter((x) => typeof x === "string" && x))]
    : null;
  const result = clean?.length ? clean : null;
  _catalogCache.set(base, result);
  return result;
}

/** Reference token set for a tier: the family key plus its marketing-name tokens (e.g. haiku → {haiku,"4.5"}). */
export function familyTokens(tier) {
  return tokenize(`${tier} ${MODELS[tier]?.name ?? ""}`);
}

/**
 * Score how well a gateway model id matches a tier's snapshot model, in [0,1] — reported with
 * each pick so it can be inspected. The family word itself (haiku/sonnet/opus/fable) is a HARD
 * gate — absent it, the id is not a candidate for that tier (score 0), so an unrelated model can
 * never be mis-assigned. Present it, the score is the overlap coefficient of the tier's reference
 * tokens with the id's tokens ("claude-sonnet-5" scores 1.0 for sonnet; "prod-sonnet" lower).
 * @param {string} modelId
 * @param {string} tier
 * @returns {number}
 */
export function familyScore(modelId, tier) {
  const toks = tokenize(modelId);
  if (!toks.has(familyOfTier(tier))) return 0; // family word MUST be present
  return setOverlap(familyTokens(tier), toks);
}

/**
 * Pure: given a gateway's advertised ids, pick per tier the NEWEST id of that tier's family
 * (catalog order rules in model_catalog.newestInFamily: version, snapshot date, then the id
 * closest to the canonical name). Unrelated ids are never assigned.
 * @param {Array<string|{id:string, displayName?:string, createdAt?:string}>} ids
 * @returns {Record<string,{id:string, score:number}>} only tiers with a family match appear
 */
export function buildGatewayMap(ids = []) {
  const rows = [];
  const seen = new Set();
  for (const x of ids || []) {
    const row = typeof x === "string" ? { id: x } : x;
    if (!row || typeof row.id !== "string" || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  /** @type {Record<string,{id:string, score:number}>} */
  const map = {};
  for (const tier of TIER_ORDER) {
    const pick = newestInFamily(rows, familyOfTier(tier));
    if (pick) map[tier] = { id: pick.id, score: familyScore(pick.id, tier) };
  }
  return map;
}

/**
 * The tier→gateway-model mapping for the active gateway. Fetches /v1/models (cached) and picks.
 * @param {{base?: string, fetchImpl?: (base:string)=>string[], timeoutMs?: number}} [opts]
 * @returns {{active:boolean, base:(string|null), reachable?:boolean, catalog?:string[], models:Record<string,{id:string,score:number}>}}
 */
export function gatewayModelMap({ base, fetchImpl, timeoutMs } = {}) {
  const b = base ?? gatewayBase();
  if (!b) return { active: false, base: null, models: {} };
  const ids = fetchModelIds(b, { fetchImpl, timeoutMs });
  if (!ids) return { active: true, base: b, reachable: false, models: {} };
  return {
    active: true,
    base: b,
    reachable: true,
    catalog: ids,
    models: buildGatewayMap(ids),
  };
}

/**
 * Resolve a tier to a gateway model id, or return `fallbackId` unchanged (silent fallback).
 * It never throws and never blocks a direct-API user.
 * @param {string} tier
 * @param {string} fallbackId the stock id to use when there is nothing to remap
 * @param {{base?: string, fetchImpl?: (base:string)=>string[], timeoutMs?: number}} [opts]
 * @returns {string}
 */
export function gatewayModelId(tier, fallbackId, opts = {}) {
  try {
    const m = gatewayModelMap(opts);
    return m.models?.[tier]?.id ?? fallbackId;
  } catch {
    return fallbackId;
  }
}
