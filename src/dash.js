// forge dash — the local dashboard (docs/plans/substrate-v2/08-dashboard-ux.md, P7):
// a read-mostly lens on the .forge/ stores. DATA (dashData → one JSON payload) is
// separated from SERVING (serve → a node:http stdlib server) so the payload is
// testable without sockets. One self-contained HTML page (src/dash.html — inline
// CSS/JS, no CDN, no framework, no build step), localhost-only by default, zero
// runtime deps. Exactly the two writes the spec names (§2) exist — POST /api/ratify
// (human-only ḥikma promotion, mints a decision claim) and POST /api/retract
// (tombstone with a reason). Both are append-only, so the dashboard can never
// corrupt the ledger; everything else stays read-only.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { impact, load as loadAtlas } from "./atlas.js";
import { estimateSpendFromLogs } from "./cost_report.js";
import { authorTrust, claimText, retrieve, val, validOutcome } from "./ledger.js";
import {
  getClaimByPrefix,
  loadClaims,
  ratify,
  repoLedger,
  stats,
  tombstone,
} from "./ledger_store.js";
import { read as readMetrics, summarize } from "./metrics.js";
import { clamp01, epochDay, gitAuthor, MS_PER_DAY } from "./util.js";

/** A claim is contested when its val sits in this band AND it carries ≥1 oracle
 *  contradiction — genuinely disputed, not merely fresh (a fresh claim is 0.5 with
 *  no evidence at all). Spec: 08-dashboard-ux.md §1, Ledger panel. */
export const CONTESTED_BAND = [0.4, 0.6];

/** Payload caps — the dashboard is a lens, not an export format. */
const CLAIM_CAP = 200;
const RECENT_CAP = 20;

const emptyLedger = () => ({
  stats: {
    total: 0,
    tombstoned: 0,
    byKind: {},
    val: { dormant: 0, uncertain: 0, trusted: 0 },
  },
  claims: [],
  contested: [],
  trust: {},
});

/** The row shape every ledger table in the UI renders — id8 is the handle the
 *  provenance affordance (`forge ledger blame <id8>`) is built from. */
const claimRow = (c, nowDay) => ({
  id8: c.id.slice(0, 8),
  kind: c.kind,
  val: Number(val(c, nowDay).toFixed(3)),
  evidenceCount: (c.evidence ?? []).filter(validOutcome).length,
  author: c.provenance?.author ?? "",
  tombstoned: Boolean(c.tombstone),
  text: claimText(c).slice(0, 140),
});

function ledgerSection(root, nowDay) {
  const dir = repoLedger(root);
  const all = loadClaims(dir);
  const claims = all
    .map((c) => claimRow(c, nowDay))
    .sort((a, b) => b.val - a.val || (a.id8 < b.id8 ? -1 : 1))
    .slice(0, CLAIM_CAP);
  const contested = all
    .filter((c) => {
      if (c.tombstone) return false;
      const v = val(c, nowDay);
      if (v < CONTESTED_BAND[0] || v > CONTESTED_BAND[1]) return false;
      return (c.evidence ?? []).some((e) => validOutcome(e) && e.result === "contradict");
    })
    .map((c) => claimRow(c, nowDay));
  return {
    stats: stats(dir, nowDay),
    claims,
    contested,
    trust: authorTrust(all),
  };
}

function metricsSection(root) {
  const recent = readMetrics(root)
    .slice(-RECENT_CAP)
    .map((e) => ({
      t: e.t ?? 0,
      stage: e.stage ?? "",
      outcome: e.outcome ?? "",
      savedEstimate: Number.isFinite(e.savedEstimate) ? e.savedEstimate : 0,
    }));
  return { stages: summarize(root), recent };
}

/**
 * One JSON payload for the whole page — everything /api/data serves. Corrupt or
 * missing stores degrade to empty sections; this NEVER throws (a broken .forge/
 * must not take down the lens that would let you see it's broken).
 * @param {string} root
 * @param {{nowDay?: number}} [opts]
 */
export function dashData(root, { nowDay = epochDay() } = {}) {
  let ledger = emptyLedger();
  try {
    ledger = ledgerSection(root, nowDay);
  } catch {}
  let metrics = { stages: {}, recent: [] };
  try {
    metrics = metricsSection(root);
  } catch {}
  let atlas = { built: false, symbols: 0, files: 0 };
  try {
    const a = loadAtlas(root);
    if (a)
      atlas = {
        built: true,
        symbols: a.symbols?.length ?? 0,
        files: a.files ?? 0,
      };
  } catch {}
  let spend = null;
  try {
    spend = estimateSpendFromLogs();
  } catch {}
  // First-run signal for the empty-state copy: a truly untouched .forge/ has no
  // ledger claims AND no metrics events. `metrics.recent` is capped but only ever
  // empty when zero events exist, so it doubles as the metrics-count check — no
  // extra read, and (like everything above) it never throws.
  const meta = {
    empty: (ledger?.stats?.total ?? 0) === 0 && (metrics?.recent?.length ?? 0) === 0,
    forgeDir: join(root, ".forge"),
  };
  return { repo: basename(root), nowDay, meta, ledger, metrics, atlas, spend };
}

/**
 * Lightweight summary — counts and status only (no full claim list).
 * @param {string} root
 * @param {{nowDay?: number}} [opts]
 */
export function dashSummary(root, { nowDay = epochDay() } = {}) {
  let ledgerStats = emptyLedger().stats;
  let contested = 0;
  try {
    const dir = repoLedger(root);
    ledgerStats = stats(dir, nowDay);
    const all = loadClaims(dir);
    contested = all.filter((c) => {
      if (c.tombstone) return false;
      const v = val(c, nowDay);
      if (v < CONTESTED_BAND[0] || v > CONTESTED_BAND[1]) return false;
      return (c.evidence ?? []).some((e) => validOutcome(e) && e.result === "contradict");
    }).length;
  } catch {}
  let atlasBuilt = false;
  try {
    atlasBuilt = Boolean(loadAtlas(root));
  } catch {}
  let metricEvents = 0;
  try {
    metricEvents = readMetrics(root).length;
  } catch {}
  return {
    claims: ledgerStats.total,
    tombstoned: ledgerStats.tombstoned,
    contested,
    atlasBuilt,
    metricEvents,
  };
}

// --- dash v2: history / memory-browser / radar / timeline lenses -----------
// Each is a pure, self-contained payload builder that NEVER throws — a corrupt or
// missing store degrades to an empty section, same discipline as dashData.

/** Payload caps for the v2 lenses. */
const HISTORY_CAP_DAYS = 90;
const CLAIM_BROWSE_BUDGET = 50;
const TIMELINE_CAP = 60;
const FRESH_HALF_LIFE_DAYS = 45;

const metricDay = (e) => Math.floor((Number.isFinite(e?.t) ? e.t : 0) / MS_PER_DAY);

/**
 * Metrics history bucketed by day and by stage, capped to the last `capDays` days
 * (I4 trend lens). The window anchors on the latest observed day (or nowDay), so a
 * repo whose clock and nowDay disagree still yields its real trailing window.
 * @param {string} root
 * @param {{nowDay?: number, capDays?: number}} [opts]
 */
export function historyData(root, { nowDay = epochDay(), capDays = HISTORY_CAP_DAYS } = {}) {
  let events = [];
  try {
    events = readMetrics(root);
  } catch {}
  const anchor = events.reduce((m, e) => Math.max(m, metricDay(e)), nowDay);
  const floor = anchor - capDays;
  const buckets = new Map();
  const stages = new Map();
  let totalEvents = 0;
  let totalSaved = 0;
  for (const e of events) {
    const day = metricDay(e);
    if (day <= floor) continue;
    const saved = Number.isFinite(e.savedEstimate) ? e.savedEstimate : 0;
    const outcome = e.outcome || "";
    const b = buckets.get(day) ?? { day, events: 0, saved: 0, byOutcome: {} };
    b.events++;
    b.saved += saved;
    if (outcome) b.byOutcome[outcome] = (b.byOutcome[outcome] ?? 0) + 1;
    buckets.set(day, b);
    const stage = e.stage || "";
    const s = stages.get(stage) ?? {
      events: 0,
      saved: 0,
      byOutcome: {},
      series: new Map(),
    };
    s.events++;
    s.saved += saved;
    if (outcome) s.byOutcome[outcome] = (s.byOutcome[outcome] ?? 0) + 1;
    const sp = s.series.get(day) ?? { day, events: 0, saved: 0 };
    sp.events++;
    sp.saved += saved;
    s.series.set(day, sp);
    stages.set(stage, s);
    totalEvents++;
    totalSaved += saved;
  }
  const bucketList = [...buckets.values()].sort((a, b) => a.day - b.day);
  const stageObj = {};
  for (const [name, s] of [...stages.entries()].sort((a, b) => b[1].events - a[1].events))
    stageObj[name] = {
      events: s.events,
      saved: s.saved,
      byOutcome: s.byOutcome,
      series: [...s.series.values()].sort((a, b) => a.day - b.day),
    };
  return {
    window: capDays,
    from: bucketList.length ? bucketList[0].day : null,
    to: bucketList.length ? bucketList[bucketList.length - 1].day : null,
    buckets: bucketList,
    stages: stageObj,
    totals: { events: totalEvents, saved: totalSaved },
  };
}

/** Pure recency factor (0..1) from a claim's mint day — a freshness bar to sit next
 *  to the val (confidence) bar in the memory browser. val already folds decay; this
 *  exposes age on its own so a stale-but-trusted claim reads honestly. */
const freshness = (c, nowDay) => {
  const t = c.provenance?.t;
  if (!Number.isFinite(t)) return 0;
  return clamp01(2 ** (-Math.max(0, nowDay - t) / FRESH_HALF_LIFE_DAYS));
};

const claimBrowseRow = (c, nowDay, score) => ({
  ...claimRow(c, nowDay),
  fresh: Number(freshness(c, nowDay).toFixed(3)),
  score: score == null ? null : Number(score.toFixed(4)),
});

/**
 * Memory browser: ranked claims for the given query (Eq.3 rel×rec×val via `retrieve`)
 * or, with no query, the whole live ledger sorted by val. Optional kind filter.
 * @param {string} root
 * @param {{q?: string, kind?: string, nowDay?: number, budget?: number}} [opts]
 */
export function claimsData(
  root,
  { q = "", kind = "", nowDay = epochDay(), budget = CLAIM_BROWSE_BUDGET } = {},
) {
  let all = [];
  try {
    all = loadClaims(repoLedger(root));
  } catch {}
  const query = String(q ?? "").trim();
  let ranked;
  if (query) {
    ranked = retrieve(query, all, { nowDay, budget: budget * 2 });
  } else {
    ranked = all
      .filter((c) => !c.tombstone)
      .map((claim) => ({ claim, score: null }))
      .sort(
        (a, b) => val(b.claim, nowDay) - val(a.claim, nowDay) || (a.claim.id < b.claim.id ? -1 : 1),
      );
  }
  let rows = ranked.map(({ claim, score }) => claimBrowseRow(claim, nowDay, score));
  const wantKind = String(kind ?? "").trim();
  if (wantKind) rows = rows.filter((r) => r.kind === wantKind);
  rows = rows.slice(0, budget);
  return {
    q: query,
    kind: wantKind,
    total: all.length,
    count: rows.length,
    rows,
  };
}

const RADAR_RINGS = ["adopt", "trial", "assess", "hold"];
const RADAR_ORDER = { hold: 0, assess: 1, trial: 2, adopt: 3 };

/**
 * Radar rings read straight from the `.forge/radar.json` cache (hooks/dash never
 * fetch — radar.js owns the network). Tolerant of shape drift; a missing or
 * unparseable cache degrades to an empty, present:false panel (a clean 200).
 * @param {string} root
 */
export function radarData(root) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(root, ".forge", "radar.json"), "utf8"));
  } catch {
    return { present: false, t: null, deps: [], counts: {} };
  }
  const depsRaw = raw?.deps ?? {};
  const entries = Array.isArray(depsRaw)
    ? depsRaw.map((d) => [d?.name, d])
    : Object.entries(depsRaw);
  const counts = {};
  const deps = [];
  for (const [name, d] of entries) {
    if (!name || typeof d !== "object" || d == null) continue;
    const ring = RADAR_RINGS.includes(d.ring) ? d.ring : "assess";
    const score = Number.isFinite(d.score) ? Number(d.score.toFixed(3)) : null;
    counts[ring] = (counts[ring] ?? 0) + 1;
    // radar.js writes `installed` (the pinned version) + `reasons` (evidence strings);
    // tolerate the older `version`/`evidence` shape too so a stale cache still renders.
    const version =
      typeof d.installed === "string"
        ? d.installed
        : typeof d.version === "string"
          ? d.version
          : "";
    const reasons = Array.isArray(d.reasons)
      ? d.reasons
      : d.evidence && typeof d.evidence === "object"
        ? d.evidence
        : [];
    deps.push({
      name: String(name),
      ring,
      score,
      version,
      latest: typeof d.latest === "string" ? d.latest : "",
      reasons,
    });
  }
  deps.sort(
    (a, b) =>
      RADAR_ORDER[a.ring] - RADAR_ORDER[b.ring] ||
      (b.score ?? 0) - (a.score ?? 0) ||
      (a.name < b.name ? -1 : 1),
  );
  return {
    present: true,
    t: Number.isFinite(raw?.t) ? raw.t : null,
    deps,
    counts,
  };
}

/**
 * Session timeline drawn from the DURABLE ledger (mint + tombstone events), newest
 * first — not the ephemeral session logs that clear between sessions.
 * @param {string} root
 * @param {{cap?: number}} [opts]
 */
export function timelineData(root, { cap = TIMELINE_CAP } = {}) {
  let all = [];
  try {
    all = loadClaims(repoLedger(root));
  } catch {}
  const events = [];
  for (const c of all) {
    const id8 = c.id.slice(0, 8);
    const mintT = c.provenance?.t;
    if (Number.isFinite(mintT))
      events.push({
        day: mintT,
        type: "mint",
        kind: c.kind,
        id8,
        author: c.provenance?.author ?? "",
        text: claimText(c).slice(0, 120),
      });
    if (c.tombstone && Number.isFinite(c.tombstone.t))
      events.push({
        day: c.tombstone.t,
        type: "retract",
        kind: c.kind,
        id8,
        author: c.tombstone.author ?? "",
        text: c.tombstone.reason
          ? String(c.tombstone.reason).slice(0, 120)
          : claimText(c).slice(0, 120),
      });
  }
  events.sort((a, b) => b.day - a.day || (a.id8 < b.id8 ? -1 : 1));
  return { count: Math.min(events.length, cap), events: events.slice(0, cap) };
}

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "dash.html");

const sendJson = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};

/** Small JSON body reader for the two POSTs — capped so a runaway client can't buffer
 *  unbounded bytes into a localhost convenience server. */
const BODY_CAP = 64 * 1024;
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > BODY_CAP) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

/** The two writes (08-dashboard-ux.md §2), both append-only: ratify mints a decision
 *  claim with the HUMAN as author (gitAuthor — nothing auto-ratifies), retract appends
 *  a tombstone record with a reason. Body: {id: <prefix ≥2 chars>, reason?}. */
async function handleWrite(root, pathname, req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad JSON body" });
  }
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (id.length < 2)
    return sendJson(res, 400, {
      error: 'body must be {"id": "<claim id-prefix (≥2 chars)>"}',
    });
  const dir = repoLedger(root);
  const author = gitAuthor();
  const t = epochDay();
  if (pathname === "/api/ratify") {
    const r = ratify(dir, id, { author, t });
    return sendJson(res, r.ok ? 200 : 404, r);
  }
  const hit = getClaimByPrefix(dir, id);
  if (!hit) return sendJson(res, 404, { ok: false, reason: `no claim matching ${id}` });
  const reason = typeof body.reason === "string" ? body.reason : "";
  const r = tombstone(dir, hit.id, { author, reason, t });
  return sendJson(res, r.ok ? 200 : 400, { ...r, id: hit.id });
}

const WRITE_ROUTES = new Set(["/api/ratify", "/api/retract"]);

/**
 * The dashboard server: GET / → the page, GET /api/data → dashData, GET
 * /api/history → metrics trends, GET /api/claims?q=&kind= → memory browser, GET
 * /api/radar → dependency rings (cache-only), GET /api/timeline → durable event
 * stream, GET /api/impact?target=X → blast radius (when an atlas exists), POST
 * /api/ratify and POST /api/retract → the spec's two append-only writes. Else 404.
 * Localhost-only by default — pass a host explicitly to expose it, on your own head.
 * @param {string} root
 * @param {{port?: number, host?: string}} [opts]
 * @returns {import("node:http").Server}
 */
export function serve(root, { port = 4242, host = "127.0.0.1" } = {}) {
  const html = readFileSync(HTML_PATH, "utf8"); // read once at startup, self-contained
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && WRITE_ROUTES.has(url.pathname)) {
      handleWrite(root, url.pathname, req, res).catch(() =>
        sendJson(res, 400, { error: "bad request body" }),
      );
      return;
    }
    if (req.method !== "GET")
      return sendJson(res, 404, {
        error: "GET only — the two writes are POST /api/ratify and POST /api/retract",
      });
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(html);
    }
    if (url.pathname === "/api/data") return sendJson(res, 200, dashData(root));
    if (url.pathname === "/api/history") return sendJson(res, 200, historyData(root));
    if (url.pathname === "/api/radar") return sendJson(res, 200, radarData(root));
    if (url.pathname === "/api/timeline") return sendJson(res, 200, timelineData(root));
    if (url.pathname === "/api/claims")
      return sendJson(
        res,
        200,
        claimsData(root, {
          q: url.searchParams.get("q") ?? "",
          kind: url.searchParams.get("kind") ?? "",
        }),
      );
    if (url.pathname === "/api/spend") {
      const spend = estimateSpendFromLogs();
      return sendJson(res, 200, spend || { totalCost: 0, sessions: 0, byModel: [] });
    }
    if (url.pathname === "/api/impact") {
      const target = url.searchParams.get("target");
      if (!target)
        return sendJson(res, 400, {
          error: "usage: /api/impact?target=<symbol|file>",
        });
      let atlas = null;
      try {
        atlas = loadAtlas(root);
      } catch {}
      if (!atlas)
        return sendJson(res, 404, {
          error: "no atlas — run `forge atlas build` first",
        });
      return sendJson(res, 200, impact(atlas, target));
    }
    return sendJson(res, 404, { error: "not found" });
  });
  server.listen(port, host);
  return server;
}
