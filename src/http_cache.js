// forge http cache — a small PRIVATE HTTP cache for the JSON catalogs forge reads (model lists,
// model prices). The one rule: freshness comes from the RESPONSE, never from a constant in this
// code. A response is reused without a request only while its own `Cache-Control: max-age` /
// `Expires` says it is fresh (RFC 9111 §4.2); otherwise the next use sends a CONDITIONAL request
// (`If-None-Match` / `If-Modified-Since`) and a `304` refreshes the stored copy. A response with
// no caching headers therefore revalidates on every use — forge never invents a TTL.
//
// When the request fails (offline, timeout, non-2xx, unparseable body) the stored copy is served
// and marked `stale`: the caller's next fallback (the shipped snapshot) is older data still, so a
// stale catalog beats it. `no-store` responses are used once and never written.
//
// Transport: a spawned node child running global fetch, so this module stays SYNCHRONOUS like
// every other forge faculty (the embed.js / llm.js pattern). Request headers — including any
// credential — travel on the child's stdin, never argv, and are never logged or persisted.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, readJsonSafe } from "./util.js";

/** Response headers the cache reads. The child forwards only these; nothing else is stored. */
export const CACHE_HEADERS = ["cache-control", "expires", "date", "age", "etag", "last-modified"];

// GET one URL: stdin {url, headers, timeoutMs, keep} → stdout {status, headers, body}. Any HTTP
// status is returned (a 304 is an answer, not a failure); only a network error/timeout exits 1.
const GET_CHILD = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,headers,timeoutMs,keep}=JSON.parse(raw);const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),timeoutMs||3000);try{const res=await fetch(url,{headers,signal:ac.signal});const h={};for(const k of keep){const v=res.headers.get(k);if(v!=null)h[k]=v;}const body=res.status===304?"":await res.text();process.stdout.write(JSON.stringify({status:res.status,headers:h,body}));}finally{clearTimeout(timer);}}catch(e){process.stderr.write(String((e&&e.message)||e));process.exit(1);}});`;

/**
 * The default transport: one synchronous GET. `FORGE_NO_CATALOG_FETCH=1` turns it off (air-gapped
 * machines, and the test suite's hermetic boundary) — callers then see "unavailable" and fall back
 * to the cached copy or the snapshot. Never throws.
 * @param {{url:string, headers?:Record<string,string>, timeoutMs?:number}} req
 * @returns {{status:number, headers:Record<string,string>, body:string}|null} null on network failure
 */
export function httpGet({ url, headers = {}, timeoutMs = 3000 }) {
  if (process.env.FORGE_NO_CATALOG_FETCH === "1") return null;
  try {
    const r = spawnSync(process.execPath, ["-e", GET_CHILD], {
      input: JSON.stringify({ url, headers, timeoutMs, keep: CACHE_HEADERS }),
      encoding: "utf8",
      timeout: timeoutMs + 2000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    const res = JSON.parse(r.stdout);
    return Number.isInteger(res?.status) ? res : null;
  } catch {
    return null;
  }
}

/** `Cache-Control` → directive map (`max-age=60, no-cache` → {"max-age":"60","no-cache":true}). */
export function parseCacheControl(value) {
  /** @type {Record<string, string|true>} */
  const out = {};
  for (const part of String(value ?? "").split(",")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    const arg = rest.join("=").trim().replace(/^"|"$/g, "");
    out[name.toLowerCase()] = arg === "" ? true : arg;
  }
  return out;
}

/** Lower-case header names; drop non-string values. */
function lowerHeaders(h) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

const pickCacheHeaders = (h) =>
  Object.fromEntries(CACHE_HEADERS.filter((k) => k in h).map((k) => [k, h[k]]));

/**
 * Freshness lifetime in seconds, from the response alone (RFC 9111 §4.2.1, private cache):
 * `no-store`/`no-cache` → 0; `max-age` wins over `Expires`; `Expires` counts from the response's
 * `Date` (or when it was received). No explicit freshness → 0, i.e. revalidate on next use — no
 * heuristic lifetime, no default TTL.
 * @param {Record<string,string>} headers stored response headers (lower-case)
 * @param {number} receivedAt epoch ms the response arrived
 */
export function freshnessLifetime(headers, receivedAt) {
  const cc = parseCacheControl(headers["cache-control"]);
  if (cc["no-store"] || cc["no-cache"]) return 0;
  if (cc["max-age"] !== undefined) {
    const maxAge = Number(cc["max-age"]);
    return Number.isFinite(maxAge) ? Math.max(0, maxAge) : 0;
  }
  if (headers.expires) {
    const expires = Date.parse(headers.expires);
    if (!Number.isFinite(expires)) return 0; // an invalid Expires means "already expired"
    const date = Date.parse(headers.date ?? "");
    return Math.max(0, (expires - (Number.isFinite(date) ? date : receivedAt)) / 1000);
  }
  return 0;
}

/** Current age in seconds (RFC 9111 §4.2.3): the larger of the `Age` header and the apparent
 *  age at receipt, plus the time the copy has been resident here. */
export function currentAge(headers, receivedAt, now) {
  const ageHeader = Number(headers.age);
  const ageValue = Number.isFinite(ageHeader) && ageHeader > 0 ? ageHeader : 0;
  const date = Date.parse(headers.date ?? "");
  const apparent = Number.isFinite(date) ? Math.max(0, (receivedAt - date) / 1000) : 0;
  return Math.max(apparent, ageValue) + Math.max(0, (now - receivedAt) / 1000);
}

/** Is a stored record still fresh at `now`? */
export function isFresh(record, now) {
  return (
    freshnessLifetime(record.headers, record.receivedAt) >
    currentAge(record.headers, record.receivedAt, now)
  );
}

/** The on-disk file for a URL: readable host prefix + a hash of the full URL. */
export function cacheFile(dir, url) {
  let host = "url";
  try {
    host = new URL(url).host.replace(/[^a-z0-9.-]+/gi, "_");
  } catch {}
  return join(dir, `${host}-${contentHash(url).slice(0, 12)}.json`);
}

function readRecord(file, url) {
  const rec = file ? readJsonSafe(file) : null;
  return rec && rec.url === url && rec.headers && Number.isFinite(rec.receivedAt) && "value" in rec
    ? rec
    : null;
}

// The cache directory ignores itself, like the ledger's derived `.state-cache.json`: a nested
// `.gitignore` of `*` keeps every cached catalog (and the ignore file) out of git whether or not
// `forge init` has written `.forge/.gitignore` yet.
function writeRecord(dir, file, record) {
  try {
    mkdirSync(dir, { recursive: true });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore))
      writeFileSync(
        ignore,
        "# forge HTTP cache — derived, re-fetched on demand, never committed\n*\n",
      );
    writeFileSync(file, JSON.stringify(record));
  } catch {} // a read-only checkout simply revalidates on every use
}

/**
 * GET a JSON document through the cache. Order of preference:
 *   1. a stored copy that is still fresh by its own headers — no request;
 *   2. the network — conditional when a validator is stored (`304` → the stored copy, refreshed);
 *   3. the stored copy, marked stale, when the request fails or the body is unusable.
 * `transform` maps the parsed body to the value that is stored and returned (e.g. a normalized
 * catalog page); a transform that returns null/undefined marks the response unusable.
 * @param {string} url
 * @param {{headers?:Record<string,string>, dir?:string|null, fetchImpl?:(req:{url:string,headers:Record<string,string>,timeoutMs:number})=>({status:number,headers?:Record<string,string>,body?:string}|null),
 *          timeoutMs?:number, now?:number, transform?:(json:any)=>any}} [opts]
 *   `dir` null → memory only (nothing persisted). `fetchImpl` is the injectable transport.
 * @returns {{value:any, cache:"fresh"|"revalidated"|"network"|"stale", url:string}|null}
 */
export function cachedGetJson(
  url,
  {
    headers = {},
    dir = null,
    fetchImpl = httpGet,
    timeoutMs = 3000,
    now = Date.now(),
    transform = (x) => x,
  } = {},
) {
  const file = dir ? cacheFile(dir, url) : null;
  const stored = readRecord(file, url);
  if (stored && isFresh(stored, now)) return { value: stored.value, cache: "fresh", url };

  const reqHeaders = { ...headers };
  if (stored?.headers.etag) reqHeaders["if-none-match"] = stored.headers.etag;
  if (stored?.headers["last-modified"])
    reqHeaders["if-modified-since"] = stored.headers["last-modified"];
  let res = null;
  try {
    res = fetchImpl({ url, headers: reqHeaders, timeoutMs });
  } catch {
    res = null;
  }

  if (res && res.status === 304 && stored) {
    // RFC 9111 §4.3.4: the 304's headers update the stored ones. A 304 without Date/Age must not
    // inherit the OLD Date, or the refreshed copy would look as old as the original response.
    const fresh = lowerHeaders(res.headers);
    const merged = { ...stored.headers, ...pickCacheHeaders(fresh) };
    for (const k of ["date", "age"]) if (!(k in fresh)) delete merged[k];
    const record = { ...stored, receivedAt: now, headers: merged };
    if (file && !parseCacheControl(merged["cache-control"])["no-store"])
      writeRecord(dir, file, record);
    return { value: stored.value, cache: "revalidated", url };
  }

  if (res && res.status >= 200 && res.status < 300) {
    let value = null;
    try {
      value = transform(JSON.parse(String(res.body ?? "")));
    } catch {
      value = null;
    }
    if (value != null) {
      const h = pickCacheHeaders(lowerHeaders(res.headers));
      if (file && !parseCacheControl(h["cache-control"])["no-store"])
        writeRecord(dir, file, { v: 1, url, receivedAt: now, headers: h, value });
      return { value, cache: "network", url };
    }
  }

  return stored ? { value: stored.value, cache: "stale", url } : null;
}
