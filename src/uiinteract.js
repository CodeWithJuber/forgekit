// forge uiinteract — the OPTIONAL Playwright interaction loop (ROADMAP "Next";
// docs/plans/substrate-v2/07-ui-quality-gate.md). `uicheck visual` fingerprints what
// the browser PAINTS; this checks what it DOES — keyboard reachability, a visible
// focus ring, console cleanliness, and reduced-motion honesty — and feeds the verdict
// back as `behavioral` oracle evidence on the project design (`fingerprint`) claim.
//
// `behavioral` is the ledger's weakest, cross-family-gated oracle (ledger.js ORACLES,
// w=0.3): a lone interaction verdict can never move a claim on its own. That is the
// point — this stays advisory until fixtures promote it (overview §4 honesty register),
// the same guard-over-prose discipline as the visual gate.
//
// ADR-0005: this module is node stdlib only. Playwright is resolved dynamically via
// uivisual.resolvePlaywright(); its absence is a graceful skip, never a failure —
// exactly like `uicheck visual`. The target passes through uivisual.resolveTarget()'s
// security guard (loopback-only unless --remote) BEFORE any browser is launched.
import { outcomeRecord } from "./ledger.js";
import { appendEvidence, loadClaims, repoLedger } from "./ledger_store.js";
import { DEFAULT_VIEWPORTS, resolvePlaywright, resolveTarget } from "./uivisual.js";
import { contentHash } from "./util.js";

/** The interaction checks, in the order they run. Pure data so docs + tests can name them. */
export const INTERACTION_CHECK_IDS = [
  "console-clean",
  "keyboard-reachable",
  "focus-visible",
  "reduced-motion",
];

/** Aggregate per-check results into a verdict. Empty → not a pass (nothing was proven). */
export function summarizeVerdict(checks) {
  const list = Array.isArray(checks) ? checks : [];
  return { pass: list.length > 0 && list.every((c) => c?.ok === true), checks: list };
}

/**
 * Express a verdict in the ledger's evidence vocabulary: a `behavioral` outcome that
 * confirms (pass) or contradicts (fail) the design claim. The ref is content-addressed
 * on the checks so re-running the same verdict is idempotent (appendEvidence dedupes).
 * @param {string} url
 * @param {{pass:boolean, checks:any[]}} verdict
 * @param {{author?:string, t?:number}} [opts]
 */
export function verdictOutcome(url, verdict, { author = "forge-uiinteract", t = 0 } = {}) {
  const ref = `ui-interact:${url}#${contentHash(JSON.stringify(verdict?.checks ?? []))}`;
  return outcomeRecord({
    oracle: "behavioral",
    result: verdict?.pass ? "confirm" : "contradict",
    ref,
    author,
    t,
  });
}

/**
 * Record a verdict as evidence on the project's design (`fingerprint`) claim. No claim
 * yet → a no-op with guidance (mirrors `uicheck visual`), never an error.
 * @param {string} root
 * @param {string} url
 * @param {{pass:boolean, checks:any[]}} verdict
 * @param {{author?:string, t?:number}} [opts]
 * @returns {{recorded:boolean, claimId?:string, reason?:string}}
 */
export function recordInteraction(root, url, verdict, { author = "forge-uiinteract", t = 0 } = {}) {
  const dir = repoLedger(root);
  const claim = loadClaims(dir).find((c) => c.kind === "fingerprint" && !c.tombstone);
  if (!claim)
    return {
      recorded: false,
      reason:
        "no project fingerprint claim — mint one with `forge uicheck fingerprint <ui files> --mint`",
    };
  const o = verdictOutcome(url, verdict, { author, t });
  if (!o.ok) return { recorded: false, reason: "reason" in o ? o.reason : "invalid outcome" };
  const a = appendEvidence(dir, claim.id, o.outcome);
  return a?.ok ? { recorded: true, claimId: claim.id } : { recorded: false, reason: a?.reason };
}

// The in-page probe: one function serialized into the browser. Returns the raw signals;
// the verdict is assembled host-side so the logic stays testable without a browser.
const PROBE = () => {
  const el = document.activeElement;
  const tag = el && el !== document.body ? el.tagName.toLowerCase() : null;
  const interactive =
    !!el &&
    el !== document.body &&
    (["a", "button", "input", "select", "textarea"].includes(tag) ||
      el.hasAttribute("tabindex") ||
      el.getAttribute("role") === "button");
  let focusVisible = false;
  if (interactive) {
    const s = getComputedStyle(el);
    focusVisible =
      (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
      (s.boxShadow && s.boxShadow !== "none");
  }
  const running = (document.getAnimations ? document.getAnimations() : []).filter(
    (a) => a.playState === "running",
  ).length;
  return { tag, interactive, focusVisible, running };
};

/**
 * Drive `target` in a headless browser under prefers-reduced-motion and run the
 * interaction checks. Reuses the visual gate's Playwright resolver + target guard.
 * `resolve` is injectable so the skip path is testable without a browser.
 * @param {string} target
 * @param {{remote?:boolean, cwd?:string, timeoutMs?:number, resolve?:()=>Promise<any>}} [opts]
 * @returns {Promise<{ok:true, url:string, verdict:{pass:boolean, checks:any[]}}
 *   | {ok:false, skipped:boolean, available?:boolean, url:string|null, reason:string}>}
 */
export async function runInteractions(target, opts = {}) {
  const {
    remote = false,
    cwd = process.cwd(),
    timeoutMs = 20000,
    resolve = resolvePlaywright,
  } = opts;
  const t = resolveTarget(target, { remote, cwd });
  if (!t.ok)
    return {
      ok: false,
      skipped: false,
      url: null,
      reason: "reason" in t ? t.reason : "target refused",
    };

  const pw = await resolve();
  if (!pw)
    return {
      ok: false,
      skipped: true,
      available: false,
      url: t.url,
      reason:
        "no browser runtime — install Playwright or set FORGE_PLAYWRIGHT (interaction checks skipped)",
    };

  let browser;
  try {
    browser = await pw.chromium.launch();
    const context = await browser.newContext({
      reducedMotion: "reduce",
      viewport: DEFAULT_VIEWPORTS?.[0] ?? { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e?.message ?? e)));

    await page.goto(t.url, { waitUntil: "load", timeout: timeoutMs });
    await page.keyboard.press("Tab");
    const p = await page.evaluate(PROBE);

    const checks = [
      {
        id: "console-clean",
        ok: consoleErrors.length === 0,
        detail: consoleErrors.length
          ? `${consoleErrors.length} console error(s); first: ${consoleErrors[0].slice(0, 120)}`
          : "no console errors on load",
      },
      {
        id: "keyboard-reachable",
        ok: p.interactive,
        detail: p.interactive
          ? `Tab reached <${p.tag}>`
          : "Tab did not reach an interactive control (keyboard trap or no focusable UI)",
      },
      {
        id: "focus-visible",
        ok: p.interactive ? p.focusVisible : false,
        detail: p.focusVisible
          ? "the focused control shows a visible focus indicator"
          : "no visible focus ring on the focused control (WCAG 2.4.7)",
      },
      {
        id: "reduced-motion",
        ok: p.running === 0,
        detail:
          p.running === 0
            ? "no animations run under prefers-reduced-motion"
            : `${p.running} animation(s) still running under prefers-reduced-motion`,
      },
    ];
    return { ok: true, url: t.url, verdict: summarizeVerdict(checks) };
  } catch (e) {
    return {
      ok: false,
      skipped: true,
      available: true,
      url: t.url,
      reason: `interaction run failed: ${e?.message ?? e}`,
    };
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}
