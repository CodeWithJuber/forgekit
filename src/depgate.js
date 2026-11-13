// forge dep-gate — vet a package BEFORE it is installed (the skill-gate's twin for
// dependencies). An agent that invents a package name is the slopsquatting attack surface:
// the name sounds right, somebody registers it, and the install runs their code. `forge radar`
// judges the deps a repo ALREADY has; this asks the earlier question — "does the thing you are
// about to install exist, and is it what you think it is?" — at the moment it enters: an
// install command, an edit that adds it to a manifest, or an install that reads one.
//
// This file is the JUDGMENT half; src/depgate_sources.js is the half that reads commands and
// manifests. Both are tables first: ECOSYSTEMS below names, per ecosystem, the registry that
// answers "does it exist", what OSV and deps.dev call it, and whether that registry is the
// only place an installer looks.
//
// MIZAN (evidence-proportional judgment): every verdict ships the evidence that earned it and
// MISSING evidence never blocks. Only two findings deny an install, both first-hand:
//   1. the name is NOT on a registry that is authoritative for its ecosystem (an invented
//      name), or
//   2. OSV lists it as MALICIOUS (a `MAL-` advisory, the OpenSSF malicious-packages feed).
// Where the public registry is NOT the only source (Go falls back to the repository itself,
// Maven and NuGet builds routinely add other repositories) a miss is not proof, so it asks
// the human instead of denying. Everything else is a FORMULA over evidence, never a package
// list: youth (a half-life since the first publish), a thin history (few versions) and known
// advisories on the version the action pins combine by the house noisy-OR. A high score asks
// the human; a middling one leaves a note. A registry we cannot reach, a custom registry, a
// git/path/URL source, a name built from a shell variable: all pass untouched. This is
// hardening in front of the permission system, not a boundary, and an install must keep
// working offline.
//
// WHAT LEAVES THE MACHINE: a package name (and a pinned version) goes to that package's own
// public registry. Only when the registry has it is the name also sent to deps.dev and OSV, so
// a typo, an invention or a private name is told to nobody else; with a custom registry in
// play nothing is sent at all.
//
// Fail-safe by construction: nothing here throws to a caller and network I/O is injectable
// (fetchImpl), so tests never touch the network. Kill switch: FORGE_DEPGATE=0.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAND } from "./brand.js";
import {
  customRegistries,
  editAdditions,
  exact,
  parseInstalls,
  SPEC_PARSERS,
} from "./depgate_sources.js";
import { ADVISORY_SEVERITY } from "./radar.js";
import { clamp01, MS_PER_DAY, userStateDir } from "./util.js";

export {
  COMMANDS,
  customRegistries,
  editAdditions,
  FLAGS,
  MANIFESTS,
  manifestDeps,
  parseInstalls,
  SPEC_PARSERS,
} from "./depgate_sources.js";

/** @typedef {import("./depgate_sources.js").Eco} Eco */
/** @typedef {import("./depgate_sources.js").PkgSpec} PkgSpec */
/** @typedef {import("./depgate_sources.js").ReadText} ReadText */
/**
 * What we could verify about one package. `null` everywhere means "not checked / unknown",
 * never "clean": `exists:null` is an unreachable registry, `advisories:null` is "the action
 * pinned no version to ask OSV about", `indexed:false` is "its registry has it, deps.dev does
 * not yet". `canonical` is the spelling the registry answered to (a Go module root, a crate's
 * `-`/`_` form).
 * @typedef {{exists: boolean|null, canonical: string|null, indexed: boolean|null,
 *   firstPublishedAt: number|null, versions: number|null, latest: string|null,
 *   malicious: {id: string, summary: string}[]|null,
 *   advisories: {id: string, severity: string|null, summary: string}[]|null}} PkgEvidence
 */
/** @typedef {"deny"|"ask"|"note"|"ok"|"unknown"} Level */
/** @typedef {{level: Level, score: number, signals: Record<string, number>, reasons: string[]}} Judgment */
/** @typedef {{pkg: PkgSpec, evidence: PkgEvidence, judgment: Judgment, cached?: boolean}} Vetted */
/** @typedef {{has: (key: string) => boolean, add: (keys: string[]) => void}} VetCache */

/**
 * The ecosystems the gate can vet — pure data. `osv` / `depsdev` are what those services call
 * the ecosystem (`depsdev: null` = it does not index it, so history stays unknown).
 * `authoritative`: is this registry the ONLY place the installer looks by default? Then a
 * miss is a hallucinated name (deny); otherwise a miss may be a private source (ask).
 * @type {Readonly<Record<Eco, {label: string, osv: string, depsdev: string|null, authoritative: boolean}>>}
 */
export const ECOSYSTEMS = Object.freeze({
  npm: { label: "the npm registry", osv: "npm", depsdev: "npm", authoritative: true },
  pypi: { label: "PyPI", osv: "PyPI", depsdev: "pypi", authoritative: true },
  cargo: { label: "crates.io", osv: "crates.io", depsdev: "cargo", authoritative: true },
  rubygems: { label: "rubygems.org", osv: "RubyGems", depsdev: "rubygems", authoritative: true },
  packagist: { label: "Packagist", osv: "Packagist", depsdev: null, authoritative: true },
  pub: { label: "pub.dev", osv: "Pub", depsdev: null, authoritative: true },
  go: { label: "the Go module proxy", osv: "Go", depsdev: "go", authoritative: false },
  maven: { label: "Maven Central", osv: "Maven", depsdev: "maven", authoritative: false },
  nuget: { label: "nuget.org", osv: "NuGet", depsdev: "nuget", authoritative: false },
});

/** Weights (mizan): the data table. Every non-ok verdict names which of these earned it. */
export const DEPGATE_WEIGHTS = Object.freeze({ youth: 0.9, thin: 0.2, advisory: 0.6 });
/** A package's youth signal halves every this-many days since its FIRST publish. */
export const YOUTH_HALF_LIFE_DAYS = 30;
/** score ≥ ask pauses for the human; score ≥ note leaves an advisory; below is silent. */
export const DEPGATE_THRESHOLDS = Object.freeze({ ask: 0.5, note: 0.25 });
/** Packages PROBED per action (cached ones are free) — the rest are reported, not guessed. */
export const MAX_PACKAGES = 8;
export const DEFAULT_TIMEOUT_MS = 2500;
/** A package judged `ok` is not asked about again for this long. */
export const CACHE_DAYS = 7;
const CACHE_MAX_ENTRIES = 5000;

// ── Where a package's existence is asked ───────────────────────────────────────────────────

/** crates.io sparse-index path for a crate name (the layout cargo itself reads).
 *  @param {string} name */
function cargoIndexPath(name) {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/** The module roots a Go import path could belong to, longest first: `host/a/b/c/d` may be a
 *  module at any prefix, so a few are tried. @param {string} path @returns {string[]} */
function goModuleCandidates(path) {
  const seg = path.split("/");
  const shortest = /^(?:github\.com|bitbucket\.org|codeberg\.org)$/.test(seg[0]) ? 3 : 2;
  /** @type {string[]} */
  const all = [];
  for (let n = seg.length; n >= Math.min(shortest, seg.length); n--)
    all.push(seg.slice(0, n).join("/"));
  return all.length > 4 ? [...all.slice(0, 3), all[all.length - 1]] : all;
}

/**
 * Where a package's existence is asked — its OWN registry, never an aggregator (an index lags
 * a fresh publish; the registry does not). Several candidates mean "any of these spellings":
 * cargo treats `-` and `_` as one name, a Go import path may sit under several module roots.
 * @type {Record<Eco, (name: string) => {name: string, url: string}[]>}
 */
export const EXISTS_URLS = {
  npm: (n) => [{ name: n, url: `https://registry.npmjs.org/${encodeURIComponent(n)}` }],
  pypi: (n) => [{ name: n, url: `https://pypi.org/pypi/${encodeURIComponent(n)}/json` }],
  cargo: (n) =>
    [...new Set([n, n.replaceAll("-", "_"), n.replaceAll("_", "-")])].map((v) => ({
      name: v,
      url: `https://index.crates.io/${cargoIndexPath(v)}`,
    })),
  go: (n) =>
    goModuleCandidates(n).map((m) => ({
      name: m,
      // The proxy's case encoding: an upper-case letter is `!` + its lower-case form.
      url: `https://proxy.golang.org/${m.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)}/@v/list`,
    })),
  maven: (n) => {
    const [group, artifact] = n.split(":");
    const dir = `${group.replaceAll(".", "/")}/${artifact}`;
    return [{ name: n, url: `https://repo1.maven.org/maven2/${dir}/maven-metadata.xml` }];
  },
  nuget: (n) => [
    {
      name: n,
      url: `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(n.toLowerCase())}/index.json`,
    },
  ],
  rubygems: (n) => [
    { name: n, url: `https://rubygems.org/api/v1/gems/${encodeURIComponent(n)}.json` },
  ],
  packagist: (n) => [{ name: n, url: `https://repo.packagist.org/p2/${n}.json` }],
  pub: (n) => [{ name: n, url: `https://pub.dev/api/packages/${encodeURIComponent(n)}` }],
};

// ── Evidence: three first-hand sources, each independently allowed to fail ─────────────────

/** @param {unknown} label @returns {string|null} */
const severityLabel = (label) => {
  const s = String(label ?? "").toLowerCase();
  return s === "medium" ? "moderate" : s in ADVISORY_SEVERITY ? s : null;
};

/** @returns {PkgEvidence} */
const noEvidence = () => ({
  exists: null,
  canonical: null,
  indexed: null,
  firstPublishedAt: null,
  versions: null,
  latest: null,
  malicious: null,
  advisories: null,
});

/**
 * Gather the evidence for one package. Never throws; every source that fails leaves its
 * fields `null` (unknown) instead of a clean bill of health.
 * @param {PkgSpec} pkg
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<PkgEvidence>}
 */
export async function probePackage(pkg, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const ev = noEvidence();
  const eco = ECOSYSTEMS[pkg.eco];
  if (!fetchImpl || !eco) return ev;
  const agent = { "user-agent": `${BRAND.pkg}/${BRAND.version} (dep-gate)` };
  /** @param {string} url @param {RequestInit} [init] */
  const call = async (url, init = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        headers: { ...agent, ...(init.headers ?? {}) },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. Existence — the package's own registry. 200 on any spelling: it exists. 404/410 on
  //    every spelling: it does not. Anything else (403, 429, 5xx, a timeout): unknown.
  const existence = async () => {
    let misses = 0;
    const candidates = EXISTS_URLS[pkg.eco](pkg.name);
    for (const c of candidates) {
      try {
        let res = await call(c.url, { method: "HEAD" });
        // A registry that will not answer HEAD is asked with GET; the body is never read.
        if (res?.status === 405 || res?.status === 501) res = await call(c.url);
        if (res?.status === 200) {
          ev.canonical = c.name;
          return true;
        }
        if (res?.status === 404 || res?.status === 410) misses++;
      } catch {
        /* unknown */
      }
    }
    return misses === candidates.length ? false : null;
  };

  // 2. History — deps.dev: when it was first published, how many versions, which is default.
  const history = async () => {
    if (!eco.depsdev) return;
    try {
      const url = `https://api.deps.dev/v3/systems/${eco.depsdev}/packages/${encodeURIComponent(ev.canonical ?? pkg.name)}`;
      const res = await call(url);
      if (res?.status === 404) {
        ev.indexed = false;
        return;
      }
      if (!res?.ok) return;
      const doc = await res.json();
      const versions = Array.isArray(doc?.versions) ? doc.versions : [];
      ev.indexed = true;
      ev.versions = versions.length;
      let first = Number.POSITIVE_INFINITY;
      let newest = Number.NEGATIVE_INFINITY;
      for (const v of versions) {
        const ms = Date.parse(v?.publishedAt ?? "");
        const ver = v?.versionKey?.version;
        if (!Number.isFinite(ms)) continue;
        first = Math.min(first, ms);
        if (ms > newest && typeof ver === "string") {
          newest = ms;
          ev.latest = ver;
        }
      }
      // deps.dev marks at most one default version; when it does, that is "latest".
      const def = versions.find((/** @type {any} */ v) => v?.isDefault)?.versionKey?.version;
      if (typeof def === "string") ev.latest = def;
      ev.firstPublishedAt = Number.isFinite(first) ? first : null;
    } catch {
      /* unknown */
    }
  };

  // 3. Advisories — OSV, for the version the action PINS. With no pinned version only a
  //    MALICIOUS record is conclusive: an old fixed CVE on some past version says nothing
  //    about what this install will fetch.
  const advisories = async () => {
    try {
      const version = pkg.version?.replace(/^v/, "");
      const res = await call("https://api.osv.dev/v1/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          package: { name: ev.canonical ?? pkg.name, ecosystem: eco.osv },
          ...(version ? { version } : {}),
        }),
      });
      if (!res?.ok) return;
      const doc = await res.json();
      const vulns = Array.isArray(doc?.vulns) ? doc.vulns : [];
      ev.malicious = [];
      /** @type {NonNullable<PkgEvidence["advisories"]>} */
      const known = [];
      for (const v of vulns) {
        const id = String(v?.id ?? "");
        const summary = String(v?.summary ?? "").slice(0, 120);
        if (/^MAL-/i.test(id)) ev.malicious.push({ id, summary });
        else known.push({ id, severity: severityLabel(v?.database_specific?.severity), summary });
      }
      ev.advisories = version ? known : null;
    } catch {
      /* unknown */
    }
  };

  // Order is a privacy rule, not just latency: the registry is asked FIRST and alone. A name
  // it does not have (a typo, an invention, a private package) goes nowhere else — deps.dev
  // and OSV only ever hear about packages that are already public.
  ev.exists = await existence();
  if (ev.exists !== true) return ev;
  await Promise.all([history(), advisories()]);
  return ev;
}

// ── Judgment: hard gates first, then the formula ───────────────────────────────────────────

/** @param {number} ms */
const ageText = (ms) => {
  const days = Math.max(0, Math.round(ms / MS_PER_DAY));
  return days < 2 ? "about a day ago" : days < 60 ? `${days} days ago` : null;
};

/**
 * One package's verdict from its evidence. Pure.
 * @param {PkgSpec} pkg
 * @param {PkgEvidence} ev
 * @param {number} [nowMs]
 * @returns {Judgment}
 */
export function judge(pkg, ev, nowMs = Date.now()) {
  const eco = ECOSYSTEMS[pkg.eco];
  const where = eco?.label ?? pkg.eco;
  /** @type {Record<string, number>} */
  const signals = {};
  /** @type {string[]} */
  const reasons = [];
  // Hard gates — first-hand, conclusive, never outvoted by the score.
  if (ev.exists === false) {
    // Where the registry is the only source, a miss is an invented name. Where it is not
    // (a private repository, a second Maven repo), a miss is a question for the human.
    return eco?.authoritative
      ? {
          level: "deny",
          score: 1,
          signals,
          reasons: [`is not on ${where} — the name looks invented`],
        }
      : {
          level: "ask",
          score: 1,
          signals,
          reasons: [`is not on ${where} — invented, or served from a private source`],
        };
  }
  if (ev.malicious?.length)
    return {
      level: "deny",
      score: 1,
      signals,
      reasons: [`is listed as MALICIOUS by OSV (${ev.malicious[0].id})`],
    };

  if (ev.firstPublishedAt != null) {
    const age = Math.max(0, nowMs - ev.firstPublishedAt);
    signals.youth = clamp01(2 ** (-(age / MS_PER_DAY) / YOUTH_HALF_LIFE_DAYS));
    const when = ageText(age);
    if (when) reasons.push(`first published ${when}`);
  } else if (ev.exists === true && ev.indexed === false) {
    // Its registry has it and the public index has never seen it: as new as a package gets.
    signals.youth = 1;
    reasons.push("too new (or too obscure) to be indexed by deps.dev");
  }
  if (ev.versions != null && ev.versions > 0) {
    signals.thin = clamp01(1 / ev.versions);
    if (ev.versions <= 2 && signals.youth !== undefined && signals.youth >= 0.25)
      reasons.push(`only ${ev.versions} version${ev.versions === 1 ? "" : "s"} published`);
  }
  if (ev.advisories) {
    let worst = 0;
    let worstId = "";
    for (const a of ev.advisories) {
      // An advisory with no severity label is still an advisory: weigh it as moderate.
      const w =
        ADVISORY_SEVERITY[/** @type {keyof typeof ADVISORY_SEVERITY} */ (a.severity)] ??
        ADVISORY_SEVERITY.moderate;
      if (w > worst) {
        worst = w;
        worstId = a.id;
      }
    }
    signals.advisory = worst;
    if (ev.advisories.length) {
      const n = ev.advisories.length;
      reasons.push(
        `${n} known advisor${n === 1 ? "y" : "ies"} on ${pkg.version ?? "this version"} (worst: ${worstId})`,
      );
    }
  }

  const kinds = Object.keys(signals);
  if (ev.exists === null && !kinds.length) return { level: "unknown", score: 0, signals, reasons };
  // Noisy-OR, score = 1 − ∏(1 − wₖ·sₖ) — the radar/lessons shape: a clean signal contributes a
  // factor of 1 (no risk, no dilution) and one strong signal is enough.
  let clean = 1;
  for (const k of kinds)
    clean *=
      1 - (DEPGATE_WEIGHTS[/** @type {keyof typeof DEPGATE_WEIGHTS} */ (k)] ?? 0) * signals[k];
  const score = clamp01(1 - clean);
  /** @type {Level} */
  const level =
    score >= DEPGATE_THRESHOLDS.ask ? "ask" : score >= DEPGATE_THRESHOLDS.note ? "note" : "ok";
  return { level, score, signals, reasons };
}

// ── Memory: a package judged ok is not asked about again for a while ───────────────────────

/** @param {PkgSpec} p */
const cacheKey = (p) => `${p.eco}:${p.name}@${p.version ?? ""}`;

/**
 * The on-disk `ok` cache (`<state dir>/depgate.json`). It only ever remembers CLEAN verdicts —
 * a deny, an ask or an unknown is asked again every time — so a stale entry can hide nothing
 * worse than "this was fine last week". Best-effort: an unreadable or unwritable file is an
 * empty cache.
 * @param {{path?: string, nowMs?: number}} [opts]
 * @returns {VetCache}
 */
export function fileCache({
  path = join(userStateDir(), "depgate.json"),
  nowMs = Date.now(),
} = {}) {
  /** @type {Record<string, number>} */
  let ok = {};
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (doc && typeof doc.ok === "object" && doc.ok) ok = doc.ok;
  } catch {
    /* no cache yet */
  }
  const fresh = (/** @type {number} */ at) => nowMs - at < CACHE_DAYS * MS_PER_DAY;
  return {
    has: (key) => typeof ok[key] === "number" && fresh(ok[key]),
    add: (keys) => {
      if (!keys.length) return;
      for (const k of keys) ok[k] = nowMs;
      const kept = Object.entries(ok)
        .filter(([, at]) => fresh(at))
        .sort((a, b) => b[1] - a[1])
        .slice(0, CACHE_MAX_ENTRIES);
      ok = Object.fromEntries(kept);
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ v: 1, ok }));
        renameSync(tmp, path);
      } catch {
        /* best-effort */
      }
    },
  };
}

// ── The gate ───────────────────────────────────────────────────────────────────────────────

/** `@acme/*` matches a scope, `acme-*` a prefix, anything else the exact name.
 *  @param {string} name @param {unknown} patterns */
export function isAllowed(name, patterns) {
  if (!Array.isArray(patterns)) return false;
  const n = name.toLowerCase();
  return patterns.some((p) => {
    const s = String(p).toLowerCase();
    return s.endsWith("*") ? n.startsWith(s.slice(0, -1)) : n === s;
  });
}

/** @param {PkgSpec} p */
const display = (p) => `${p.name}${p.version ? `@${p.version}` : ""} (${p.eco})`;

/**
 * Vet a list of packages. Cached-ok packages cost nothing; at most MAX_PACKAGES others are
 * probed and the rest come back in `unvetted`. Never throws.
 * @param {PkgSpec[]} packages
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, nowMs?: number, cache?: VetCache|null}} [opts]
 * @returns {Promise<Vetted[] & {unvetted?: PkgSpec[]}>}
 */
export async function vetPackages(packages, opts = {}) {
  const cache = opts.cache ?? null;
  /** @type {Vetted[]} */
  const known = [];
  /** @type {PkgSpec[]} */
  const toProbe = [];
  for (const pkg of packages) {
    if (cache?.has(cacheKey(pkg)))
      known.push({
        pkg,
        evidence: { ...noEvidence(), exists: true },
        judgment: { level: "ok", score: 0, signals: {}, reasons: [] },
        cached: true,
      });
    else toProbe.push(pkg);
  }
  const probed = await Promise.all(
    toProbe.slice(0, MAX_PACKAGES).map(async (pkg) => {
      const evidence = await probePackage(pkg, opts);
      return { pkg, evidence, judgment: judge(pkg, evidence, opts.nowMs) };
    }),
  );
  try {
    cache?.add(probed.filter((r) => r.judgment.level === "ok").map((r) => cacheKey(r.pkg)));
  } catch {
    /* best-effort */
  }
  /** @type {Vetted[] & {unvetted?: PkgSpec[]}} */
  const results = [...probed, ...known];
  results.unvetted = toProbe.slice(MAX_PACKAGES);
  return results;
}

/** @type {Record<Level, number>} */
const RANK = { deny: 0, ask: 1, note: 2, ok: 3, unknown: 4 };

/**
 * @typedef {{cwd?: string, env?: NodeJS.ProcessEnv, home?: string, fetchImpl?: typeof fetch,
 *   timeoutMs?: number, nowMs?: number, allow?: unknown, cache?: VetCache|null,
 *   exists?: (p: string) => boolean, readText?: ReadText}} GateContext
 * @typedef {{decision: "allow"|"deny"|"ask"|"note", reason: string, results: Vetted[],
 *   skipped: string[]}} GateDecision
 */

/**
 * Shared tail of both decisions: drop what is allow-listed or behind a custom registry, vet
 * the rest, turn the worst verdict into a decision.
 * @param {PkgSpec[]} found
 * @param {GateContext} ctx
 * @returns {Promise<GateDecision>}
 */
async function decide(found, ctx) {
  const { cwd = process.cwd(), env = process.env } = ctx;
  /** @type {string[]} */
  const skipped = [];
  if (!found.length) return { decision: "allow", reason: "", results: [], skipped };
  const custom = customRegistries({ cwd, env, home: ctx.home, readText: ctx.readText });
  let allowList = ctx.allow;
  if (allowList === undefined) {
    try {
      const { readForgeConfig } = await import("./repo_config.js");
      allowList = readForgeConfig(cwd)?.depgate?.allow;
    } catch {
      allowList = [];
    }
  }
  const vettable = found.filter((p) => {
    if (isAllowed(p.name, allowList)) return false;
    // A non-default registry is in play: a 404 on the public one proves nothing.
    const scope = p.name.startsWith("@") ? p.name.slice(0, p.name.indexOf("/")) : "";
    const privately = custom[p.eco] || (p.eco === "npm" && custom.npmScopes.includes(scope));
    if (privately) skipped.push(`${display(p)}: a custom registry is configured`);
    return !privately;
  });
  if (!vettable.length) return { decision: "allow", reason: "", results: [], skipped };

  const cache = ctx.cache === undefined ? fileCache({ nowMs: ctx.nowMs }) : ctx.cache;
  const results = await vetPackages(vettable, {
    fetchImpl: ctx.fetchImpl,
    timeoutMs: ctx.timeoutMs,
    nowMs: ctx.nowMs,
    cache,
  });
  if (results.unvetted?.length)
    skipped.push(
      `${results.unvetted.length} more package(s) past the cap of ${MAX_PACKAGES} per action`,
    );
  results.sort((a, b) => RANK[a.judgment.level] - RANK[b.judgment.level]);
  const worst = results[0].judgment.level;
  /** @param {Level} level */
  const lines = (level) =>
    results
      .filter((r) => r.judgment.level === level)
      .map((r) => `${display(r.pkg)} ${r.judgment.reasons.join("; ")}`);
  /** @type {Vetted[]} */
  const plain = [...results];

  if (worst === "deny") {
    return {
      decision: "deny",
      reason:
        `dep-gate: ${lines("deny").join(" | ")}. A hallucinated dependency is how slopsquatting ` +
        "lands: find the real package (registry search, the library's own docs) before " +
        "installing. A private package? Add it to depgate.allow in " +
        ".forge/forge.config.json, or set FORGE_DEPGATE=0 for this shell.",
      results: plain,
      skipped,
    };
  }
  if (worst === "ask") {
    return {
      decision: "ask",
      reason:
        `dep-gate: ${lines("ask").join(" | ")}. A name the registry does not know, or a new, ` +
        "thin package, is the usual shape of a squatted name — confirm this is the package " +
        "you mean.",
      results: plain,
      skipped,
    };
  }
  if (worst === "note")
    return {
      decision: "note",
      reason: `dep-gate: ${lines("note").join(" | ")}.`,
      results: plain,
      skipped,
    };
  return { decision: "allow", reason: "", results: plain, skipped };
}

/**
 * The decision for one Bash command line — the PreToolUse guard's view of `Bash` and of
 * `forge vet --cmd`. `deny` blocks the call, `ask` pauses for the human, `note` lets it
 * through with an advisory, `allow` is silent.
 * @param {GateContext & {command?: string}} [call]
 * @returns {Promise<GateDecision>}
 */
export async function depgateDecision({ command = "", ...ctx } = {}) {
  if ((ctx.env ?? process.env).FORGE_DEPGATE === "0")
    return { decision: "allow", reason: "", results: [], skipped: [] };
  const parsed = parseInstalls(command, {
    cwd: ctx.cwd,
    exists: ctx.exists,
    readText: ctx.readText,
  });
  return decide(parsed.packages, ctx);
}

/**
 * The decision for an Edit / Write / MultiEdit: the packages the edit ADDS to a manifest
 * (`package.json`, `pyproject.toml`, `pom.xml` …) are vetted before they land.
 * @param {GateContext & {toolName?: string, toolInput?: any}} [call]
 * @returns {Promise<GateDecision>}
 */
export async function depgateEditDecision({ toolName, toolInput, ...ctx } = {}) {
  if ((ctx.env ?? process.env).FORGE_DEPGATE === "0")
    return { decision: "allow", reason: "", results: [], skipped: [] };
  const added = editAdditions({ toolName, toolInput, cwd: ctx.cwd, readText: ctx.readText });
  return decide(added, ctx);
}

/** `forge vet` argument prefixes → ecosystem. A bare name is npm. */
export const VET_PREFIXES = Object.freeze({
  npm: "npm",
  pypi: "pypi",
  pip: "pypi",
  cargo: "cargo",
  crates: "cargo",
  go: "go",
  golang: "go",
  maven: "maven",
  mvn: "maven",
  gradle: "maven",
  nuget: "nuget",
  dotnet: "nuget",
  rubygems: "rubygems",
  gem: "rubygems",
  packagist: "packagist",
  composer: "packagist",
  pub: "pub",
  dart: "pub",
  flutter: "pub",
});

/**
 * `npm:left-pad@1.3.0`, `pypi:requests==2.31.0`, `go:github.com/spf13/cobra`,
 * `maven:org.slf4j:slf4j-api` → a PkgSpec (the `forge vet` argument form).
 * @param {string} arg
 * @returns {PkgSpec|null}
 */
export function parseVetArg(arg) {
  const m = /^([a-z]+):(.+)$/i.exec(String(arg));
  const prefix = m ? m[1].toLowerCase() : "";
  const known = prefix in VET_PREFIXES;
  const eco = /** @type {Eco} */ (
    known ? VET_PREFIXES[/** @type {keyof typeof VET_PREFIXES} */ (prefix)] : "npm"
  );
  const raw = known && m ? m[2] : String(arg);
  let spec = SPEC_PARSERS[eco](raw);
  // `name@version` works for every ecosystem here, whatever its own pin spelling is
  // (`gem:rails@7.1.0`, `maven:group:artifact@1.2.3`); a leading `@` is an npm scope.
  const at = raw.lastIndexOf("@");
  if (at > 0 && !spec?.version) {
    const named = SPEC_PARSERS[eco](raw.slice(0, at));
    const version = exact(raw.slice(at + 1));
    if (named && version) spec = { name: named.name, version };
  }
  return spec ? { eco, name: spec.name, version: spec.version, via: `${BRAND.cli} vet` } : null;
}
