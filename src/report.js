// forge report — a static, self-contained HTML snapshot of the .forge/ substrate.
// Where `dash.js` serves a live localhost lens, `report` emits ONE file you can open
// offline, mail, or attach to a PR: no server, no fetch, no CDN, no JS required to read
// it. DATA reuse is deliberate — the payload is `dashData(root)` (dash.js), history is
// `read()` from metrics.js bucketed by day, and the tech-radar section reads the
// `.forge/radar.json` cache DIRECTLY and defensively (absent/corrupt → the section is
// simply omitted; report.js never imports radar.js, so it stands alone if radar was
// never built). Visuals are server-side inline SVG sparklines. The token block comes
// from `rootTokensCss()` (brand.js) so the report's palette is the brand's single
// source, never a forked copy. `renderReport` is PURE (returns the HTML string, writes
// nothing); `writeReport` is the only side-effecting entry point.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, rootTokensCss } from "./brand.js";
import { dashData } from "./dash.js";
import { read as readMetrics } from "./metrics.js";
import { epochDay, MS_PER_DAY } from "./util.js";

/** How far back the history strip looks (matches the dash /api/history 90-day cap). */
const HISTORY_DAYS = 90;

/** Minimal HTML-attribute/text escaper — the report interpolates ledger claim text and
 *  radar notes that originate outside our control, so every dynamic string is escaped. */
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Absolute path of the emitted report for a repo root. */
export const reportPath = (root) => join(root, ".forge", "report.html");

/**
 * Read the radar cache without importing radar.js (built in parallel, may not exist).
 * Accepts either a bare array of entries or `{ generatedAt, entries: [...] }`; coerces
 * loose fields to strings. Absent, empty, or unparseable → null (section omitted).
 * @param {string} root
 */
export function readRadar(root) {
  try {
    const p = join(root, ".forge", "radar.json");
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf8"));
    const raw = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
    const entries = raw
      .map((e) => ({
        name: String(e?.name ?? e?.dep ?? ""),
        ring: String(e?.ring ?? e?.status ?? ""),
        note: String(e?.note ?? e?.reason ?? ""),
      }))
      .filter((e) => e.name);
    if (!entries.length) return null;
    return {
      generatedAt: typeof data?.generatedAt === "string" ? data.generatedAt : "",
      entries,
    };
  } catch {
    return null;
  }
}

/**
 * Bucket metrics.jsonl into a fixed [nowDay-days+1 … nowDay] window: per-day event
 * counts (for the sparkline) and a per-stage rollup (events + summed savedEstimate).
 * @param {string} root
 * @param {{nowDay?: number, days?: number}} [opts]
 */
export function historyByDay(root, { nowDay = epochDay(), days = HISTORY_DAYS } = {}) {
  const start = nowDay - days + 1;
  const counts = new Array(days).fill(0);
  const byStage = {};
  let total = 0;
  for (const e of readMetrics(root)) {
    const t = Number(e.t);
    if (!Number.isFinite(t)) continue;
    const day = Math.floor(t / MS_PER_DAY);
    if (day < start || day > nowDay) continue;
    counts[day - start] += 1;
    total += 1;
    const s = (byStage[e.stage || "?"] ??= { events: 0, saved: 0 });
    s.events += 1;
    if (Number.isFinite(e.savedEstimate)) s.saved += e.savedEstimate;
  }
  return { start, days, counts, byStage, total };
}

/**
 * Server-side inline SVG sparkline — no xmlns (the HTML parser handles inline SVG), so
 * the markup carries zero external references. Flat/empty series → a baseline line.
 * @param {number[]} values
 * @param {{width?: number, height?: number, pad?: number}} [opts]
 */
export function sparkline(values, { width = 280, height = 34, pad = 3 } = {}) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const stepX = n > 1 ? (width - pad * 2) / (n - 1) : 0;
  const y = (v) => height - pad - (v / max) * (height - pad * 2);
  const pts =
    n === 0
      ? `${pad},${(height - pad).toFixed(1)} ${width - pad},${(height - pad).toFixed(1)}`
      : values.map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `role="img" aria-label="activity over the last ${n} days">` +
    `<polyline fill="none" stroke="var(--brand)" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round" points="${pts}" /></svg>`
  );
}

const num = (x) => (Number.isFinite(x) ? x : 0);

/** A confidence/value cell rendered as a proportional inline bar (0..1). */
function valBar(v) {
  const pct = Math.round(Math.max(0, Math.min(1, num(v))) * 100);
  return (
    `<span class="bar" title="${pct}%"><span class="bar-fill" style="width:${pct}%"></span></span>` +
    `<span class="mono muted">${num(v).toFixed(2)}</span>`
  );
}

function ledgerRows(claims) {
  if (!claims.length) return `<tr><td colspan="4" class="muted">no claims yet</td></tr>`;
  return claims
    .slice(0, 40)
    .map(
      (c) =>
        `<tr${c.tombstoned ? ' class="tomb"' : ""}>` +
        `<td class="mono faint">${escapeHtml(c.id8)}</td>` +
        `<td class="mono">${escapeHtml(c.kind)}</td>` +
        `<td>${valBar(c.val)}</td>` +
        `<td>${escapeHtml(c.text)}</td></tr>`,
    )
    .join("");
}

function stageRows(byStage) {
  const names = Object.keys(byStage).sort();
  if (!names.length) return `<tr><td colspan="3" class="muted">no measured stages</td></tr>`;
  return names
    .map(
      (s) =>
        `<tr><td class="mono">${escapeHtml(s)}</td>` +
        `<td class="mono">${byStage[s].events}</td>` +
        `<td class="mono">${Math.round(byStage[s].saved)}</td></tr>`,
    )
    .join("");
}

function radarSection(radar) {
  if (!radar) return "";
  const rows = radar.entries
    .slice(0, 60)
    .map(
      (e) =>
        `<tr><td class="mono">${escapeHtml(e.name)}</td>` +
        `<td class="mono">${escapeHtml(e.ring)}</td>` +
        `<td>${escapeHtml(e.note)}</td></tr>`,
    )
    .join("");
  const stamp = radar.generatedAt ? ` · cached ${escapeHtml(radar.generatedAt)}` : "";
  return (
    `<section class="panel"><h2>Tech radar${stamp}</h2>` +
    `<table><thead><tr><th>dependency</th><th>ring</th><th>note</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></section>`
  );
}

/**
 * Render the whole report as one self-contained HTML string. PURE — no filesystem
 * writes, no network, no throw on corrupt stores (dashData already degrades to empty
 * sections). The output references nothing external: styles come from `rootTokensCss()`
 * and every chart is inline SVG.
 * @param {string} root
 * @param {{nowDay?: number}} [opts]
 */
export function renderReport(root, { nowDay = epochDay() } = {}) {
  const data = dashData(root, { nowDay });
  const hist = historyByDay(root, { nowDay });
  const radar = readRadar(root);
  const st = data.ledger.stats;
  const stages = data.metrics.stages || {};
  const stageCount = Object.keys(stages).length;
  const generated = new Date().toISOString();

  const cards = [
    ["claims", st.total],
    ["trusted", st.val?.trusted ?? 0],
    ["contested", data.ledger.contested.length],
    ["tombstoned", st.tombstoned],
    ["events (90d)", hist.total],
    ["stages", stageCount],
  ]
    .map(
      ([label, value]) =>
        `<div class="card"><div class="card-n mono">${escapeHtml(String(value))}</div>` +
        `<div class="card-l muted">${escapeHtml(label)}</div></div>`,
    )
    .join("");

  const atlasLine = data.atlas.built
    ? `atlas: ${data.atlas.symbols} symbols across ${data.atlas.files} files`
    : "atlas: not built";

  const css = `
    ${rootTokensCss()}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 var(--sans);
      -webkit-font-smoothing:antialiased}
    .mono{font-family:var(--mono)}.muted{color:var(--muted)}.faint{color:var(--faint)}
    .wrap{max-width:1000px;margin:0 auto;padding:24px 20px 64px}
    header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;
      border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:20px}
    header .b{font-family:var(--mono);font-size:15px}
    header .b b{color:var(--brand);font-weight:600}
    header .meta{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--muted)}
    h1{font-size:15px;margin:0}
    h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
      margin:0 0 12px;font-weight:600}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;
      margin-bottom:20px}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
    .card-n{font-size:22px;color:var(--brand);font-weight:600}
    .card-l{font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;
      padding:16px 18px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{text-align:left;color:var(--faint);font-weight:500;padding:4px 8px;
      border-bottom:1px solid var(--line)}
    td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
    tr:last-child td{border-bottom:0}
    tr.tomb td{opacity:.5;text-decoration:line-through}
    .bar{display:inline-block;width:52px;height:6px;border-radius:4px;background:var(--bg-2);
      vertical-align:middle;margin-right:6px;overflow:hidden}
    .bar-fill{display:block;height:100%;background:var(--brand)}
    .spark{display:block;margin:4px 0 10px}
    footer{color:var(--faint);font-size:11px;margin-top:24px;text-align:center}
    a{color:var(--brand)}`;

  return (
    "<!doctype html>\n" +
    '<html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    `<title>${escapeHtml(BRAND.brand)} report — ${escapeHtml(data.repo)}</title>` +
    `<style>${css}</style></head><body><div class="wrap">` +
    `<header><span class="b"><b>${escapeHtml(BRAND.brand)}</b> report</span>` +
    `<h1 class="mono">${escapeHtml(data.repo)}</h1>` +
    `<span class="meta">generated ${escapeHtml(generated)} · static · offline</span></header>` +
    `<div class="cards">${cards}</div>` +
    `<section class="panel"><h2>Activity — last ${hist.days} days</h2>` +
    `${sparkline(hist.counts)}<div class="muted mono">${atlasLine}</div></section>` +
    `<section class="panel"><h2>Stages</h2>` +
    `<table><thead><tr><th>stage</th><th>events</th><th>saved (est. tokens)</th></tr></thead>` +
    `<tbody>${stageRows(hist.byStage)}</tbody></table></section>` +
    radarSection(radar) +
    `<section class="panel"><h2>Ledger — top claims by value</h2>` +
    `<table><thead><tr><th>id</th><th>kind</th><th>val</th><th>claim</th></tr></thead>` +
    `<tbody>${ledgerRows(data.ledger.claims)}</tbody></table></section>` +
    `<footer>${escapeHtml(BRAND.brand)} v${escapeHtml(BRAND.version)} · ` +
    `<span class="mono">${escapeHtml(BRAND.cli)} report</span> — regenerate anytime</footer>` +
    "</div></body></html>\n"
  );
}

/**
 * Render and write the report to `.forge/report.html`. Returns the absolute path.
 * @param {string} root
 * @param {{nowDay?: number}} [opts]
 */
export function writeReport(root, opts = {}) {
  const html = renderReport(root, opts);
  const dir = join(root, ".forge");
  mkdirSync(dir, { recursive: true });
  const path = reportPath(root);
  writeFileSync(path, html);
  return path;
}
