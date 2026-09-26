#!/usr/bin/env node
/**
 * Render the social card: docs/assets/og.svg (type over docs/assets/og-background.webp)
 * → docs/assets/og.jpg at 2× (2400×1260 for the declared 1200×630). The Pages build copies
 * og.jpg to the site root, where og:image and twitter:image point. JPEG, not PNG: the art is
 * photographic, and link-preview scrapers (WhatsApp among them) skip images over ~300 KB.
 *
 * Uses the Chrome driver of the pinned Archify checkout (scripts/diagrams.mjs), so there is
 * no browser-automation dependency. It refuses to write a card whose fonts did not load or
 * whose text leaves the art's empty left side (x ≤ 610 of 1200) or the crop-safe area.
 *
 *   node scripts/og-card.mjs            # render docs/assets/og.jpg
 *   node scripts/og-card.mjs --check    # measure only, write nothing
 *
 * Environment: ARCHIFY_CHROME (Chrome/Chromium), FORGE_ARCHIFY_DIR (see scripts/diagrams.mjs).
 * Needs network once for the Inter and JetBrains Mono web fonts (Google Fonts, OFL).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureArchify } from "./diagrams.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "docs", "assets");
/** Where the art begins on the right, and the crop-safe margins (1200×630 units). */
export const SAFE = Object.freeze({ left: 60, top: 36, right: 610, bottom: 594 });
/** Link-preview scrapers skip larger images (WhatsApp at about 300 KB). */
const MAX_BYTES = 300 * 1024;

/** Problems with measured text boxes; empty means every line sits in the safe region. */
export function layoutProblems(boxes, safe = SAFE) {
  return boxes
    .filter(
      (b) => b.x < safe.left || b.y < safe.top || b.x + b.w > safe.right || b.y + b.h > safe.bottom,
    )
    .map(
      (b) =>
        `"${b.text}" spans x ${b.x.toFixed(0)}–${(b.x + b.w).toFixed(0)}, y ${b.y.toFixed(0)}–${(b.y + b.h).toFixed(0)}; allowed x ${safe.left}–${safe.right}, y ${safe.top}–${safe.bottom}`,
    );
}

async function main(argv) {
  const check = argv.includes("--check");
  const { dir } = ensureArchify(root);
  const vc = await import(pathToFileURL(path.join(dir, "archify", "bin", "visual-check.mjs")).href);
  const chrome = process.env.ARCHIFY_CHROME || vc.findChrome();
  if (!chrome) throw new Error("no Chrome/Chromium found — set ARCHIFY_CHROME");
  const svg = readFileSync(path.join(assets, "og.svg"), "utf8");
  const work = mkdtempSync(path.join(tmpdir(), "forge-og-"));
  const page = path.join(work, "og.html");
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8"><base href="${pathToFileURL(`${assets}/`).href}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&family=JetBrains+Mono:wght@600&display=block">
<style>html,body{margin:0;background:#171310}svg{display:block}</style></head><body>${svg}</body></html>`,
  );
  const browser = new vc.ChromeVisualBrowser(chrome);
  try {
    const sid = await browser.sessionPromise;
    const send = (method, params) => browser.cdp.send(method, params, sid, 60000);
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1200,
      height: 630,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await send("Page.navigate", { url: pathToFileURL(page).href });
    const evaluate = async (expression) =>
      (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
        .result?.value;
    const ready = await evaluate(`(async () => {
      for (let i = 0; i < 200 && document.readyState !== "complete"; i++) await new Promise((r) => setTimeout(r, 50));
      await document.fonts.ready;
      const art = new Image(); art.src = "og-background.webp";
      try { await art.decode(); } catch { return { art: false }; }
      return { art: art.naturalWidth > 0, inter: document.fonts.check('800 54px Inter'), mono: document.fonts.check('600 16px "JetBrains Mono"') };
    })()`);
    if (!ready?.art) throw new Error("og-background.webp did not load");
    if (!ready.inter || !ready.mono)
      throw new Error(
        `web fonts did not load (Inter ${ready.inter}, JetBrains Mono ${ready.mono}) — the card needs network once`,
      );
    const boxes = await evaluate(
      `[...document.querySelectorAll('svg text')].map((t) => { const b = t.getBoundingClientRect(); return { text: t.textContent.trim(), x: b.left, y: b.top, w: b.width, h: b.height }; })`,
    );
    const problems = layoutProblems(boxes);
    if (problems.length)
      throw new Error(`text outside the card's safe region:\n${problems.join("\n")}`);
    process.stdout.write(`layout ok: ${boxes.length} lines inside x ${SAFE.left}–${SAFE.right}\n`);
    if (check) return 0;
    // The highest JPEG quality that keeps the card under the scrapers' ~300 KB limit.
    let jpg;
    for (const quality of [90, 86, 82, 78, 74]) {
      const shot = await send("Page.captureScreenshot", {
        format: "jpeg",
        quality,
        clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 },
      });
      jpg = { quality, bytes: Buffer.from(shot.data, "base64") };
      if (jpg.bytes.length <= MAX_BYTES) break;
    }
    if (jpg.bytes.length > MAX_BYTES)
      throw new Error(`og.jpg is ${jpg.bytes.length} bytes even at quality ${jpg.quality}`);
    writeFileSync(path.join(assets, "og.jpg"), jpg.bytes);
    process.stdout.write(
      `wrote docs/assets/og.jpg (2400×1260, quality ${jpg.quality}, ${jpg.bytes.length} bytes)\n`,
    );
    return 0;
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    },
  );
}
