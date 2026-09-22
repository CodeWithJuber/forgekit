// forge model catalog — turn a model FAMILY (haiku/sonnet/opus/fable) into a concrete model id,
// and a model id into a price, from LIVE catalogs instead of ids and prices pinned in code.
//
//   ids    ← the active provider's own `GET /v1/models`: the Anthropic Models API (paginated
//            `has_more`/`last_id` → `after_id`), a custom gateway's list, or OpenRouter's.
//   prices ← OpenRouter's public `GET /api/v1/models` (no key): USD per TOKEN as strings.
//
// Everything that decides is a generic rule over the catalog's own data — no model id, version or
// date is named here:
//   - family membership is a whole-token match of the family word in the id or display name;
//   - "newest" is the catalog's `created_at` (Anthropic) / `created` (OpenAI-style, OpenRouter),
//     then the parsed version, then a YYYYMMDD snapshot stamp, then the least-decorated id;
//   - an id matches a price row when their canonical token sets agree (vendor namespace, snapshot
//     date and separators ignored: `claude-opus-4-8` ↔ `anthropic/claude-opus-4.8`).
// Fetching goes through src/http_cache.js (freshness from the response's own headers). Every
// function here is total: an unavailable catalog is `null`, never a throw.
import { join } from "node:path";
import { cachedGetJson, httpGet } from "./http_cache.js";

export const ANTHROPIC_API = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
export const OPENROUTER_API = "https://openrouter.ai/api/v1";
/** Short on purpose: a catalog lookup precedes real work and must never stall it. */
export const CATALOG_TIMEOUT_MS = 3000;
// The Models API's largest page — one request lists the whole catalog in practice.
const ANTHROPIC_PAGE_LIMIT = 1000;
// A pagination guard, not a data limit: a server that repeats `has_more` forever stops here.
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Tokens and versions — shared with gateway_model_map.js.
// ---------------------------------------------------------------------------

// A version part is a short number; a date stamp (20250929) is not. A run of them is ONE token
// ("claude-3-5-sonnet" → "3.5"), because as separate "3" and "5" tokens the 5 of Sonnet 3.5
// matched the 5 of Sonnet 5 and the gateway map picked a two-generation-old model.
const isVersionPart = (t) => /^\d{1,3}$/.test(t);
const isDateStamp = (t) => /^(19|20)\d{6}$/.test(t);
const words = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Tokens of a model id or name, with consecutive version numbers collapsed into one token. */
export function tokenize(s) {
  const parts = words(s);
  const out = new Set();
  for (let i = 0; i < parts.length; ) {
    if (!isVersionPart(parts[i])) {
      out.add(parts[i++]);
      continue;
    }
    const run = [];
    while (i < parts.length && isVersionPart(parts[i])) run.push(parts[i++]);
    out.add(run.join(".").replace(/(?:\.0)+$/, ""));
  }
  return out;
}

/** The first version in an id ("claude-sonnet-4-5-20250929" → [4,5]), or null. */
export function versionOf(modelId) {
  const parts = words(modelId);
  for (let i = 0; i < parts.length; i++) {
    if (!isVersionPart(parts[i])) continue;
    const run = [];
    while (i < parts.length && isVersionPart(parts[i])) run.push(Number(parts[i++]));
    while (run.length > 1 && run[run.length - 1] === 0) run.pop();
    return run;
  }
  return null;
}

/** Newer first; an id with no version ranks last. */
export function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The YYYYMMDD snapshot stamp in an id ("claude-3-5-sonnet-20241022" → 20241022), or 0. */
export function dateStampOf(modelId) {
  const hit = words(modelId).find(isDateStamp);
  return hit ? Number(hit) : 0;
}

/** Epoch ms from a catalog timestamp: RFC 3339 string, or unix seconds/ms number. null if absent. */
export function createdMs(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * USD per token (OpenRouter's `"0.000003"` strings) → USD per million tokens (3). Rounded to 12
 * significant digits so binary float noise (2.9999999999999996) never reaches a price. Negative
 * (OpenRouter's "-1" = dynamic/variable pricing), empty or non-numeric → null.
 */
export function perMillion(perToken) {
  if (perToken == null || perToken === "") return null;
  const n = typeof perToken === "number" ? perToken : Number(String(perToken).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1e6).toPrecision(12));
}

// ---------------------------------------------------------------------------
// Catalog pages → normalized rows.
// ---------------------------------------------------------------------------

/**
 * @typedef {{id:string, displayName?:string, createdAt?:string, inCost?:number, outCost?:number}} CatalogModel
 */

/**
 * Normalize one catalog page — Anthropic (`data[]{id,display_name,created_at}` + `has_more`/
 * `last_id`), OpenAI-style (`data[]{id,created}`), OpenRouter (`data[]{id,name,created,pricing}`)
 * or a bare id array — into rows plus the cursor of the next page. null when it is not a catalog.
 * @param {any} json
 * @returns {{models: CatalogModel[], next: string|null}|null}
 */
export function normalizeCatalogPage(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
  if (!rows) return null;
  /** @type {CatalogModel[]} */
  const models = [];
  for (const r of rows) {
    const id = typeof r === "string" ? r : typeof r?.id === "string" ? r.id : "";
    if (!id) continue;
    /** @type {CatalogModel} */
    const m = { id };
    const name = r?.display_name ?? r?.name;
    if (typeof name === "string" && name) m.displayName = name;
    const created = createdMs(r?.created_at ?? r?.created);
    if (created != null) m.createdAt = new Date(created).toISOString();
    const inCost = perMillion(r?.pricing?.prompt);
    const outCost = perMillion(r?.pricing?.completion);
    if (inCost != null && outCost != null) Object.assign(m, { inCost, outCost });
    models.push(m);
  }
  const next = json?.has_more === true && typeof json?.last_id === "string" ? json.last_id : null;
  return { models, next };
}

// ---------------------------------------------------------------------------
// Family resolution.
// ---------------------------------------------------------------------------

/** Vendor namespace of an id ("anthropic/claude-opus-4.8" → "anthropic"), or "". */
export const namespaceOf = (id) => (String(id).includes("/") ? String(id).split("/")[0] : "");
const bareId = (id) => String(id).split("/").pop() ?? "";

/** True when `family` is a whole token of the model's id or display name (word-boundary match). */
export function inFamily(model, family) {
  const f = String(family ?? "").toLowerCase();
  if (!f) return false;
  return words(model?.id).includes(f) || words(model?.displayName).includes(f);
}

// Newest first: catalog creation time (a dated row beats an undated one), then the parsed version,
// then the snapshot date stamp, then the least-decorated id (fewest tokens), then lexicographic.
function newerFirst(a, b) {
  const ca = createdMs(a.createdAt) ?? Number.NEGATIVE_INFINITY;
  const cb = createdMs(b.createdAt) ?? Number.NEGATIVE_INFINITY;
  if (ca !== cb) return cb > ca ? 1 : -1;
  const byVersion = compareVersions(versionOf(a.id), versionOf(b.id));
  if (byVersion) return byVersion;
  const byStamp = dateStampOf(b.id) - dateStampOf(a.id);
  if (byStamp) return byStamp;
  const bySize = tokenize(a.id).size - tokenize(b.id).size;
  if (bySize) return bySize;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The newest catalog model of a family, or null. `namespace` restricts a multi-vendor catalog
 * (OpenRouter) to the vendor the provider is configured for. A `:variant` row
 * ("…-sonnet:thinking") is skipped when its base id is also listed.
 * @param {CatalogModel[]} models
 * @param {string} family
 * @param {{namespace?: string}} [opts]
 * @returns {CatalogModel|null}
 */
export function newestInFamily(models, family, { namespace = "" } = {}) {
  const list = (models ?? []).filter((m) => m && typeof m.id === "string" && m.id);
  const ids = new Set(list.map((m) => m.id));
  let best = null;
  for (const m of list) {
    if (namespace && namespaceOf(m.id) !== namespace) continue;
    if (m.id.includes(":") && ids.has(m.id.split(":")[0])) continue;
    if (!inFamily(m, family)) continue;
    if (!best || newerFirst(m, best) < 0) best = m;
  }
  return best;
}

/** Order-insensitive identity of a model id across catalogs: namespace, snapshot date stamps and
 *  separators dropped, version runs collapsed (`claude-haiku-4-5-20251001` ≡ `anthropic/claude-haiku-4.5`). */
export function canonicalKey(modelId) {
  return [...tokenize(bareId(String(modelId).toLowerCase()))]
    .filter((t) => !isDateStamp(t))
    .sort()
    .join(" ");
}

/**
 * The catalog row that IS `modelId` under canonicalKey, or null. An exact id wins; then a row in
 * the same namespace; then the least-decorated row.
 * @param {string} modelId
 * @param {CatalogModel[]} models
 * @returns {CatalogModel|null}
 */
export function matchCatalogModel(modelId, models) {
  if (!modelId) return null;
  const exact = (models ?? []).find((m) => m.id === modelId);
  if (exact) return exact;
  const key = canonicalKey(modelId);
  if (!key) return null;
  const ns = namespaceOf(modelId);
  const hits = (models ?? []).filter((m) => canonicalKey(m.id) === key);
  hits.sort(
    (a, b) =>
      Number(namespaceOf(b.id) === ns) - Number(namespaceOf(a.id) === ns) ||
      a.id.length - b.id.length ||
      (a.id < b.id ? -1 : 1),
  );
  return hits[0] ?? null;
}

// ---------------------------------------------------------------------------
// Which catalog, fetched how.
// ---------------------------------------------------------------------------

/**
 * @typedef {{kind:"anthropic"|"gateway"|"openrouter", url:string, headers:Record<string,string>}} CatalogSource
 * @typedef {{kind:null, reason:string}} NoCatalog
 */

const trimUrl = (u) => String(u ?? "").replace(/\/+$/, "");

/** The Anthropic Models API, authenticated with an API key (x-api-key). */
export function anthropicSource(apiKey) {
  return {
    kind: /** @type {const} */ ("anthropic"),
    url: `${ANTHROPIC_API}/v1/models?limit=${ANTHROPIC_PAGE_LIMIT}`,
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
  };
}

/** A custom gateway's `/v1/models`. Gateways differ in the auth header they read, so a raw key goes
 *  out as both x-api-key and a Bearer token; a value already prefixed "Bearer " is sent verbatim. */
export function gatewaySource(base, key = "") {
  /** @type {Record<string,string>} */
  const headers = { "anthropic-version": ANTHROPIC_VERSION };
  if (key.startsWith("Bearer ")) headers.authorization = key;
  else if (key) {
    headers["x-api-key"] = key;
    headers.authorization = `Bearer ${key}`;
  }
  return { kind: /** @type {const} */ ("gateway"), url: `${trimUrl(base)}/v1/models`, headers };
}

/** OpenRouter's public model list — ids for an OpenRouter provider, and every price. */
export function openRouterSource(base = OPENROUTER_API) {
  return { kind: /** @type {const} */ ("openrouter"), url: `${trimUrl(base)}/models`, headers: {} };
}

/** The credential a gateway reads, in the same order llm.js sends one. */
export function gatewayKey(env = process.env, envKey = "") {
  return (
    (envKey && env[envKey]) ||
    env.ANTHROPIC_API_KEY ||
    env.ANTHROPIC_AUTH_TOKEN ||
    env.LITELLM_API_KEY ||
    ""
  );
}

/** The non-default gateway base the environment points at (LITELLM_BASE_URL wins), or null. */
export function envGatewayBase(env = process.env) {
  const url = trimUrl(env.LITELLM_BASE_URL || env.ANTHROPIC_BASE_URL || "");
  if (!url || url.toLowerCase() === ANTHROPIC_API) return null;
  return url;
}

/**
 * Which live catalog lists the models the active provider serves.
 *  - no provider: derived from the environment exactly as llm.js reaches a model — a custom
 *    gateway base, else the Anthropic Models API when ANTHROPIC_API_KEY is set;
 *  - an OpenRouter provider: OpenRouter's catalog;
 *  - an Anthropic-format provider: its base (direct → Models API; anything else → gateway);
 *  - an OpenAI-format vendor (OpenAI, Gemini): none — those tiers are configured ids, not families.
 * @param {{provider?: any, env?: Record<string, string|undefined>}} [opts]
 * @returns {CatalogSource|NoCatalog}
 */
export function catalogSource({ provider = null, env = process.env } = {}) {
  if (!provider) {
    const gw = envGatewayBase(env);
    if (gw) return gatewaySource(gw, gatewayKey(env));
    if (env.ANTHROPIC_API_KEY) return anthropicSource(env.ANTHROPIC_API_KEY);
    return { kind: null, reason: "no ANTHROPIC_API_KEY for the Models API" };
  }
  if (provider.type === "openrouter") return openRouterSource(provider.baseUrl || OPENROUTER_API);
  if (provider.format === "openai")
    return { kind: null, reason: `${provider.name ?? provider.type} serves its own model ids` };
  const base = trimUrl(provider.baseUrl || ANTHROPIC_API);
  if (base.toLowerCase() === ANTHROPIC_API) {
    return env.ANTHROPIC_API_KEY
      ? anthropicSource(env.ANTHROPIC_API_KEY)
      : { kind: null, reason: "no ANTHROPIC_API_KEY for the Models API" };
  }
  return gatewaySource(base, gatewayKey(env, provider.envKey));
}

// Process-lifetime memo for the DEFAULT transport only: one CLI run asks for the same catalog
// once per tier, and a revalidation per ask would multiply requests. An injected fetchImpl (tests)
// always goes through, so every step of the HTTP cache stays observable.
const _memo = new Map();

/** Clear the per-process catalog memo (tests only). */
export function _resetCatalogMemo() {
  _memo.clear();
}

const CACHE_RANK = { fresh: 0, revalidated: 1, network: 2, stale: 3 };

/**
 * Fetch a whole catalog (following `has_more`/`last_id` → `after_id`) through the HTTP cache.
 * @param {CatalogSource} source
 * @param {{root?: string|null, fetchImpl?: Function, timeoutMs?: number, now?: number}} [opts]
 *   root → persist under `<root>/.forge/cache/`; null → memory only.
 * @returns {{models: CatalogModel[], url: string, cache: "fresh"|"revalidated"|"network"|"stale", pages: number}|null}
 *   null when the catalog is unavailable (no response and nothing cached, or a page missing)
 */
export function fetchCatalog(
  source,
  { root = null, fetchImpl, timeoutMs = CATALOG_TIMEOUT_MS, now } = {},
) {
  if (!source?.url) return null;
  const transport = typeof fetchImpl === "function" ? fetchImpl : httpGet;
  const memoKey = transport === httpGet ? `${root ?? ""}\n${source.url}` : null;
  if (memoKey && _memo.has(memoKey)) return _memo.get(memoKey);
  const dir = root ? join(root, ".forge", "cache") : null;
  let result = null;
  try {
    result = fetchPages(source, { dir, transport, timeoutMs, now: now ?? Date.now() });
  } catch {
    result = null;
  }
  if (memoKey) _memo.set(memoKey, result);
  return result;
}

function fetchPages(source, { dir, transport, timeoutMs, now }) {
  const models = [];
  const seen = new Set();
  const visited = new Set();
  /** @type {"fresh"|"revalidated"|"network"|"stale"} */
  let cache = "fresh";
  let pages = 0;
  for (let url = source.url; url && !visited.has(url) && pages < MAX_PAGES; ) {
    visited.add(url);
    const page = cachedGetJson(url, {
      headers: source.headers,
      dir,
      fetchImpl: transport,
      timeoutMs,
      now,
      transform: normalizeCatalogPage,
    });
    if (!page) return null; // a missing page makes the catalog incomplete — i.e. unavailable
    pages++;
    if (CACHE_RANK[page.cache] > CACHE_RANK[cache]) cache = page.cache;
    for (const m of page.value.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
    url = page.value.next ? withQuery(source.url, "after_id", page.value.next) : null;
  }
  return { models, url: source.url, cache, pages };
}

function withQuery(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

/** A short human label for a catalog URL ("api.anthropic.com"). */
export function catalogHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? "");
  }
}

/**
 * OpenRouter's price catalog, fetched once — pass the result as `priceCatalog` to price many ids
 * without asking again (null = tried, unavailable).
 * @param {{root?: string|null, fetchImpl?: Function, timeoutMs?: number, now?: number}} [opts]
 */
export function fetchPriceCatalog(opts = {}) {
  return fetchCatalog(openRouterSource(), opts);
}

/**
 * The live price of a model id from OpenRouter's public catalog, or null (unavailable / unlisted /
 * unpriced). Per-million USD.
 * @param {string} modelId
 * @param {{root?: string|null, fetchImpl?: Function, timeoutMs?: number, now?: number,
 *          priceCatalog?: ReturnType<typeof fetchCatalog>}} [opts] priceCatalog: a prefetched catalog
 * @returns {{inCost:number, outCost:number, matchedId:string, catalog:string, cache:string}|null}
 */
export function catalogPrice(modelId, opts = {}) {
  if (!modelId) return null;
  const cat = opts.priceCatalog !== undefined ? opts.priceCatalog : fetchPriceCatalog(opts);
  if (!cat) return null;
  const hit = matchCatalogModel(
    modelId,
    cat.models.filter((m) => m.inCost != null && m.outCost != null),
  );
  if (!hit || hit.inCost == null || hit.outCost == null) return null;
  return {
    inCost: hit.inCost,
    outCost: hit.outCost,
    matchedId: hit.id,
    catalog: cat.url,
    cache: cat.cache,
  };
}
