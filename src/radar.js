// forge radar — dependency-currency rings (I4 verified currency; paper crosswalk GAP 4).
//
// MIZAN (evidence-proportional judgment): every ring ships with the evidence that earned
// it, and MISSING evidence NEVER upgrades a dep. A dep with too little verified evidence
// lands in "assess" — never "adopt" on the strength of what we could not check. The rings
// are a FORMULA over registry evidence (no hardcoded package lists): staleness half-life,
// major-version lag, security advisories, deprecation. Usage (atlas import-sites) is STAKES,
// not risk — it only sorts and scales priority, never the risk score itself.
//
// Fail-safe by construction: nothing here throws to a caller. Network I/O is injectable
// (fetchImpl) so tests never touch the network, and the pre-edit advisory is CACHE-ONLY —
// a hook never fetches. The `dev-radar` skill is the LLM wide scan; `forge radar` is the
// deterministic repo instrument that reads THIS repo's manifests.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { clamp01, epochDay } from "./util.js";

const read = (root, rel) => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
};
const readJson = (root, rel) => {
  const t = read(root, rel);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

// A range forge cannot probe against a public registry: workspace protocol, a local path,
// a git/url dependency. Listed honestly as "local" (unprobed), never silently upgraded.
const LOCAL_RANGE_RE = /^(workspace:|file:|link:|git\+|git:|https?:|github:|[./])/;

/**
 * @typedef {{range:string, source:"dependencies"|"devDependencies", installed:(string|null),
 *   local:boolean}} ManifestDep
 */

/**
 * Read this repo's Node manifests into a currency-probe worklist. Node-first and honest:
 * other ecosystems detected by the stack detector are returned in `skipped` rather than
 * pretended-about. Fail-safe — an unreadable/corrupt manifest yields an empty result.
 * @param {string} [root]
 * @returns {{deps:Record<string,ManifestDep>, skipped:{language:string, reason:string}[]}}
 */
export function depsFromManifests(root = process.cwd()) {
  /** @type {Record<string,ManifestDep>} */
  const deps = {};
  /** @type {{language:string, reason:string}[]} */
  const skipped = [];
  const pkg = readJson(root, "package.json");
  if (pkg) {
    const lock = readJson(root, "package-lock.json");
    const installedOf = installedFromLock(lock);
    for (const source of /** @type {const} */ (["dependencies", "devDependencies"])) {
      const map = pkg[source] || {};
      for (const name of Object.keys(map)) {
        if (name in deps) continue; // a prod dep shadows a dev dep of the same name
        const range = String(map[name] ?? "");
        deps[name] = {
          range,
          source,
          installed: installedOf(name),
          local: LOCAL_RANGE_RE.test(range),
        };
      }
    }
  }
  // Other ecosystems: named honestly as unprobed rather than silently ignored.
  for (const language of otherLanguages(root))
    skipped.push({ language, reason: "currency probe is Node-first" });
  return { deps, skipped };
}

/** Languages present besides JS/TS (so the CLI can say "not probed" honestly). */
function otherLanguages(root) {
  const out = [];
  const has = (rel) => existsSync(join(root, rel));
  if (has("go.mod")) out.push("Go");
  if (has("Cargo.toml")) out.push("Rust");
  if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile") || has("setup.py"))
    out.push("Python");
  if (has("Gemfile")) out.push("Ruby");
  if (has("composer.json")) out.push("PHP");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) out.push("Java/Kotlin");
  return out;
}

/** Installed-version lookup from a package-lock (v2/v3 `packages`, then legacy `dependencies`). */
function installedFromLock(lock) {
  if (!lock || typeof lock !== "object") return () => null;
  const packages = lock.packages && typeof lock.packages === "object" ? lock.packages : null;
  const legacy =
    lock.dependencies && typeof lock.dependencies === "object" ? lock.dependencies : null;
  return (name) => {
    if (packages) {
      const v = packages[`node_modules/${name}`]?.version;
      if (typeof v === "string" && v) return v;
    }
    if (legacy) {
      const v = legacy[name]?.version;
      if (typeof v === "string" && v) return v;
    }
    return null;
  };
}

/** Weights (mizan): the data table. Every ring states which of these earned it. */
export const RADAR_WEIGHTS = Object.freeze({
  staleness: 0.35,
  majorLag: 0.3,
  advisory: 0.9,
  deprecated: 1.0,
});
export const STALENESS_HALF_LIFE_DAYS = 540;
export const ADVISORY_SEVERITY = Object.freeze({
  critical: 1,
  high: 0.7,
  moderate: 0.4,
  low: 0.2,
});
export const RING_THRESHOLDS = Object.freeze({ adopt: 0.25, trial: 0.5 });
export const MIN_EVIDENCE_FOR_ADOPT = 2;

const MS_PER_DAY = 86400000;
/** Leading integer of a semver-ish string ("^5.2.0" → 5), or null. */
function majorOf(v) {
  const m = /(\d+)/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * @typedef {{installed:(string|null), latest:(string|null), publishedAt:(number|null),
 *   deprecated:(boolean|null), advisories:(Array<{severity?:string,title?:string,url?:string}>|null)}} DepEvidence
 */

/**
 * Classify one dependency into a ring from its evidence — a pure formula, no package lists.
 * Absent evidence is never scored as zero risk (it is simply not averaged in), so a dep we
 * could not verify degrades to "assess", never "adopt". Hard gates (deprecated / critical
 * advisory) win over the score. Every returned ring carries its calibration `reasons`.
 * @param {DepEvidence} evidence
 * @param {number} nowDay epoch-day of the scan
 * @returns {{ring:"adopt"|"trial"|"assess"|"hold", score:number,
 *   signals:Record<string,number>, evidenceKinds:number, reasons:string[], hasAdvisory:boolean}}
 */
export function classifyDep(evidence, nowDay = epochDay()) {
  const ev = /** @type {DepEvidence} */ (evidence || {});
  /** @type {Record<string,number>} */
  const signals = {};
  const reasons = [];
  let critical = false;

  // staleness — present iff we know when latest was published.
  if (typeof ev.publishedAt === "number" && Number.isFinite(ev.publishedAt)) {
    const days = Math.max(0, (nowDay * MS_PER_DAY - ev.publishedAt) / MS_PER_DAY);
    signals.staleness = clamp01(1 - 0.5 ** (days / STALENESS_HALF_LIFE_DAYS));
    if (days >= STALENESS_HALF_LIFE_DAYS)
      reasons.push(
        `latest published ${Math.round(days)}d ago (half-life ${STALENESS_HALF_LIFE_DAYS}d)`,
      );
  }
  // major lag — present iff we know both installed and latest.
  const im = majorOf(ev.installed);
  const lm = majorOf(ev.latest);
  if (im != null && lm != null) {
    const behind = Math.max(0, lm - im);
    signals.majorLag = clamp01(behind / 3);
    if (behind > 0) reasons.push(`${behind} major${behind > 1 ? "s" : ""} behind (v${im}→v${lm})`);
  }
  // advisories — present iff the advisories probe succeeded (empty array = "none known", risk 0).
  if (Array.isArray(ev.advisories)) {
    let max = 0;
    let top = null;
    for (const a of ev.advisories) {
      const sev = String(a?.severity ?? "").toLowerCase();
      const w = ADVISORY_SEVERITY[sev] ?? 0;
      if (sev === "critical") critical = true;
      if (w > max) {
        max = w;
        top = a;
      }
    }
    signals.advisory = max;
    if (top)
      reasons.push(
        `${String(top.severity ?? "").toLowerCase()} advisory: ${String(top.title ?? "security advisory")}`,
      );
  }
  // deprecation — present iff we fetched metadata (null = unknown, not "not deprecated").
  if (ev.deprecated === true || ev.deprecated === false) {
    signals.deprecated = ev.deprecated ? 1 : 0;
    if (ev.deprecated) reasons.push("marked deprecated by its maintainer");
  }

  const kinds = Object.keys(signals);
  let num = 0;
  let den = 0;
  for (const k of kinds) {
    const w = RADAR_WEIGHTS[k] ?? 0;
    num += w * signals[k];
    den += w;
  }
  const score = den > 0 ? clamp01(num / den) : 0;

  // Hard gates first: a deprecated or critically-vulnerable dep is "hold" regardless of freshness.
  /** @type {"adopt"|"trial"|"assess"|"hold"} */
  let ring;
  if (signals.deprecated === 1 || critical) {
    ring = "hold";
  } else if (kinds.length < MIN_EVIDENCE_FOR_ADOPT) {
    ring = "assess"; // too little verified evidence — never adopt on absence
    reasons.push(`only ${kinds.length} evidence kind${kinds.length === 1 ? "" : "s"} verified`);
  } else if (score < RING_THRESHOLDS.adopt) {
    ring = "adopt";
  } else if (score < RING_THRESHOLDS.trial) {
    ring = "trial";
  } else {
    ring = "assess";
  }
  return {
    ring,
    score,
    signals,
    evidenceKinds: kinds.length,
    reasons,
    hasAdvisory: Array.isArray(ev.advisories) && ev.advisories.length > 0,
  };
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const ABBREVIATED = "application/vnd.npm.install-v1+json";

/**
 * Probe a registry for currency evidence. Injectable + never throws. Per-name failures
 * degrade that dep's evidence to "missing" (so it lands in assess) rather than faking a
 * clean bill of health; a total network failure returns `{ok:false}` so the caller can
 * serve stale cache honestly.
 * @param {string[]} names
 * @param {{fetchImpl?:typeof fetch, timeoutMs?:number, registry?:string,
 *   installed?:Record<string,(string|null)>}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string,
 *   results:Record<string,DepEvidence>, errors:string[]}>}
 */
export async function probeRegistry(names, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 4000;
  const registry = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const installedMap = opts.installed ?? {};
  /** @type {Record<string,DepEvidence>} */
  const results = {};
  const errors = [];
  if (!fetchImpl || !names?.length) return { ok: !names?.length, results, errors };

  const getJson = async (url, headers) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers, signal: ac.signal });
      if (!res?.ok) throw new Error(`http ${res ? res.status : "?"}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  let anyOk = false;
  // Per-package metadata.
  for (const name of names) {
    /** @type {DepEvidence} */
    const ev = {
      installed: installedMap[name] ?? null,
      latest: null,
      publishedAt: null,
      deprecated: null,
      advisories: null,
    };
    try {
      const doc = await getJson(`${registry}/${encodeURIComponent(name)}`, {
        Accept: ABBREVIATED,
      });
      const latest = doc?.["dist-tags"]?.latest ?? null;
      ev.latest = typeof latest === "string" ? latest : null;
      const ver = ev.latest ? doc?.versions?.[ev.latest] : null;
      // null = unknown (never verified), NOT "not deprecated": if the latest version's
      // entry is absent from the metadata we could not check, so classifyDep must not
      // count a spurious evidence kind (mizan — missing evidence never upgrades a dep).
      ev.deprecated = ver ? Boolean(ver.deprecated) : null;
      const t = doc?.time || {};
      const when = (ev.latest && t[ev.latest]) || t.modified || null;
      const ms = when ? Date.parse(when) : NaN;
      ev.publishedAt = Number.isFinite(ms) ? ms : null;
      anyOk = true;
    } catch (err) {
      errors.push(`${name}: metadata ${String(err?.message ?? err)}`);
    }
    results[name] = ev;
  }

  // One bulk advisories probe. Failure ⇒ advisories evidence stays MISSING (null) — the
  // documented cut-line: degrade to assess, never assert "zero advisories".
  try {
    const body = {};
    for (const name of names)
      body[name] = [results[name]?.installed || results[name]?.latest].filter(Boolean);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let bulk;
    try {
      const res = await fetchImpl(`${registry}/-/npm/v1/security/advisories/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res?.ok) throw new Error(`http ${res ? res.status : "?"}`);
      bulk = await res.json();
    } finally {
      clearTimeout(timer);
    }
    for (const name of names) {
      const list = Array.isArray(bulk?.[name]) ? bulk[name] : [];
      if (results[name])
        results[name].advisories = list.map((a) => ({
          severity: a?.severity,
          title: a?.title,
          url: a?.url,
        }));
    }
    anyOk = true;
  } catch (err) {
    errors.push(`advisories: ${String(err?.message ?? err)}`);
  }

  return { ok: anyOk, results, errors };
}

/**
 * Usage as STAKES (not risk): how many `imports` edges in the cached atlas reference each
 * dep. Missing atlas → {} (degrade). External deps live as unresolved edges whose raw
 * target is the specifier, so we match `name`, `name/sub`, and `name.member`.
 * @param {string} root
 * @param {string[]} names
 * @returns {Record<string,number>}
 */
export function usageFromAtlas(root, names) {
  /** @type {Record<string,number>} */
  const counts = {};
  for (const n of names) counts[n] = 0;
  let atlas;
  try {
    const p = join(root, ".forge", "atlas.json");
    if (!existsSync(p)) return counts;
    atlas = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return counts;
  }
  const edges = Array.isArray(atlas?.edges) ? atlas.edges : [];
  for (const e of edges) {
    if (e?.kind !== "imports") continue;
    const target = String(e.target ?? "");
    for (const n of names) {
      if (target === n || target.startsWith(`${n}/`) || target.startsWith(`${n}.`)) {
        counts[n]++;
        break;
      }
    }
  }
  return counts;
}

// --- cache -----------------------------------------------------------------

export const radarCachePath = (root = process.cwd()) => join(root, ".forge", "radar.json");

/** Cache TTL in hours (FORGE_RADAR_TTL_H, default 24, NaN-safe). */
export function radarTtlHours() {
  const raw = Number(process.env.FORGE_RADAR_TTL_H);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

/** Read the radar cache, or null (missing/corrupt). */
export function readRadarCache(root = process.cwd()) {
  try {
    const p = radarCachePath(root);
    if (!existsSync(p)) return null;
    const c = JSON.parse(readFileSync(p, "utf8"));
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

function writeRadarCache(root, payload) {
  try {
    mkdirSync(join(root, ".forge"), { recursive: true });
    writeFileSync(radarCachePath(root), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Deps in a scan result whose ring warrants a pre-edit warning (hold, or assess-with-advisory). */
function riskyDeps(deps) {
  const out = new Set();
  for (const [name, d] of Object.entries(deps || {})) {
    if (d?.ring === "hold" || (d?.ring === "assess" && d?.hasAdvisory)) out.add(name);
  }
  return out;
}

/**
 * Orchestrate a currency scan. Never throws. Serves fresh cache within TTL; offline serves
 * stale cache (flagged) or fails honestly; online probes, classifies, caches, and records
 * I4 evidence + a metrics line (network scans only — a cache replay must not re-mint evidence).
 * @param {string} root
 * @param {{fetchImpl?:typeof fetch, offline?:boolean, refresh?:boolean, now?:number,
 *   nowDay?:number, registry?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, source?:string, stale?:boolean, ageH?:number,
 *   deps?:Record<string,any>, skipped?:any[], reason?:string, errors?:string[]}>}
 */
export async function radarScan(root = process.cwd(), opts = {}) {
  const nowMs = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const nowDay = Number.isFinite(opts.nowDay) ? Number(opts.nowDay) : epochDay();
  const cache = readRadarCache(root);
  const ttlMs = radarTtlHours() * 3600000;
  const ageH = cache ? (nowMs - (cache.t ?? 0)) / 3600000 : Infinity;
  const fresh = cache && nowMs - (cache.t ?? 0) < ttlMs;

  if (fresh && !opts.refresh)
    return {
      ok: true,
      source: "cache",
      deps: cache.deps ?? {},
      skipped: cache.skipped ?? [],
    };

  if (opts.offline) {
    if (cache)
      return {
        ok: true,
        source: "cache",
        stale: true,
        ageH,
        deps: cache.deps ?? {},
        skipped: cache.skipped ?? [],
      };
    return {
      ok: false,
      reason: "no cache and --offline (run online once to build one)",
    };
  }

  const { deps: manifest, skipped } = depsFromManifests(root);
  const names = Object.keys(manifest).filter((n) => !manifest[n].local);
  /** @type {Record<string,(string|null)>} */
  const installed = {};
  for (const [n, d] of Object.entries(manifest)) installed[n] = d.installed;

  const probe = await probeRegistry(names, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    registry: opts.registry,
    installed,
  });

  if (!probe.ok) {
    if (cache)
      return {
        ok: true,
        source: "cache",
        stale: true,
        ageH,
        deps: cache.deps ?? {},
        skipped: cache.skipped ?? [],
        errors: probe.errors,
      };
    return {
      ok: false,
      reason: "registry unreachable and no cache",
      errors: probe.errors,
    };
  }

  const usage = usageFromAtlas(root, Object.keys(manifest));
  /** @type {Record<string,any>} */
  const deps = {};
  let hold = 0;
  let assess = 0;
  for (const [name, d] of Object.entries(manifest)) {
    if (d.local) {
      deps[name] = {
        ring: "assess",
        score: 0,
        installed: d.installed,
        latest: null,
        reasons: ["local/workspace range — not probed against a registry"],
        evidenceKinds: 0,
        hasAdvisory: false,
        source: d.source,
        usage: usage[name] ?? 0,
      };
      assess++;
      continue;
    }
    const cls = classifyDep(probe.results[name], nowDay);
    deps[name] = {
      ring: cls.ring,
      score: cls.score,
      installed: d.installed,
      latest: probe.results[name]?.latest ?? null,
      reasons: cls.reasons,
      evidenceKinds: cls.evidenceKinds,
      hasAdvisory: cls.hasAdvisory,
      source: d.source,
      usage: usage[name] ?? 0,
    };
    if (cls.ring === "hold") hold++;
    else if (cls.ring === "assess") assess++;
  }

  writeRadarCache(root, { t: nowMs, generatedDay: nowDay, deps, skipped });
  await recordCurrency(root, deps, nowDay);
  try {
    const { record } = await import("./metrics.js");
    record(root, {
      stage: "radar",
      outcome: "scan",
      deps: Object.keys(deps).length,
      hold,
      assess,
    });
  } catch {}

  return { ok: true, source: "network", deps, skipped, errors: probe.errors };
}

/**
 * I4 recording: mint one `fact` claim per dep ("currency:<name>") carrying the verified ring
 * and its evidence. shadowFact's supersede keeps the latest verification live and history in
 * tombstones. Best-effort — a ledger failure never breaks a scan. Network scans only.
 */
async function recordCurrency(root, deps, nowDay) {
  try {
    const { repoLedger } = await import("./ledger_store.js");
    const { shadowFact } = await import("./ledger_bridge.js");
    const dir = repoLedger(root);
    for (const [name, d] of Object.entries(deps)) {
      const top = (d.reasons || []).slice(0, 2).join("; ") || "no risk signals";
      const text = `${name}@${d.installed ?? "?"} — ring ${d.ring} (latest ${d.latest ?? "?"}; ${top}) verified day ${nowDay}`;
      shadowFact(dir, `currency:${name}`, text, nowDay);
    }
  } catch {}
}

/**
 * Pre-edit currency advisory — CACHE-ONLY (a hook never fetches). Emits one line when the
 * file about to be edited imports a dep the last scan put in "hold" (or "assess" with an
 * advisory). Kill switch FORGE_RADAR=0. Fail-open: any problem → "".
 * @param {string} root
 * @param {(string|undefined)} file
 * @returns {string}
 */
export function radarAdvisory(root, file) {
  try {
    if (process.env.FORGE_RADAR === "0") return "";
    if (!file || file.endsWith(".md")) return "";
    const cache = readRadarCache(root);
    if (!cache?.deps) return "";
    const risky = riskyDeps(cache.deps);
    if (!risky.size) return "";
    let text;
    try {
      if (statSync(file).size > 256 * 1024) return "";
      text = readFileSync(file, "utf8");
    } catch {
      return "";
    }
    const imported = importedPackages(text);
    const hits = [...imported].filter((p) => risky.has(p));
    if (!hits.length) return "";
    const dep = hits[0];
    const d = cache.deps[dep];
    const why = d?.ring === "hold" ? "ring hold" : "ring assess, open advisory";
    const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    return `${BRAND.brand} radar — ${rel} imports ${dep} (${why}: ${(d?.reasons || [])[0] ?? "unverified currency"}). Check \`${BRAND.cli} radar\` before building on it.`;
  } catch {
    return "";
  }
}

const IMPORT_SPEC_RE =
  /(?:import\s+(?:[^"'\n]+\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\))/g;

/** Bare package names imported by a source file (drops relative + node: builtins). */
function importedPackages(text) {
  const out = new Set();
  IMPORT_SPEC_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_SPEC_RE.exec(text))) {
    const spec = m[1] || m[2] || "";
    if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
    const parts = spec.split("/");
    const bare = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (bare) out.add(bare);
  }
  return out;
}
