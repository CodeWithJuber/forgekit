// forge uicheck visual — the Playwright visual loop (P6 §5,
// docs/plans/substrate-v2/07-ui-quality-gate.md). The static fingerprint parses
// SOURCE CSS/classes; it cannot see rendered reality — cascade results, computed
// values, runtime theming. This module renders the page in a real browser (when one
// is available) and feeds the COMPUTED styles of every visible element through the
// SAME fingerprint pipeline as `uicheck design`, so the two gates share one geometry.
//
// ADR-0005 discipline: playwright is an OPTIONAL tier. package.json stays
// dependency-free; the module resolves playwright-core/playwright dynamically (or an
// explicit FORGE_PLAYWRIGHT module path) and degrades to a clear "skipped" note —
// absence is never a crash and never a gate failure.
//
// Security: a CLI that fetches arbitrary URLs by default is an exfiltration hazard
// (a hook could be steered into beaconing repo contents via a crafted URL). http(s)
// targets are therefore refused unless the host is loopback — `--remote` is the
// explicit human override.
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAND } from "./brand.js";
import {
  activeTasteStyle,
  fingerprintText,
  loadProjectFingerprint,
  loadTasteProfile,
  profileChecks,
  scaleChecks,
  UI_GATE_DEFAULTS,
  uiGate,
} from "./uifingerprint.js";

// ---------------------------------------------------------------------------
// Optional-tier resolution — dynamic, never a package.json dependency.
// ---------------------------------------------------------------------------

/**
 * Resolve a playwright runtime: FORGE_PLAYWRIGHT (an explicit module path or bare
 * name — how tests and scratch installs point at an out-of-tree copy) wins and is
 * authoritative when set; otherwise try `playwright-core` then `playwright`. Returns
 * the module (something with `.chromium.launch`) or null — never throws. Browser
 * binaries follow playwright's own PLAYWRIGHT_BROWSERS_PATH handling.
 * @returns {Promise<{chromium:{launch:Function}}|null>}
 */
export async function resolvePlaywright() {
  const explicit = process.env.FORGE_PLAYWRIGHT;
  const candidates = explicit ? [explicit] : ["playwright-core", "playwright"];
  for (const spec of candidates) {
    try {
      let entry = spec;
      if (spec.includes("/") || spec.includes("\\")) {
        // A path (to the package dir or its entry file): resolve through require's
        // algorithm so a directory's package.json "main" is honored, then import as
        // a file URL (playwright ships CJS; the default export is module.exports).
        entry = pathToFileURL(
          createRequire(import.meta.url).resolve(isAbsolute(spec) ? spec : resolve(spec)),
        ).href;
      }
      const mod = await import(entry);
      const pw = mod?.default?.chromium ? mod.default : mod;
      if (typeof pw?.chromium?.launch === "function") return pw;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Target resolution — the security guard lives here, BEFORE any browser exists.
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
const isLoopbackHost = (host) =>
  LOOPBACK.has(host) ||
  host.endsWith(".localhost") ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/**
 * Normalize a CLI target to a navigable URL. Local paths become file:// URLs;
 * http(s) URLs are allowed only for loopback hosts unless `remote` is set — the
 * refusal is the default so no hook or agent can quietly point the gate at the
 * network. Never throws.
 * @param {string} target
 * @param {{remote?:boolean, cwd?:string}} [opts]
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
export function resolveTarget(target, { remote = false, cwd = process.cwd() } = {}) {
  const t = String(target ?? "").trim();
  if (!t) return { ok: false, reason: "no target given" };
  if (/^https?:\/\//i.test(t)) {
    let u;
    try {
      u = new URL(t);
    } catch {
      return { ok: false, reason: `unparseable URL: ${t}` };
    }
    if (!remote && !isLoopbackHost(u.hostname))
      return {
        ok: false,
        reason: `refusing non-local URL ${u.origin} — fetching arbitrary URLs by default is an exfiltration hazard; pass --remote to override deliberately`,
      };
    return { ok: true, url: u.href };
  }
  if (/^file:\/\//i.test(t)) return { ok: true, url: t };
  if (/^[a-z][a-z0-9+.-]*:/i.test(t))
    return { ok: false, reason: `unsupported URL scheme: ${t} (use a file path or http(s))` };
  const p = isAbsolute(t) ? t : join(cwd, t);
  if (!existsSync(p)) return { ok: false, reason: `no such file: ${t}` };
  return { ok: true, url: pathToFileURL(p).href };
}

// ---------------------------------------------------------------------------
// Computed styles → the shared fingerprint vector.
// ---------------------------------------------------------------------------

/**
 * @typedef {{color?:string, backgroundColor?:string, margin?:string, padding?:string,
 *   gap?:string, fontFamily?:string, borderRadius?:string, boxShadow?:string}} ComputedRecord
 */

// Runs INSIDE the page (a string so the repo typechecks without DOM lib types):
// walk visible elements and lift exactly the computed properties the fingerprint
// measures. Values arrive fully resolved — the cascade, var() indirection, and
// runtime theming have already happened, which is the whole point of the loop.
// Two artifact classes must NOT leak into the vector, because they are layout
// residue rather than authored design decisions:
//   - `margin: auto` — getComputedStyle returns the USED value (a centered 1180px
//     container at 1280 reports "0px 50px"), so margins go through the Typed OM
//     (computedStyleMap), which keeps `auto` symbolic; auto sides are dropped.
//   - elements the page never painted (e.g. <option> inside a closed <select>)
//     still carry UA-stylesheet paddings — zero client rects filters them out.
const EXTRACT_JS = `(() => {
  const out = [];
  const SIDES = ["top", "right", "bottom", "left"];
  for (const el of document.querySelectorAll("body, body *")) {
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE" || tag === "NOSCRIPT") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (el.getClientRects().length === 0) continue; // never painted → UA noise only
    let margin = cs.margin;
    if (el.computedStyleMap) {
      const map = el.computedStyleMap();
      margin = SIDES.map((s) => String(map.get("margin-" + s)))
        .filter((v) => v !== "auto")
        .join(" ");
    }
    out.push({
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      margin,
      padding: cs.padding,
      gap: cs.gap,
      fontFamily: cs.fontFamily,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
    });
  }
  return out;
})()`;

// Fully transparent computed colors ("rgba(0, 0, 0, 0)" — every unset background)
// carry no design decision and must not vote black into the palette.
const TRANSPARENT_RE = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/;

/**
 * Serialize computed-style records into synthetic CSS text with the exact property
 * spellings fingerprintText's extractors match — the rendered path reuses the SAME
 * parser/vector as the static path instead of duplicating its math. Identical
 * records collapse to one block (dedup is cosmetic: the fingerprint already
 * uniquifies, this just bounds the text).
 * @param {ComputedRecord[]} records
 * @returns {string}
 */
export function computedStylesToCss(records) {
  const seen = new Set();
  const blocks = [];
  for (const r of records ?? []) {
    const decls = [];
    const push = (prop, v) => {
      const s = String(v ?? "").trim();
      if (!s || s === "none" || s === "auto" || /^normal\b/.test(s) || TRANSPARENT_RE.test(s))
        return;
      decls.push(`${prop}: ${s}`);
    };
    push("color", r.color);
    push("background-color", r.backgroundColor);
    push("margin", r.margin);
    push("padding", r.padding);
    push("gap", r.gap);
    push("font-family", r.fontFamily);
    push("border-radius", r.borderRadius);
    push("box-shadow", r.boxShadow);
    if (!decls.length) continue;
    const block = `x { ${decls.join("; ")}; }`;
    if (!seen.has(block)) {
      seen.add(block);
      blocks.push(block);
    }
  }
  return blocks.join("\n");
}

/** file targets → basename sans extension; URLs → host+path; always [a-z0-9-]. */
function targetSlug(url) {
  const u = new URL(url);
  const base =
    u.protocol === "file:"
      ? (u.pathname.split("/").pop() || "page").replace(/\.[^.]+$/, "")
      : `${u.hostname}${u.pathname}`;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "page"
  );
}

/** The two spec viewports: desktop + phone (§5: "2 viewports"). */
export const DEFAULT_VIEWPORTS = [
  [1280, 800],
  [390, 844],
];

/**
 * Render `target` headless at each viewport, fingerprint the computed styles of all
 * visible elements (one vector across viewports — a design system is one system),
 * and save a screenshot per viewport under `.forge/ui/`.
 * @param {string} target file path, file:// URL, or (loopback) http(s) URL
 * @param {{viewports?:number[][], timeoutMs?:number, remote?:boolean, root?:string,
 *   pw?:{chromium:{launch:Function}}|null}} [opts]
 * @returns {Promise<{ok:true, url:string, fingerprint:import("./uifingerprint.js").Fingerprint,
 *   screenshots:string[], elements:number}|{ok:false, skipped?:boolean, reason:string}>}
 */
export async function renderedFingerprint(target, opts = {}) {
  const {
    viewports = DEFAULT_VIEWPORTS,
    timeoutMs = 15000,
    remote = false,
    root = process.cwd(),
    pw = null,
  } = opts;
  const t = resolveTarget(target, { remote, cwd: root });
  if (!t.ok) return { ok: false, reason: "reason" in t ? t.reason : "bad target" };
  const playwright = pw ?? (await resolvePlaywright());
  if (!playwright)
    return {
      ok: false,
      skipped: true,
      reason: "playwright is not installed (optional tier, ADR-0005)",
    };
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (err) {
    // Installed module but no usable browser binary — same graceful-absence class.
    return { ok: false, skipped: true, reason: `browser launch failed: ${err.message}` };
  }
  try {
    const outDir = join(root, ".forge", "ui");
    mkdirSync(outDir, { recursive: true });
    const slug = targetSlug(t.url);
    /** @type {ComputedRecord[]} */
    const records = [];
    const screenshots = [];
    for (const [width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(t.url, { timeout: timeoutMs, waitUntil: "load" });
      records.push(...(await page.evaluate(EXTRACT_JS)));
      const shot = join(outDir, `${slug}-${width}x${height}.png`);
      await page.screenshot({ path: shot });
      screenshots.push(shot);
      await page.close();
    }
    const fingerprint = fingerprintText(computedStylesToCss(records));
    return { ok: true, url: t.url, fingerprint, screenshots, elements: records.length };
  } catch (err) {
    return { ok: false, reason: `render failed: ${err.message}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The gate — rendered fingerprint through the SAME pipeline as `uicheck design`.
// ---------------------------------------------------------------------------

/**
 * Render, fingerprint, and gate: uiGate (slop + conformance vs the ledger's project
 * fingerprint) + scaleChecks + taste-profile checks — identical semantics to
 * `uicheck design`, applied to what the browser actually painted.
 * @param {string} target
 * @param {{taste?:string|null, remote?:boolean, root?:string, viewports?:number[][],
 *   timeoutMs?:number, pw?:{chromium:{launch:Function}}|null}} [opts]
 *   `taste` is the EXPLICIT profile name (unknown → error, like `design --taste`);
 *   when omitted, a `forge taste`-managed DESIGN.md style is picked up automatically.
 * @returns {Promise<{ok:false, skipped?:boolean, reason:string}|{ok:true, fail:boolean,
 *   pass:boolean, slop:number, conform:number|null, violations:object[], checks:object[],
 *   fingerprint:object, screenshots:string[], elements:number, url:string,
 *   hasProjectFingerprint:boolean, taste:string|null, tauSlop:number, tauConform:number}>}
 */
export async function visualGate(target, opts = {}) {
  const { taste = null, root = process.cwd() } = opts;
  const tasteName = taste ?? activeTasteStyle(root);
  const profile = tasteName ? loadTasteProfile(tasteName) : null;
  if (taste && !profile)
    return {
      ok: false,
      reason: `unknown taste profile "${taste}" — run \`${BRAND.cli} taste\` to list styles`,
    };
  const r = await renderedFingerprint(target, { ...opts, root });
  if (!r.ok) return /** @type {{ok:false, skipped?:boolean, reason:string}} */ (r);
  const projectFp = loadProjectFingerprint(root);
  const tauSlop = profile?.gate?.tau_slop ?? UI_GATE_DEFAULTS.tauSlop;
  const tauConform = profile?.gate?.tau_conform ?? UI_GATE_DEFAULTS.tauConform;
  const gate = uiGate(r.fingerprint, { projectFp, tauSlop, tauConform });
  const checks = [
    ...scaleChecks(r.fingerprint),
    ...(profile ? profileChecks(r.fingerprint, profile) : []),
  ];
  return {
    ok: true,
    fail: !gate.pass || checks.some((c) => !c.pass),
    ...gate,
    checks,
    fingerprint: r.fingerprint,
    screenshots: r.screenshots,
    elements: r.elements,
    url: r.url,
    hasProjectFingerprint: !!projectFp,
    taste: profile ? tasteName : null,
    tauSlop,
    tauConform,
  };
}
