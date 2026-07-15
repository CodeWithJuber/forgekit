// forge gateway model map — remap complexity tiers onto a CUSTOM gateway's real model IDs.
//
// The problem: model_tiers.json pins public Anthropic IDs (claude-haiku-4-5-20251001, …).
// A self-hosted LiteLLM/proxy gateway rarely exposes those exact names — it advertises its
// OWN ids (e.g. "bedrock-claude-haiku", "prod-sonnet", "claude-3-5-sonnet-v2"). Sending a
// stock id straight to such a gateway 404s. So we ask the gateway what it actually serves
// (GET /v1/models, once per process) and SCORE each advertised id against every tier's family
// — the same DATA-is-a-table / DECISION-is-a-formula rule the rest of forge follows: the tier
// families are data, the pick is a graded overlap score (src/math.js setOverlap), inspectable
// and testable.
//
// Contract (zero breaking change):
//   - Only engages for a NON-default gateway base URL. Direct api.anthropic.com → no-op, no net.
//   - FAIL-SAFE. No gateway, unreachable, unparseable, or no family match → returns the stock
//     id unchanged. Callers are byte-identical to before when there is nothing to remap.
//   - The MODELS export shape is untouched; nothing here mutates model_tiers.
import { spawnSync } from "node:child_process";
import { setOverlap } from "./math.js";
import { MODELS, TIER_ORDER } from "./model_tiers.js";

const ANTHROPIC_DEFAULT = "https://api.anthropic.com";

// GET {base}/v1/models in a spawned node child so this module stays synchronous like every
// other forge faculty (embed.js / llm.js pattern). The auth key travels via the child's env
// (_FORGE_LLM_KEY) — never in argv, never logged. Accepts both OpenAI-shaped ({data:[{id}]})
// and Anthropic-shaped ({data:[{id}]}) catalogs; both key the list under data[].id.
const FETCH_CHILD = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,timeoutMs}=JSON.parse(raw);const key=process.env._FORGE_LLM_KEY||"";const headers={"anthropic-version":"2023-06-01"};if(key.startsWith("Bearer ")){headers.authorization=key;}else if(key){headers["x-api-key"]=key;headers.authorization="Bearer "+key;}const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),timeoutMs||5000);let res;try{res=await fetch(url,{headers,signal:ac.signal});}finally{clearTimeout(timer);}if(!res.ok){process.stderr.write("http "+res.status);process.exit(1);}const data=await res.json();const rows=Array.isArray(data)?data:Array.isArray(data&&data.data)?data.data:[];const ids=rows.map((m)=>(typeof m==="string"?m:m&&m.id)).filter((x)=>typeof x==="string"&&x);process.stdout.write(JSON.stringify(ids));}catch(e){process.stderr.write(String((e&&e.message)||e));process.exit(1);}});`;

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
 * Anthropic endpoint returns null so direct-API users never trigger a probe or a remap.
 * @returns {string|null}
 */
export function gatewayBase() {
  const url = (process.env.LITELLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || "").replace(
    /\/+$/,
    "",
  );
  if (!url) return null;
  if (url.toLowerCase() === ANTHROPIC_DEFAULT) return null; // direct Anthropic — stock ids are correct
  return url;
}

function apiKey() {
  return (
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.LITELLM_API_KEY ||
    ""
  );
}

function spawnFetch(base, timeoutMs) {
  const r = spawnSync(process.execPath, ["-e", FETCH_CHILD], {
    input: JSON.stringify({ url: `${base}/v1/models`, timeoutMs }),
    encoding: "utf8",
    timeout: timeoutMs + 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, _FORGE_LLM_KEY: apiKey() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  const ids = JSON.parse(r.stdout);
  return Array.isArray(ids) ? ids : null;
}

/**
 * Fetch (and cache once per process) the model ids a gateway advertises at /v1/models.
 * @param {string} base gateway base URL (no trailing slash)
 * @param {{timeoutMs?: number, fetchImpl?: (base:string)=>string[]}} [opts] fetchImpl is injectable for tests
 * @returns {string[]|null} advertised ids, or null on any failure
 */
export function fetchModelIds(base, { timeoutMs = 5000, fetchImpl } = {}) {
  if (!base) return null;
  if (_catalogCache.has(base)) return _catalogCache.get(base);
  let ids = null;
  try {
    ids = fetchImpl ? fetchImpl(base) : spawnFetch(base, timeoutMs);
  } catch {
    ids = null;
  }
  const clean = Array.isArray(ids)
    ? [...new Set(ids.filter((x) => typeof x === "string" && x))]
    : null;
  const result = clean && clean.length ? clean : null;
  _catalogCache.set(base, result);
  return result;
}

const tokenize = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/** Reference token set for a tier: the family key plus its marketing-name tokens (e.g. haiku → {haiku,4,5}). */
export function familyTokens(tier) {
  return tokenize(`${tier} ${MODELS[tier]?.name ?? ""}`);
}

/**
 * Score how well a gateway model id belongs to a tier family, in [0,1].
 * The family word itself (haiku/sonnet/opus/fable) is a HARD gate — absent it, the id is not a
 * candidate for that tier (score 0), so an unrelated model can never be mis-assigned. Present it,
 * the score is the overlap coefficient of the tier's reference tokens with the id's tokens, which
 * rewards a version match ("claude-sonnet-5" scores 1.0 for sonnet; "prod-sonnet" scores lower).
 * @param {string} modelId
 * @param {string} tier
 * @returns {number}
 */
export function familyScore(modelId, tier) {
  const toks = tokenize(modelId);
  if (!toks.has(tier)) return 0; // family word MUST be present
  return setOverlap(familyTokens(tier), toks);
}

// Deterministic tie-break among equal-scoring candidates: prefer the id closest to the canonical
// name (fewest tokens — less vendor/deployment noise), then lexicographic for stability.
function tieBreak(a, b) {
  const na = tokenize(a).size;
  const nb = tokenize(b).size;
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pure: given a gateway's advertised ids, pick the best id per tier by family score.
 * @param {string[]} ids
 * @returns {Record<string,{id:string, score:number}>} only tiers with a family match appear
 */
export function buildGatewayMap(ids = []) {
  const list = [...new Set((ids || []).filter((x) => typeof x === "string" && x))];
  /** @type {Record<string,{id:string, score:number}>} */
  const map = {};
  for (const tier of TIER_ORDER) {
    let best = null;
    for (const id of list) {
      const score = familyScore(id, tier);
      if (score <= 0) continue;
      if (!best || score > best.score || (score === best.score && tieBreak(id, best.id) < 0)) {
        best = { id, score };
      }
    }
    if (best) map[tier] = best;
  }
  return map;
}

/**
 * The tier→gateway-model mapping for the active gateway. Fetches /v1/models (cached) and scores.
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
 * This is the one function callers reach for: it never throws and never blocks a direct-API user.
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
