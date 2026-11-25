// Profile inventories describe metadata, not inference entitlement. Only complete, scoped
// snapshots are cached, outside the checkout. No inference request is made here.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readHostModelReports } from "./host_models.js";
import { HOSTS } from "./hosts.js";
import { currentAge, freshnessLifetime, httpGet, parseCacheControl } from "./http_cache.js";
import { readModelCalls } from "./model_call_evidence.js";
import {
  anthropicSource,
  normalizeCatalogPage,
  perMillion,
  SAFE_MODEL_ID,
} from "./model_catalog.js";
import { modelScope } from "./model_scope.js";
import { outsideWorkspace } from "./private_paths.js";
import {
  cleanModelEndpoint,
  inventoryProfiles,
  profileCredential,
  trustedModelProfile,
} from "./providers.js";
import { detectTools } from "./repo_config.js";
import { readOutcomes, routeUniversal } from "./router/index.js";
import { loadRegistry } from "./router/registry.js";
import { userStateDir } from "./util.js";

export const INVENTORY_SCHEMA_VERSION = 2;

function listing(p, key, bearer) {
  const base = cleanModelEndpoint(p.baseUrl);
  if (p.type === "gemini" && base === "https://generativelanguage.googleapis.com/v1beta/openai")
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
      headers: { "x-goog-api-key": key },
      dialect: "gemini",
    };
  if (p.type === "anthropic" && base === "https://api.anthropic.com") {
    const src = anthropicSource(key);
    if (bearer)
      return {
        ...src,
        headers: {
          "anthropic-version": src.headers["anthropic-version"],
          authorization: key.startsWith("Bearer ") ? key : `Bearer ${key}`,
        },
        dialect: "anthropic",
      };
    return { ...src, dialect: "anthropic" };
  }
  const url =
    base.endsWith("/v1") || p.format === "openai" || p.type === "openrouter"
      ? `${base}/models`
      : `${base}/v1/models`;
  return {
    url,
    headers:
      key && p.type !== "openrouter"
        ? { authorization: key.startsWith("Bearer ") ? key : `Bearer ${key}` }
        : {},
    dialect: "openai",
  };
}

const safeCapability = (x) => typeof x === "string" && /^[a-z][a-z0-9_.:/-]{0,79}$/i.test(x);
const stringList = (list) =>
  Array.isArray(list) ? [...new Set(list.filter(safeCapability))].slice(0, 100) : null;
export const AVAILABILITY_FILTERS = [
  "listed",
  "public-listed",
  "configured-only",
  "observed-only",
  "recently-callable",
  "stale",
  "denied",
  "unknown",
];

export function maxAgeSeconds(value) {
  if (value === undefined) return undefined;
  const m = /^(0|[1-9][0-9]{0,11})(s|m|h|d)?$/.exec(String(value));
  if (!m) throw new Error("Use a nonnegative --max-age in seconds or with s, m, h or d suffix");
  const seconds = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2]] ?? 1);
  if (!Number.isSafeInteger(seconds)) throw new Error("--max-age is too large");
  return seconds;
}

function decodePage(body, dialect) {
  const raw = JSON.parse(body);
  if (dialect === "gemini") {
    if (!Array.isArray(raw.models)) return null;
    return {
      models: raw.models.flatMap((r) => {
        const id = typeof r?.name === "string" ? r.name.replace(/^models\//, "") : "";
        return SAFE_MODEL_ID.test(id)
          ? [
              {
                id,
                displayName: r.displayName ?? null,
                operations: stringList(r.supportedGenerationMethods),
              },
            ]
          : [];
      }),
      next: raw.nextPageToken ?? null,
    };
  }
  if (raw?.has_more === true && !raw.last_id) return null;
  const page = normalizeCatalogPage(raw);
  if (!page) return null;
  const records = new Map((Array.isArray(raw) ? raw : raw.data).map((r) => [r?.id, r]));
  for (const m of page.models) {
    const record = records.get(m.id);
    if (!record) continue;
    const operations = stringList(record.operations);
    const declared = record.capabilities;
    const capabilities =
      stringList(declared) ??
      (declared && typeof declared === "object"
        ? Object.keys(declared).filter(
            (k) => safeCapability(k) && (declared[k] === true || declared[k]?.supported === true),
          )
        : null);
    const values = [
      ...(operations ?? []),
      ...(capabilities ?? []),
      ...(stringList(record.supported_parameters) ?? []).map((k) => `parameter:${k}`),
      ...(stringList(record.architecture?.input_modalities) ?? []).map((k) => `input:${k}`),
      ...(stringList(record.architecture?.output_modalities) ?? []).map((k) => `output:${k}`),
    ];
    Object.assign(m, {
      operations,
      capabilities: values.length || capabilities || operations ? [...new Set(values)] : null,
      cachedRead: perMillion(record.pricing?.input_cache_read),
      cachedWrite: perMillion(record.pricing?.input_cache_write),
    });
  }
  return page;
}

// Compare first attempts on the SAME verified workload tasks. Leave rows unrated until
// three groups are separated by nonoverlapping Wilson intervals. Model attribution in
// legacy outcome rows is the operator's report, even when the verifier signs the verdict.
export function workloadRatings(rows, workload = "repo-verified") {
  const attempts = new Map();
  for (const r of rows) {
    if (r.provenance !== "verify-event" || (r.workload ?? "repo-verified") !== workload) continue;
    if (!attempts.has(r.model)) attempts.set(r.model, new Map());
    const tasks = attempts.get(r.model);
    if (!tasks.has(r.task)) tasks.set(r.task, r.passed);
  }
  const ratings = new Map();
  if (!attempts.size) return ratings;
  const paired = [...attempts.values().next().value.keys()].filter((t) =>
    [...attempts.values()].every((m) => m.has(t)),
  );
  const n = paired.length;
  if (!n) return ratings;
  const z = 1.959963984540054;
  for (const [id, tasks] of attempts) {
    const score = paired.reduce((p, t) => p + Number(tasks.get(t)), 0) / n;
    const denom = 1 + (z * z) / n;
    const center = (score + (z * z) / (2 * n)) / denom;
    const error = (z * Math.sqrt((score * (1 - score)) / n + (z * z) / (4 * n * n))) / denom;
    ratings.set(id, {
      score,
      n,
      low: Math.max(0, center - error),
      high: Math.min(1, center + error),
      band: "unrated",
    });
  }
  const sorted = [...ratings.values()].sort((a, b) => a.score - b.score);
  const gaps = sorted
    .slice(1)
    .map((r, i) => ({ i, gap: r.low - sorted[i].high }))
    .filter((r) => r.gap > 0)
    .sort((a, b) => b.gap - a.gap);
  if (gaps.length >= 2) {
    const [lo, hi] = gaps
      .slice(0, 2)
      .map((r) => r.i)
      .sort((a, b) => a - b);
    sorted.forEach((r, i) => {
      r.band = i <= lo ? "low" : i <= hi ? "medium" : "high";
    });
  }
  return ratings;
}

function profileInventory(root, p, { refresh, fetchImpl, now }) {
  const declarations = [...Object.values(p.models ?? {}), p.selectedModel].filter(
    (v) => typeof v === "string" && SAFE_MODEL_ID.test(v),
  );
  /** @type {{id:string,availability:string,operations?:string[],capabilities?:string[],inCost?:number,outCost?:number,cachedRead?:number,cachedWrite?:number}[]} */
  const configured = [...new Set(declarations)].map((id) => ({
    id,
    availability: "configured-only",
  }));
  const result = (status, models = configured, checkedAt = null, details = {}) => ({
    profile: p.name,
    type: p.type,
    status,
    checkedAt,
    models,
    ...details,
  });
  if (!trustedModelProfile(root, p)) return result("untrusted");
  const { value: key, bearer } = profileCredential(p);
  if (p.envKey && !key && p.type !== "openrouter") return result("credential-missing");
  const src = listing(p, key, bearer);
  const digest = modelScope(root, "inventory", [p.name, src.url, src.dialect], key);
  const file =
    digest &&
    outsideWorkspace(
      root,
      join(userStateDir(), "model-inventory", `${digest}.json`),
      "Model inventory cache must be outside this checkout",
    );
  let cache = null;
  try {
    if (file) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(data.models) && Number.isFinite(data.at)) cache = data;
    }
  } catch {}
  const previous = (status) =>
    cache?.denied
      ? result("denied", [], new Date(cache.at).toISOString())
      : cache
        ? result(
            status,
            status === "cached"
              ? cache.models
              : cache.models.map((row) => ({
                  ...row,
                  availability: "stale",
                  lastKnownAvailability: row.availability,
                })),
            new Date(cache.at).toISOString(),
            {
              freshUntil: new Date(cache.until).toISOString(),
            },
          )
        : result(status);
  if (refresh === false || (refresh === undefined && cache && now < cache.until))
    return previous(cache ? (now < cache.until ? "cached" : "stale") : "offline");
  const models = new Map();
  let next = src.url,
    until = Infinity,
    persistent = true;
  const seen = new Set();
  const deadline = performance.now() + 10000;
  while (next) {
    if (seen.size >= 100 || seen.has(next) || performance.now() >= deadline)
      return previous("partial");
    seen.add(next);
    let reply;
    try {
      reply = fetchImpl({
        url: next,
        headers: src.headers,
        timeoutMs: Math.min(3000, Math.max(1, deadline - performance.now())),
      });
    } catch {
      return previous(seen.size > 1 ? "partial" : "unavailable");
    }
    if (reply?.status === 401 || reply?.status === 403) {
      writeSnapshot({ at: now, until: now, denied: true, models: [] });
      return result("denied", [], new Date(now).toISOString());
    }
    if (reply?.status === 429) return previous("rate-limited");
    if (!reply || reply.status < 200 || reply.status >= 300)
      return previous(seen.size > 1 ? "partial" : "unavailable");
    let page;
    try {
      page = decodePage(reply.body, src.dialect);
    } catch {}
    if (!page) return previous("partial");
    const headers = Object.fromEntries(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    persistent &&= !parseCacheControl(headers["cache-control"])["no-store"];
    until = Math.min(
      until,
      now + Math.max(0, freshnessLifetime(headers, now) - currentAge(headers, now, now)) * 1000,
    );
    for (const row of page.models)
      models.set(row.id, {
        ...row,
        availability: p.type === "openrouter" ? "public-listed" : "listed",
      });
    if (!page.next) break;
    const u = new URL(src.url);
    const cursor = { gemini: "pageToken", anthropic: "after_id", openai: "after" };
    u.searchParams.set(cursor[src.dialect], page.next);
    next = u.href;
  }
  const snapshot = {
    at: now,
    until,
    models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  if (persistent) writeSnapshot(snapshot);
  else if (file) rmSync(file, { force: true });
  return result("complete", snapshot.models, new Date(now).toISOString(), {
    freshUntil: new Date(until).toISOString(),
  });
  function writeSnapshot(data) {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

export function nativeModelControls(root) {
  const reports = readHostModelReports(root);
  const detected = detectTools(root).map(
    (tool) => Object.keys(HOSTS).find((h) => HOSTS[h].tool === tool) ?? tool,
  );
  return [...new Set([...detected, ...Object.keys(reports)])].sort().map((host) => ({
    host,
    control: "host-managed",
    reportedModel: reports[host]?.id ?? null,
    observedAt: reports[host]?.observedAt ?? null,
    source: reports[host]?.source ?? null,
  }));
}

function workloadCosts(rows, workload) {
  const byModel = new Map();
  for (const row of rows) {
    if ((row.workload ?? "repo-verified") !== workload || !Number.isFinite(row.cost)) continue;
    const stat = byModel.get(row.model) ?? { total: 0, n: 0 };
    stat.total += row.cost;
    stat.n++;
    byModel.set(row.model, stat);
  }
  return byModel;
}

function inventoryPrice(p, m, binding, checkedAt) {
  const units = { currency: "USD", unit: "million tokens" };
  if (
    p.type === "openrouter" &&
    cleanModelEndpoint(p.baseUrl) === "https://openrouter.ai/api/v1" &&
    m.inCost != null &&
    m.outCost != null
  )
    return {
      ...units,
      source: "provider-catalog",
      asOf: checkedAt,
      input: m.inCost,
      output: m.outCost,
      cacheRead: m.cachedRead ?? null,
      cacheWrite: m.cachedWrite ?? null,
    };
  if (binding?.price_in == null || binding?.price_out == null) return null;
  const ref = typeof binding.price_source === "string" ? binding.price_source : null;
  return {
    ...units,
    source: "registry-reference",
    reference: ref,
    asOf:
      binding.price_as_of ??
      ref?.match(/(?:checked|pricingVerified) (\d{4}-\d{2}-\d{2})/)?.[1] ??
      null,
    input: binding.price_in,
    output: binding.price_out,
    cacheRead: null,
    cacheWrite: null,
  };
}

/** @param {string} root @param {{profile?:string,workload?:string,refresh?:boolean,now?:number,fetchImpl?:Function,capability?:string,availability?:string,maxAge?:string|number}} options */
export function modelInventory(
  root,
  {
    profile,
    capability,
    availability,
    maxAge,
    workload = "repo-verified",
    refresh = undefined,
    now = Date.now(),
    fetchImpl = httpGet,
  } = {},
) {
  const seconds = maxAgeSeconds(maxAge);
  if (capability !== undefined && !safeCapability(capability))
    throw new Error("Invalid model capability");
  if (availability !== undefined && !AVAILABILITY_FILTERS.includes(availability))
    throw new Error("Unknown availability filter");
  if (availability === "recently-callable" && seconds === undefined)
    throw new Error("Specify --max-age for recently-callable evidence");
  let profiles = inventoryProfiles(root);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(workload)) throw new Error("Invalid workload name");
  if (profile) {
    profiles = profiles.filter((p) => p.name === profile);
    if (!profiles.length) throw new Error(`Unknown or inactive model profile: ${profile}`);
  }
  const outcomes = readOutcomes(root);
  const ratings = workloadRatings(outcomes, workload);
  const costs = workloadCosts(outcomes, workload);
  const registry = loadRegistry(root);
  const results = profiles.map((p) => {
    let r;
    try {
      r = profileInventory(root, p, { refresh, now, fetchImpl });
    } catch {
      r = { profile: p.name, type: p.type, status: "unavailable", checkedAt: null, models: [] };
    }
    const bindings = new Map();
    for (const item of registry.models) {
      const id = item.providers?.[p.name];
      if (id) bindings.set(id, bindings.has(id) ? null : item);
    }
    const calls = ["untrusted", "credential-missing", "denied"].includes(r.status)
      ? new Map()
      : readModelCalls(root, p, profileCredential(p).value);
    if (["offline", "unavailable", "partial", "rate-limited", "stale"].includes(r.status)) {
      const ids = new Set(r.models.map((m) => m.id));
      for (const id of calls.keys())
        if (!ids.has(id)) r.models.push({ id, availability: "observed-only" });
    }
    const models = [];
    for (const m of r.models) {
      const binding = bindings.get(m.id);
      const call = calls.get(m.id);
      const caps = m.capabilities ?? m.operations ?? null;
      const listedAt = !["configured-only", "observed-only"].includes(m.availability)
        ? Date.parse(r.checkedAt)
        : NaN;
      const callAt = call?.at;
      const lastEvidence =
        Number.isFinite(callAt) && (!Number.isFinite(listedAt) || callAt > listedAt)
          ? callAt
          : listedAt;
      const available = call?.status === "denied" ? "denied" : m.availability;
      const observedAt =
        availability === "recently-callable" || available === "denied"
          ? callAt
          : availability && ["listed", "stale", "public-listed"].includes(availability)
            ? listedAt
            : lastEvidence;
      const inWindow =
        Number.isFinite(observedAt) &&
        observedAt <= now &&
        (seconds === undefined || now - observedAt <= seconds * 1000);
      if (seconds !== undefined && !inWindow) continue;
      if (availability === "recently-callable") {
        if (call?.status !== "success") continue;
      } else if (availability === "unknown") {
        if (Number.isFinite(lastEvidence)) continue;
      } else if (availability && available !== availability) continue;
      if (
        capability &&
        !(caps?.includes(capability) || (capability === "unknown" && caps === null))
      )
        continue;
      const cost = costs.get(binding?.id);
      const at = Number.isFinite(callAt) ? new Date(callAt).toISOString() : null;
      models.push({
        ...m,
        availability: available,
        catalogAvailability: m.availability,
        operations: m.operations ?? null,
        capabilities: caps,
        availabilityEvidence: {
          checkedAt: Number.isFinite(listedAt) ? new Date(listedAt).toISOString() : null,
          lastCallAt: at,
          lastCallStatus: call?.status ?? null,
          ageSeconds:
            Number.isFinite(lastEvidence) && lastEvidence <= now
              ? Math.floor((now - lastEvidence) / 1000)
              : null,
        },
        price: inventoryPrice(p, m, binding, r.checkedAt),
        lastCall: call
          ? {
              status: call.status,
              at,
              returned: call.returned,
              latencyMs: call.latencyMs,
              costUsd: call.costUsd,
              source: "scoped-http-dispatch",
            }
          : null,
        workloadAttemptCost: cost
          ? {
              meanUsd: cost.total / cost.n,
              n: cost.n,
              source: "operator-reported",
              scope: "registry-model",
            }
          : null,
        rating: ratings.get(binding?.id) ?? { band: "unrated", n: 0 },
      });
    }
    return {
      ...r,
      models,
      filters: {
        capability: capability ?? null,
        availability: availability ?? null,
        maxAgeSeconds: seconds ?? null,
      },
    };
  });
  const nativeHosts = nativeModelControls(root);
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    workload,
    modelControl: {
      forgeHttp: "profile-selected",
      nativeAgent: "host-managed",
      harness: "pinned-route",
    },
    nativeHosts,
    ratingBasis:
      "relative to common repo tasks, first attempt, verified verdict, operator-reported model",
    profiles: results,
  };
}

/** Match fresh, account-listed wire IDs to exact registry bindings before evaluating the cost/quality objective. */
export function inventoryRoute(
  root,
  task,
  {
    profile,
    band = undefined,
    workload = undefined,
    refresh = false,
    objective = undefined,
    maxDepth = undefined,
  },
) {
  if (typeof task !== "string" || !task.trim() || task.length > 16384)
    throw new Error("Supply a task of at most 16384 characters");
  if (!profile || profile === "any") throw new Error("Choose an exact provider profile");
  if (band !== undefined && !["low", "medium", "high"].includes(band))
    throw new Error("Choose low, medium or high");
  const inventory = modelInventory(root, { profile, workload, refresh });
  const listing = inventory.profiles[0];
  const registry = loadRegistry(root);
  const eligible = new Set(
    listing.models
      .filter((m) => m.availability === "listed" && (!band || m.rating.band === band))
      .map((m) => m.id),
  );
  const candidates = registry.models
    .filter((m) => eligible.has(m.providers?.[profile]))
    .map((m) => m.id);
  if (!candidates.length)
    return {
      ok: false,
      profile,
      listing: listing.status,
      reason:
        "No matching current account listing and registry binding for the requested workload and band",
    };
  return {
    ...routeUniversal(root, task, { provider: profile, registry, candidates, objective, maxDepth }),
    profile,
    listing: listing.status,
    checkedAt: listing.checkedAt,
    workload: inventory.workload,
    band: band ?? null,
  };
}
