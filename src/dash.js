// forge dash — the local dashboard (docs/plans/substrate-v2/08-dashboard-ux.md, P7):
// a read-only lens on the .forge/ stores. DATA (dashData → one JSON payload) is
// separated from SERVING (serve → a node:http stdlib server) so the payload is
// testable without sockets. One self-contained HTML page (src/dash.html — inline
// CSS/JS, no CDN, no framework, no build step), localhost-only by default, zero
// runtime deps. Read-mostly by design: the two writes the spec names (ratify /
// retract POSTs) are a follow-up — this phase never writes anything.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { impact, load as loadAtlas } from "./atlas.js";
import { authorTrust, claimText, val, validOutcome } from "./ledger.js";
import { loadClaims, repoLedger, stats } from "./ledger_store.js";
import { read as readMetrics, summarize } from "./metrics.js";
import { epochDay } from "./util.js";

/** A claim is contested when its val sits in this band AND it carries ≥1 oracle
 *  contradiction — genuinely disputed, not merely fresh (a fresh claim is 0.5 with
 *  no evidence at all). Spec: 08-dashboard-ux.md §1, Ledger panel. */
export const CONTESTED_BAND = [0.4, 0.6];

/** Payload caps — the dashboard is a lens, not an export format. */
const CLAIM_CAP = 200;
const RECENT_CAP = 20;

const emptyLedger = () => ({
  stats: { total: 0, tombstoned: 0, byKind: {}, val: { dormant: 0, uncertain: 0, trusted: 0 } },
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
  return { stats: stats(dir, nowDay), claims, contested, trust: authorTrust(all) };
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
    if (a) atlas = { built: true, symbols: a.symbols?.length ?? 0, files: a.files ?? 0 };
  } catch {}
  return { repo: basename(root), nowDay, ledger, metrics, atlas };
}

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "dash.html");

const sendJson = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};

/**
 * The dashboard server: GET / → the page, GET /api/data → dashData, GET
 * /api/impact?target=X → blast radius (when an atlas exists). Everything else 404.
 * Localhost-only by default — pass a host explicitly to expose it, on your own head.
 * @param {string} root
 * @param {{port?: number, host?: string}} [opts]
 * @returns {import("node:http").Server}
 */
export function serve(root, { port = 4242, host = "127.0.0.1" } = {}) {
  const html = readFileSync(HTML_PATH, "utf8"); // read once at startup, self-contained
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET")
      return sendJson(res, 404, { error: "read-only in this phase — GET only" });
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(html);
    }
    if (url.pathname === "/api/data") return sendJson(res, 200, dashData(root));
    if (url.pathname === "/api/impact") {
      const target = url.searchParams.get("target");
      if (!target) return sendJson(res, 400, { error: "usage: /api/impact?target=<symbol|file>" });
      let atlas = null;
      try {
        atlas = loadAtlas(root);
      } catch {}
      if (!atlas) return sendJson(res, 404, { error: "no atlas — run `forge atlas build` first" });
      return sendJson(res, 200, impact(atlas, target));
    }
    return sendJson(res, 404, { error: "not found" });
  });
  server.listen(port, host);
  return server;
}
