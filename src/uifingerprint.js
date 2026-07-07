// forge uifingerprint — the generated-UI quality gate (P6,
// docs/plans/substrate-v2/07-ui-quality-gate.md). AI-generated UI converges on the
// max-likelihood template — the same statistical failure as M5 over-engineering, here
// favoring the *median* design. The taste layer (global/taste/*.md) is prose, and
// prose loses to gradients; this module makes taste MEASURABLE: a deterministic
// design fingerprint (pure static CSS/Tailwind-class parsing — no LLM, no
// screenshots, same discipline as uicheck's WCAG math) and two distances over it:
//   slop(v)    — too CLOSE to a shipped generic-template signature  → fail
//   conform(v) — too FAR from the project's own stored design system → fail
// Good output is far from generic and close to home; both are geometry once UI is a
// feature vector. The subjective residue (beauty) stays with the human reviewer —
// the gate's job is to stop the template from ever reaching them.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mintClaim } from "./ledger.js";
import { loadClaims, putClaim, reindex, repoLedger } from "./ledger_store.js";
import { gitAuthor } from "./util.js";

// ---------------------------------------------------------------------------
// Color parsing — everything normalizes to integer {h,s,l} so hue geometry (the
// "looks like the default framework palette" signal) is comparable across syntaxes.
// ---------------------------------------------------------------------------

/** sRGB (0..255) → {h,s,l} with h in 0..359 degrees, s/l in 0..100 percent. */
export function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d + 6) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Representative [hue, saturation] per Tailwind color family (the 500 shade — the one
// every starter reaches for). Lightness comes from the shade number. Neutral families
// get s≤5 by fiat so an all-slate UI doesn't register as "chromatic blue": their tint
// is a background choice, not an accent.
const TW_FAMILY_HS = {
  red: [0, 84],
  orange: [25, 95],
  amber: [38, 92],
  yellow: [45, 93],
  lime: [84, 81],
  green: [142, 71],
  emerald: [160, 84],
  teal: [173, 80],
  cyan: [189, 94],
  sky: [199, 89],
  blue: [217, 91],
  indigo: [239, 84],
  violet: [258, 90],
  purple: [271, 91],
  fuchsia: [292, 84],
  pink: [330, 81],
  rose: [350, 89],
  slate: [215, 5],
  gray: [220, 5],
  zinc: [240, 4],
  neutral: [0, 0],
  stone: [25, 5],
};

const HEX_RE = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi;
const RGB_RE = /rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})/gi;
const HSL_RE = /hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/gi;
const TW_COLOR_RE = new RegExp(
  `\\b(?:bg|text|border|from|via|to|ring|outline|fill|stroke|accent|caret|decoration|divide|shadow)-(${Object.keys(TW_FAMILY_HS).join("|")})-(50|100|200|300|400|500|600|700|800|900|950)\\b`,
  "g",
);
const TW_BW_RE = /\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(white|black)\b/g;

function parseColors(text) {
  /** @type {{h:number,s:number,l:number}[]} */
  const out = [];
  for (const [, hex] of text.matchAll(HEX_RE)) {
    // 3/4-digit shorthand expands per CSS; a trailing alpha channel is ignored — the
    // fingerprint cares about hue identity, not opacity.
    const full =
      hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
    out.push(
      rgbToHsl(
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
      ),
    );
  }
  for (const [, r, g, b] of text.matchAll(RGB_RE)) out.push(rgbToHsl(+r, +g, +b));
  for (const [, h, s, l] of text.matchAll(HSL_RE))
    out.push({ h: Math.round(+h) % 360, s: Math.round(+s), l: Math.round(+l) });
  for (const [, family, shade] of text.matchAll(TW_COLOR_RE)) {
    const [h, s] = TW_FAMILY_HS[family];
    // Lightness from the shade number: 50→95, 500→50, 950→5 — coarse but monotone,
    // and hue (what the slop signatures key on) is exact.
    out.push({ h, s, l: Math.min(96, Math.max(4, Math.round(100 - +shade / 10))) });
  }
  for (const [, bw] of text.matchAll(TW_BW_RE))
    out.push({ h: 0, s: 0, l: bw === "white" ? 100 : 0 });
  return out;
}

// ---------------------------------------------------------------------------
// Length parsing — spacing, radii. Everything lands in px (rem/em at the 16px root)
// so the base-unit inference sees one scale.
// ---------------------------------------------------------------------------

const LEN_RE = /(-?\d*\.?\d+)(px|rem|em)\b/g;

/** Absolute px lengths inside one CSS value string (zero and non-lengths skipped). */
function parseLengths(value) {
  const out = [];
  for (const [, n, unit] of String(value).matchAll(LEN_RE)) {
    const px = Math.abs(+n) * (unit === "px" ? 1 : 16);
    if (px > 0) out.push(Math.round(px * 100) / 100);
  }
  return out;
}

const cssValues = (text, propRe) => [...text.matchAll(propRe)].map((m) => m[1]);

// The leading class keeps `scroll-padding`, `--m-4` etc. from matching.
const SPACING_PROP_RE = /(?:^|[;{\s"'])(?:margin|padding)(?:-[a-z-]+)?\s*:\s*([^;}]+)/gi;
const GAP_PROP_RE = /(?:^|[;{\s"'])(?:row-gap|column-gap|gap)\s*:\s*([^;}]+)/gi;
const RADIUS_PROP_RE =
  /(?:^|[;{\s"'])border(?:-(?:top|bottom|start|end)-(?:left|right)?)?-radius\s*:\s*([^;}]+)/gi;
const SHADOW_PROP_RE = /(?:^|[;{\s"'])box-shadow\s*:\s*([^;}]+)/gi;
const FONT_PROP_RE = /(?:^|[;{\s"'])font-family\s*:\s*([^;}]+)/gi;

// Tailwind spacing utilities: p-4/mx-2/gap-6/space-y-8 → n×4 px (p-px → 1px). The
// lookbehind stops `top-4` matching as `p-4`.
const TW_SPACE_RE =
  /(?<![\w-])-?(?:[pm][trblxyse]?|gap(?:-[xy])?|space-[xy])-(\d+(?:\.\d+)?|px)(?![\w-])/g;
// rounded[-side][-size]; side alternatives are ordered two-letter-first so `-tl`
// never half-matches as `-t`+garbage.
const TW_ROUNDED_RE =
  /(?<![\w-])rounded(?:-(?:ss|se|ee|es|tl|tr|br|bl|t|r|b|l|s|e))?(?:-(none|sm|md|lg|xl|2xl|3xl|full))?(?![\w-])/g;
const TW_ROUNDED_PX = { none: 0, sm: 2, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, full: 9999 };
const TW_SHADOW_RE = /(?<![\w-])shadow(?:-(sm|md|lg|xl|2xl|inner|none))?(?![\w-])/g;
const TW_FONT_RE = /(?<![\w-])font-(sans|serif|mono)(?![\w-])/g;
const TW_FONT_STACK = { sans: "sans-serif", serif: "serif", mono: "monospace" };

// ---------------------------------------------------------------------------
// Base-unit inference — approximate GCD by residual minimization.
// ---------------------------------------------------------------------------

const offBase = (s, u) => Math.abs(s - Math.round(s / u) * u);

/**
 * Infer the spacing base unit: residual(u) = Σ distance-to-nearest-multiple-of-u.
 * Residuals are monotone in divisibility (every multiple of 8 is one of 4 and 2), so
 * a bare argmin always degenerates to the smallest candidate — instead take the
 * LARGEST base that explains the data within half a pixel per value, falling back to
 * the true argmin when nothing fits cleanly.
 * @param {number[]} values @param {number[]} [candidates]
 * @returns {number|null} null when there are no values to infer from
 */
export function inferSpacingBase(values, candidates = [2, 4, 8]) {
  if (!values.length) return null;
  const residual = (u) => values.reduce((sum, s) => sum + offBase(s, u), 0);
  let best = null;
  for (const u of [...candidates].sort((a, b) => a - b))
    if (residual(u) <= 0.5 * values.length) best = u;
  if (best !== null) return best;
  return candidates.reduce((arg, u) => (residual(u) < residual(arg) ? u : arg), candidates[0]);
}

/** Fraction of values sitting on multiples of `base` within ε (vacuously 1). */
export function onScaleFraction(values, base, epsilon = 0.5) {
  if (!values.length || !base) return 1;
  return values.filter((s) => offBase(s, base) <= epsilon).length / values.length;
}

// ---------------------------------------------------------------------------
// The fingerprint.
// ---------------------------------------------------------------------------

/**
 * @typedef {{h:number,s:number,l:number}} Hsl
 * @typedef {{palette:Hsl[], paletteSize:number, hueBuckets:number[], spacing:number[],
 *   spacingBase:number|null, spacingOnScale:number, fontFamilies:string[],
 *   radii:number[], radiusLevels:number, shadowLevels:number}} Fingerprint
 */

// Below this saturation a color is a neutral: it carries no hue identity, so it must
// not vote in the hue histogram (an ink-and-paper UI is not "red" at h=0).
const NEUTRAL_S = 10;

const sortNum = (a, b) => a - b;
const uniqSorted = (arr) => [...new Set(arr)].sort(sortNum);

/**
 * Extract the design fingerprint from raw CSS / JSX / Tailwind-class text. Pure and
 * deterministic — the same text always yields the same vector (it becomes a
 * content-addressed ledger claim, so this is a protocol requirement, not a nicety).
 * @param {string} text
 * @returns {Fingerprint}
 */
export function fingerprintText(text) {
  const t = String(text);

  const seen = new Set();
  /** @type {Hsl[]} */
  const palette = [];
  for (const c of parseColors(t)) {
    const key = `${c.h},${c.s},${c.l}`;
    if (!seen.has(key)) {
      seen.add(key);
      palette.push(c);
    }
  }
  palette.sort((a, b) => a.h - b.h || a.s - b.s || a.l - b.l);
  const hueBuckets = new Array(12).fill(0);
  for (const c of palette) if (c.s >= NEUTRAL_S) hueBuckets[Math.floor((c.h % 360) / 30)]++;

  const spacingRaw = [
    ...cssValues(t, SPACING_PROP_RE).flatMap(parseLengths),
    ...cssValues(t, GAP_PROP_RE).flatMap(parseLengths),
    ...[...t.matchAll(TW_SPACE_RE)].map(([, n]) => (n === "px" ? 1 : +n * 4)).filter(Boolean),
  ];
  const spacing = uniqSorted(spacingRaw);
  const spacingBase = inferSpacingBase(spacing);
  const spacingOnScale = onScaleFraction(spacing, spacingBase);

  const fontFamilies = [
    ...new Set([
      // Only the FIRST family in a stack — the intended face; the rest are fallbacks.
      ...cssValues(t, FONT_PROP_RE)
        .map((v) =>
          String(v.split(",")[0])
            .trim()
            .replace(/^["']|["']$/g, "")
            .toLowerCase(),
        )
        .filter((f) => f && !f.includes("(")), // var()/env() indirections carry no face
      ...[...t.matchAll(TW_FONT_RE)].map(([, k]) => TW_FONT_STACK[k]),
    ]),
  ].sort();

  const radii = uniqSorted([
    // 999+px pill radii normalize to one "full" level — 9999 vs 99999 is not a choice.
    ...cssValues(t, RADIUS_PROP_RE)
      .flatMap(parseLengths)
      .map((r) => (r >= 999 ? 9999 : r)),
    ...[...t.matchAll(TW_ROUNDED_RE)]
      .map(([, size]) => (size === undefined ? 4 : TW_ROUNDED_PX[size]))
      .filter((r) => r > 0),
  ]);

  const shadows = new Set([
    ...cssValues(t, SHADOW_PROP_RE)
      .map((v) => v.trim().replace(/\s+/g, " "))
      .filter((v) => v !== "none"),
    ...[...t.matchAll(TW_SHADOW_RE)]
      .map(([, size]) => `tw:${size ?? "base"}`)
      .filter((s) => s !== "tw:none"),
  ]);

  return {
    palette,
    paletteSize: palette.length,
    hueBuckets,
    spacing,
    spacingBase,
    spacingOnScale,
    fontFamilies,
    radii,
    radiusLevels: radii.length,
    shadowLevels: shadows.size,
  };
}

/**
 * Fingerprint a set of files as ONE vector (a design system is a property of the
 * whole surface, not any single file). Unreadable files are skipped; the file list
 * is sorted first so argument order can never change the vector.
 * @param {string} root @param {string[]} files
 * @returns {Fingerprint}
 */
export function fingerprintFiles(root, files) {
  const texts = [];
  for (const f of [...files].sort()) {
    try {
      texts.push(readFileSync(isAbsolute(f) ? f : join(root, f), "utf8"));
    } catch {}
  }
  return fingerprintText(texts.join("\n"));
}

// ---------------------------------------------------------------------------
// Slop distance — the shipped generic-template signature set. Each entry is the
// measurable footprint of a recognizable "AI default" look; being NEAR one of these
// is the failure. Curated, versioned, extensible (spec §2).
// ---------------------------------------------------------------------------

/**
 * @typedef {{id:string, why:string, hues:number[], spacingBase:number,
 *   spacingCount:number, fontCount:number, radii:number[], radiusLevels:number,
 *   shadowLevels:number}} GenericSignature
 */

/** @type {GenericSignature[]} */
export const GENERIC_SIGNATURES = [
  {
    id: "tailwind-default",
    why: "the untouched Tailwind starter: blue-500/indigo-500 accents, flat 8px-everything spacing (the p-2/p-4/p-8 trio), one sans stack, rounded-xl on every card, one soft shadow",
    hues: [217, 239], // blue-500 #3b82f6 ≈ h217, indigo-500 #6366f1 ≈ h239
    spacingBase: 8,
    spacingCount: 3, // 8/16/32 — a flat scale with no rhythm
    fontCount: 1,
    radii: [12], // rounded-xl
    radiusLevels: 1,
    shadowLevels: 1,
  },
  {
    id: "bootstrap-default",
    why: "stock Bootstrap: the #0d6efd primary (h≈216), 1rem spacers halving to 8px steps, one system stack, uniform 6px --bs-border-radius, one shadow",
    hues: [216],
    spacingBase: 8,
    spacingCount: 4, // the $spacer/2 ladder: 8/16/24/48
    fontCount: 1,
    radii: [6],
    radiusLevels: 1,
    shadowLevels: 1,
  },
  {
    id: "ai-landing-gradient",
    why: "the canonical AI landing page: violet→purple gradient hero (h 258–271), airy uniform 8px spacing, rounded-2xl cards, two layered soft shadows",
    hues: [258, 271], // violet-500 #8b5cf6, purple-500 #a855f7
    spacingBase: 8,
    spacingCount: 3,
    fontCount: 1,
    radii: [16], // rounded-2xl
    radiusLevels: 1,
    shadowLevels: 2,
  },
];

const round3 = (x) => Math.round(x * 1000) / 1000;
const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};
const chromaticHues = (fp) => fp.palette.filter((c) => c.s >= NEUTRAL_S).map((c) => c.h);

/** Tolerate a raw ledger body (or partial vector) anywhere a fingerprint is read. */
const asFp = (fp) => ({
  palette: fp?.palette ?? [],
  paletteSize: fp?.paletteSize ?? 0,
  hueBuckets: fp?.hueBuckets ?? new Array(12).fill(0),
  spacing: fp?.spacing ?? [],
  spacingBase: fp?.spacingBase ?? null,
  spacingOnScale: fp?.spacingOnScale ?? 1,
  fontFamilies: fp?.fontFamilies ?? [],
  radii: fp?.radii ?? [],
  radiusLevels: fp?.radiusLevels ?? 0,
  shadowLevels: fp?.shadowLevels ?? 0,
});

// Per-feature distances (each in [0,1]) from a fingerprint to one generic signature.
// Only features the input actually exhibits are compared — an all-CSS-variables file
// with no radii must not be judged on radii it doesn't have.
function sigFeatures(fp, sig) {
  const out = [];
  if (fp.paletteSize > 0) {
    const hues = chromaticHues(fp);
    // A neutral-only palette is maximally far from a blue-band template (grayscale is
    // a deliberate stance, e.g. brutalist), hence d=1 rather than "incomparable".
    const d = hues.length
      ? hues.reduce((s, h) => s + Math.min(...sig.hues.map((z) => hueDist(h, z))), 0) /
        hues.length /
        180
      : 1;
    out.push({ feature: "palette", d: round3(d) });
  }
  if (fp.spacing.length) {
    const baseD = fp.spacingBase === sig.spacingBase ? 0 : 1;
    const divD = Math.min(1, Math.abs(fp.spacing.length - sig.spacingCount) / 8);
    out.push({ feature: "spacing", d: round3((baseD + divD) / 2) });
  }
  if (fp.fontFamilies.length)
    out.push({
      feature: "type",
      d: round3(Math.min(1, Math.abs(fp.fontFamilies.length - sig.fontCount) / 2)),
    });
  if (fp.radii.length) {
    const near = Math.min(
      ...fp.radii.map((r) => Math.min(...sig.radii.map((z) => Math.min(1, Math.abs(r - z) / 16)))),
    );
    const lev = Math.min(1, Math.abs(fp.radiusLevels - sig.radiusLevels) / 3);
    out.push({ feature: "shape", d: round3((near + lev) / 2) });
  }
  // Zero shadows on a UI that exhibits other features IS signal (flat ≠ template
  // soft-shadow); but on an empty vector it would be judging nothing, so gate on
  // having at least one other measurable feature.
  if (out.length || fp.shadowLevels > 0)
    out.push({
      feature: "elevation",
      d: round3(Math.min(1, Math.abs(fp.shadowLevels - sig.shadowLevels) / 3)),
    });
  return out;
}

/**
 * Nearest generic signature with its per-feature breakdown (what uiGate turns into
 * actionable violations). Null when the input had nothing measurable.
 * @param {Fingerprint} fingerprint
 * @returns {{id:string, why:string, distance:number, features:{feature:string,d:number}[]}|null}
 */
export function nearestGeneric(fingerprint) {
  const fp = asFp(fingerprint);
  let best = null;
  for (const sig of GENERIC_SIGNATURES) {
    const features = sigFeatures(fp, sig);
    if (!features.length) continue;
    const distance = round3(features.reduce((s, f) => s + f.d, 0) / features.length);
    if (!best || distance < best.distance) best = { id: sig.id, why: sig.why, distance, features };
  }
  return best;
}

/** Normalized distance (0..1) to the NEAREST generic-template signature. Low = slop.
 *  An empty/unmeasurable vector returns 1 — nothing measurable is not generic. */
export function slopDistance(fingerprint) {
  return nearestGeneric(fingerprint)?.distance ?? 1;
}

// ---------------------------------------------------------------------------
// Conformance — distance from the project's own design system.
// ---------------------------------------------------------------------------

const jaccardDist = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  const uni = new Set([...A, ...B]).size;
  if (!uni) return 0;
  return 1 - [...A].filter((x) => B.has(x)).length / uni;
};

// Per-feature distances between two fingerprints; comparable features only.
function conformFeatures(a, b) {
  const out = [];
  if (a.paletteSize || b.paletteSize) {
    const ha = chromaticHues(a);
    const hb = chromaticHues(b);
    let d;
    if (!ha.length && !hb.length)
      d = 0; // two neutral-only systems agree
    else if (!ha.length || !hb.length)
      d = 1; // chromatic vs grayscale — different worlds
    else {
      // Symmetric mean nearest-hue distance (an averaged Hausdorff): every hue in
      // each palette must have a home in the other.
      const dir = (xs, ys) =>
        xs.reduce((s, h) => s + Math.min(...ys.map((z) => hueDist(h, z))), 0) / xs.length;
      d = (dir(ha, hb) + dir(hb, ha)) / 2 / 180;
    }
    out.push({ feature: "palette", d: round3(d) });
  }
  if (a.spacing.length && b.spacing.length) {
    // Base disagreement in octaves (2 vs 8 is worse than 4 vs 8) blended with how
    // much of the OUTPUT sits off the PROJECT's base — the actionable half.
    const baseD = Math.min(1, Math.abs(Math.log2((a.spacingBase || 1) / (b.spacingBase || 1))) / 2);
    const scaleD = 1 - onScaleFraction(a.spacing, b.spacingBase ?? undefined);
    out.push({ feature: "spacing", d: round3((baseD + scaleD) / 2) });
  }
  if (a.fontFamilies.length || b.fontFamilies.length)
    out.push({ feature: "type", d: round3(jaccardDist(a.fontFamilies, b.fontFamilies)) });
  if (a.radii.length || b.radii.length) {
    const lev = Math.min(1, Math.abs(a.radiusLevels - b.radiusLevels) / 3);
    out.push({ feature: "shape", d: round3((jaccardDist(a.radii, b.radii) + lev) / 2) });
  }
  out.push({
    feature: "elevation",
    d: round3(Math.min(1, Math.abs(a.shadowLevels - b.shadowLevels) / 3)),
  });
  return out;
}

/**
 * Normalized distance (0..1) between a fingerprint and the project's. High = the
 * output ignored the system the codebase already has.
 * @param {Fingerprint} fingerprint @param {Fingerprint} projectFp
 */
export function conformance(fingerprint, projectFp) {
  const feats = conformFeatures(asFp(fingerprint), asFp(projectFp));
  return feats.length ? round3(feats.reduce((s, f) => s + f.d, 0) / feats.length) : 0;
}

// ---------------------------------------------------------------------------
// The gate — actionable violations, never a bare score (spec §2: each failing
// feature maps to a concrete edit).
// ---------------------------------------------------------------------------

/** Default thresholds; taste profiles override these in P8 once fixtures show separation. */
export const UI_GATE_DEFAULTS = { tauSlop: 0.25, tauConform: 0.5 };

const SLOP_HINTS = {
  palette: (fp, near) =>
    `palette hues sit in the ${near.id} band — pick a brand hue (or the project's accent) outside it`,
  spacing: (fp) =>
    `spacing is the uniform ${fp.spacingBase ?? 8}px template rhythm — use a deliberate scale (e.g. the project's 4-based scale with real jumps)`,
  type: () =>
    "a single default font stack is the strongest template tell — use the project's faces or a deliberate pairing",
  shape: () =>
    "one uniform large radius on everything reads as template — commit to few deliberate radii (0 counts)",
  elevation: () =>
    "the one-soft-shadow-on-every-card look is generic — flatten, or define explicit elevation steps",
};

const CONFORM_HINTS = {
  palette: (fp, proj) =>
    `output hues [${chromaticHues(proj).join(", ") || "neutral-only"}] are the project's — reuse those accents instead of [${chromaticHues(fp).join(", ") || "none"}]`,
  spacing: (fp, proj) =>
    `the project spacing base is ${proj.spacingBase}px — put values on that scale (output inferred base ${fp.spacingBase}px)`,
  type: (fp, proj) =>
    `output fonts [${fp.fontFamilies.join(", ")}] don't match the project's [${proj.fontFamilies.join(", ")}] — use the project stacks`,
  shape: (fp, proj) =>
    `project radii are [${proj.radii.join(", ")}] — use those levels, not [${fp.radii.join(", ")}]`,
  elevation: (fp, proj) =>
    `project uses ${proj.shadowLevels} shadow level(s), output uses ${fp.shadowLevels} — match the project's elevation system`,
};

/**
 * The two-sided quality gate: PASS iff slop ≥ tauSlop AND (when a project
 * fingerprint exists) conform ≤ tauConform. Violations name the driving feature and
 * a concrete edit; because each per-feature distance is in [0,1], a failing mean
 * always has at least one failing feature — a FAIL can never arrive hint-less.
 * @param {Fingerprint} fingerprint
 * @param {{projectFp?:Fingerprint|null, tauSlop?:number, tauConform?:number}} [opts]
 * @returns {{pass:boolean, slop:number, conform:number|null,
 *   violations:{feature:string, detail:string, hint:string}[]}}
 */
export function uiGate(fingerprint, opts = {}) {
  const { projectFp = null, tauSlop, tauConform } = { ...UI_GATE_DEFAULTS, ...opts };
  const fp = asFp(fingerprint);
  const violations = [];
  const near = nearestGeneric(fp);
  const slop = near?.distance ?? 1;
  if (near && slop < tauSlop) {
    for (const f of near.features)
      if (f.d < tauSlop)
        violations.push({
          feature: f.feature,
          detail: `${f.feature} is Δ${f.d} from the "${near.id}" template (need ≥ ${tauSlop} overall)`,
          hint: SLOP_HINTS[f.feature](fp, near),
        });
  }
  let conform = null;
  if (projectFp) {
    const proj = asFp(projectFp);
    const feats = conformFeatures(fp, proj);
    conform = feats.length ? round3(feats.reduce((s, f) => s + f.d, 0) / feats.length) : 0;
    if (conform > tauConform) {
      for (const f of feats)
        if (f.d > tauConform)
          violations.push({
            feature: f.feature,
            detail: `${f.feature} is Δ${f.d} from the project fingerprint (need ≤ ${tauConform} overall)`,
            hint: CONFORM_HINTS[f.feature](fp, proj),
          });
    }
  }
  return { pass: violations.length === 0, slop, conform, violations };
}

// ---------------------------------------------------------------------------
// Scale-conformance checks — the ASSERTABLE_CHECKS extension (spec §4). Same shape
// as uicheck's list: deterministic, per-fingerprint, pass|fail + fix hint. The ids
// mirror the entries added to uicheck.ASSERTABLE_CHECKS (drift-tested).
// ---------------------------------------------------------------------------

/** A design system uses FEW levels, deliberately — these caps encode that. */
export const SCALE_CHECK_DEFAULTS = {
  epsilon: 0.5, // px tolerance for "on the base scale" (sub-pixel = rounding noise)
  minOnScale: 0.9, // ≥90% of spacing values must sit on the base
  maxRadiusLevels: 3,
  maxShadowLevels: 3,
  maxPalette: 8, // distinct normalized colors — beyond this it's pixel-soup, not a palette
};

/**
 * Run the deterministic scale checks over a fingerprint.
 * @param {Fingerprint} fingerprint
 * @param {{base?:number|null, epsilon?:number, minOnScale?:number, maxRadiusLevels?:number,
 *   maxShadowLevels?:number, maxPalette?:number}} [opts]
 *   `base` = the DECLARED design-system base; defaults to the inferred one.
 * @returns {{id:string, pass:boolean, detail:string, hint:string}[]}
 */
export function scaleChecks(fingerprint, opts = {}) {
  const fp = asFp(fingerprint);
  const o = { ...SCALE_CHECK_DEFAULTS, base: fp.spacingBase, ...opts };
  const off = o.base ? fp.spacing.filter((s) => offBase(s, o.base) > o.epsilon) : [];
  const onFrac = fp.spacing.length ? 1 - off.length / fp.spacing.length : 1;
  return [
    {
      id: "spacing-scale",
      pass: onFrac >= o.minOnScale,
      detail: `${Math.round(onFrac * 100)}% of ${fp.spacing.length} spacing value(s) on the ${o.base ?? "(none)"}px base (ε ${o.epsilon}px)`,
      hint: off.length ? `move ${off.join(", ")}px onto the ${o.base}px scale` : "",
    },
    {
      id: "radius-levels",
      pass: fp.radiusLevels <= o.maxRadiusLevels,
      detail: `${fp.radiusLevels} distinct radius level(s) (max ${o.maxRadiusLevels})`,
      hint:
        fp.radiusLevels > o.maxRadiusLevels
          ? `collapse [${fp.radii.join(", ")}] to ≤${o.maxRadiusLevels} deliberate levels`
          : "",
    },
    {
      id: "shadow-levels",
      pass: fp.shadowLevels <= o.maxShadowLevels,
      detail: `${fp.shadowLevels} distinct shadow level(s) (max ${o.maxShadowLevels})`,
      hint:
        fp.shadowLevels > o.maxShadowLevels
          ? `define ≤${o.maxShadowLevels} elevation steps and reuse them`
          : "",
    },
    {
      id: "palette-size",
      pass: fp.paletteSize <= o.maxPalette,
      detail: `${fp.paletteSize} distinct color(s) (max ${o.maxPalette})`,
      hint:
        fp.paletteSize > o.maxPalette
          ? "consolidate to design tokens — a palette is a decision, not an accumulation"
          : "",
    },
  ];
}

// ---------------------------------------------------------------------------
// The project fingerprint claim — v_proj lives in the PCM ledger so it is shared
// with the team and updated by the same evidence rules as everything else.
// ---------------------------------------------------------------------------

/**
 * Extract the project fingerprint from `files` and store it as a `fingerprint`
 * claim. Content-addressed: the same UI surface mints the same id on every machine,
 * so teammates converge on one claim instead of duplicating.
 * @param {string} root @param {string[]} files @param {{t?:number}} [opts]
 * @returns {{ok:true, id:string, existed:boolean, fingerprint:Fingerprint}|{ok:false, reason:string}}
 */
export function mintProjectFingerprint(root, files, { t = 0 } = {}) {
  const fingerprint = fingerprintFiles(root, files);
  const minted = mintClaim({
    kind: "fingerprint",
    body: fingerprint,
    scope: { level: "repo" },
    provenance: { agent: "uicheck", author: gitAuthor() },
    t,
  });
  if (!minted.ok) return { ok: false, reason: "reason" in minted ? minted.reason : "mint failed" };
  const dir = repoLedger(root);
  const put = putClaim(dir, minted.claim);
  if (!put.ok) return { ok: false, reason: put.reason ?? "putClaim failed" };
  reindex(dir, t);
  return { ok: true, id: minted.claim.id, existed: Boolean(put.existed), fingerprint };
}

/**
 * The stored project fingerprint (latest live `fingerprint` claim), or null on a
 * greenfield repo — the gate then runs slop-only (spec §2).
 * @param {string} root
 * @returns {Fingerprint|null}
 */
export function loadProjectFingerprint(root) {
  const live = loadClaims(repoLedger(root)).filter((c) => c.kind === "fingerprint" && !c.tombstone);
  if (!live.length) return null;
  live.sort((a, b) => (b.provenance?.t ?? 0) - (a.provenance?.t ?? 0) || (a.id < b.id ? -1 : 1));
  return live[0].body;
}
