// The single source of the brand. Everything user-facing interpolates from here,
// so a rebrand is one edit to brand.json (+ the `bin` key in package.json).
// ponytail: one token — nothing else in src/ hardcodes the brand string.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const brand = readJson("brand.json");
const pkg = readJson("package.json");

/** Frozen brand config + resolved version + repo root. */
export const BRAND = Object.freeze({ ...brand, version: pkg.version, root });

/** Interpolate {brand}/{cli}/{pkg}/{home} tokens in a template string. */
export function fill(template) {
  return String(template)
    .replaceAll("{brand}", brand.brand)
    .replaceAll("{cli}", brand.cli)
    .replaceAll("{pkg}", brand.pkg)
    .replaceAll("{home}", brand.home);
}

// ---------------------------------------------------------------------------
// Design tokens — brand.json.colors is the SINGLE source for the visual palette.
// Both public web surfaces (landing/index.html + the build-pages status page) and
// test/pages.test.js derive from here, so the palette can't fork into "two palettes
// claiming to be one" again. DATA (the hexes) lives in brand.json; the CSS emission
// is a pure formula over that data.
// ---------------------------------------------------------------------------

/** CSS custom-property declarations for one color scheme ("dark" | "light"),
 *  e.g. `--bg:#171310;--panel:#201a15;…`. Keys mirror brand.json.colors. */
export function cssVars(scheme = "dark") {
  const palette = brand.colors?.[scheme] ?? brand.colors?.dark ?? {};
  return Object.entries(palette)
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");
}

/** The full `:root` token block (dark) + a `prefers-color-scheme: light` override,
 *  plus the shared font stacks. Emitted verbatim into the generated status page and
 *  reconciled against the hand-authored landing page by test/pages.test.js. */
export function rootTokensCss() {
  const fonts = `--sans:${brand.fonts.sans};--mono:${brand.fonts.mono}`;
  return (
    `:root{color-scheme:dark;${cssVars("dark")};${fonts};${typeScaleCss()};${spaceScaleCss()}}` +
    `@media(prefers-color-scheme:light){:root{color-scheme:light;${cssVars("light")}}}`
  );
}

// ---------------------------------------------------------------------------
// Fluid type scale + spacing scale — computed from a formula, not hand-picked
// magic numbers. Every font-size and every margin/padding/gap on both public
// pages is one of these tokens; change the constants below and the whole
// scale recomputes. test/pages.test.js enforces that both pages actually use
// the generated values (the same discipline already applied to colors above).
// ---------------------------------------------------------------------------

// Fluid interpolation viewport bounds (px) — the width range the scale grows across.
const FLUID_MIN_VW = 400;
const FLUID_MAX_VW = 1280;

// Type scale: two modular scales (a tighter ratio at the small viewport, a more
// dramatic one at the large viewport) blended with CSS clamp() so headings grow
// faster than body text as the viewport widens — the standard "fluid type scale"
// technique, generated rather than authored per element.
const TYPE_SCALE = { minBase: 16, maxBase: 18, minRatio: 1.125, maxRatio: 1.2 };
/** Steps below/above the body size (0), named to match CSS var suffixes (n2 = -2). */
export const TYPE_STEPS = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7];

// Spacing scale: every value is `n * SPACE_BASE`, i.e. one base unit and an integer
// multiplier — the same 4px-grid convention used by most modern design systems, here
// generated from the base unit instead of listed as independent constants.
const SPACE_BASE = 4;
export const SPACE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 24];

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** A fluid `clamp()` that grows linearly with viewport width between the two
 *  bounds above, landing exactly on `minPx` at FLUID_MIN_VW and `maxPx` at
 *  FLUID_MAX_VW. Bounds are sorted so clamp() stays valid even when a scale's
 *  min/max ratios invert at negative steps (tiny label text, effectively flat). */
function fluidClamp(minPx, maxPx) {
  const lo = Math.min(minPx, maxPx);
  const hi = Math.max(minPx, maxPx);
  const slope = (maxPx - minPx) / (FLUID_MAX_VW - FLUID_MIN_VW);
  const intercept = minPx - slope * FLUID_MIN_VW;
  const vw = round2(slope * 100);
  const rem = round2(intercept / 16);
  const sign = vw >= 0 ? "+" : "-";
  return `clamp(${round2(lo)}px,${rem}rem ${sign} ${Math.abs(vw)}vw,${round2(hi)}px)`;
}

/** `--fs-N` custom properties (N in TYPE_STEPS, negative steps written `n2`, `n1`) —
 *  each a fluid clamp() derived from TYPE_SCALE. Step 0 is body text. */
export function typeScaleCss() {
  const { minBase, maxBase, minRatio, maxRatio } = TYPE_SCALE;
  return TYPE_STEPS.map((s) => {
    const min = minBase * minRatio ** s;
    const max = maxBase * maxRatio ** s;
    const name = s < 0 ? `n${-s}` : String(s);
    return `--fs-${name}:${fluidClamp(min, max)}`;
  }).join(";");
}

/** `--sp-N` custom properties (N in SPACE_STEPS) — each `N * SPACE_BASE`px. */
export function spaceScaleCss() {
  return SPACE_STEPS.map((n) => `--sp-${n}:${n * SPACE_BASE}px`).join(";");
}
