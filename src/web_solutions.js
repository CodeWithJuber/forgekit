// Optional web results for public solution discovery. The caller supplies a separately
// authored public query or the hook's closed-vocabulary terms. Keys alone never opt in.
import { hasSecret, redactSecrets } from "./secrets.js";

const PROVIDERS = {
  serper: {
    label: "Google (Serper)",
    key: "SERPER_API_KEY",
    url: "https://google.serper.dev/search",
    header: "X-API-KEY",
  },
  brave: {
    label: "Brave Search",
    key: "BRAVE_SEARCH_API_KEY",
    url: "https://api.search.brave.com/res/v1/web/search",
    header: "X-Subscription-Token",
  },
};
const cooldowns = new Map();
const MAX_BYTES = 512 * 1024;

function safeText(value, size) {
  return typeof value === "string"
    ? redactSecrets(
        value
          .slice(0, 2048)
          .replace(/<[^<>]*>/g, "")
          .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ).slice(0, size)
    : "";
}
function link(value) {
  if (typeof value !== "string" || value.length > 1200 || /[\p{Cc}\p{Cf}]/u.test(value))
    return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      hasSecret(url.href)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function parsed(response) {
  const parts = [];
  let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("size limit");
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

function retrySeconds(value) {
  const seconds =
    value && /^\d+$/.test(value)
      ? Number(value)
      : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
}

/** One bounded query to an explicitly selected public provider. Never fetch search-result links.
 * @param {string} publicQuery
 * @param {{env?:Record<string,string>,fetchImpl?:typeof fetch,timeoutMs?:number,limit?:number}} [options]
 */
export async function searchWebSolutions(
  publicQuery,
  { env = process.env, fetchImpl = fetch, timeoutMs = 5000, limit = 3 } = {},
) {
  const id = env.FORGE_WEB_SEARCH_PROVIDER;
  const empty = { provider: null, results: [], warnings: [], checkedAt: null };
  if (!id || id === "off") return empty;
  if (!Object.hasOwn(PROVIDERS, id))
    return { ...empty, warnings: ["Unknown web search provider. Choose serper or brave."] };
  const provider = PROVIDERS[id];
  const report = { ...empty, provider: provider.label };
  const warn = (msg) => ({ ...report, warnings: [msg] });
  if (env.FORGE_NO_CATALOG_FETCH === "1") return warn("External web search is offline.");
  if (!env[provider.key]) return warn(`Set ${provider.key} for ${provider.label}.`);
  if (
    typeof publicQuery !== "string" ||
    !publicQuery.trim() ||
    publicQuery.length > 240 ||
    /[\p{Cc}\p{Cf}]/u.test(publicQuery) ||
    hasSecret(publicQuery)
  )
    return warn("Supply a short, single-line public search query without credentials.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(limit) || limit < 1)
    return warn("Web search needs a positive timeout and result limit.");
  const pending = cooldowns.get(id) ?? 0;
  if (pending > Date.now())
    return warn(
      `${provider.label} rate limit; retry after ${Math.ceil((pending - Date.now()) / 1000)} seconds.`,
    );
  const q = publicQuery.trim(),
    count = Math.min(5, limit);
  const url = new URL(provider.url);
  const headers = { Accept: "application/json", [provider.header]: env[provider.key] };
  const request = /** @type {RequestInit} */ ({
    redirect: "error",
    credentials: "omit",
    headers,
    signal: AbortSignal.timeout(Math.max(1, Math.min(10000, Math.floor(timeoutMs)))),
  });
  if (id === "serper") {
    request.method = "POST";
    headers["Content-Type"] = "application/json";
    request.body = JSON.stringify({ q, num: count });
  } else {
    url.searchParams.set("q", q);
    url.searchParams.set("count", String(count));
    url.searchParams.set("text_decorations", "false");
  }
  report.checkedAt = new Date().toISOString();
  try {
    const res = await fetchImpl(url.href, request);
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 429) {
        const seconds = retrySeconds(res.headers.get("retry-after"));
        cooldowns.set(id, Date.now() + seconds * 1000);
        return warn(`${provider.label} rate limit; retry after ${seconds} seconds.`);
      }
      return warn(`${provider.label} returned HTTP ${res.status}.`);
    }
    const data = await parsed(res);
    const raw = id === "serper" ? data.organic : data.web?.results;
    if (!Array.isArray(raw)) return warn(`${provider.label} returned no organic result list.`);
    const seen = new Set();
    for (const row of raw) {
      const url = link(id === "serper" ? row?.link : row?.url),
        title = safeText(row?.title, 180);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      report.results.push({
        title,
        url,
        snippet: safeText(id === "serper" ? row.snippet : row.description, 500),
      });
      if (report.results.length >= count) break;
    }
    return report;
  } catch {
    // Third-party errors can echo request headers, query strings or an API response.
    return warn(
      `${provider.label} search unavailable or returned an invalid or oversized response.`,
    );
  }
}
