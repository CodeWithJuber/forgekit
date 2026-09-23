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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BRAND } from "./brand.js";
import { mintClaim } from "./ledger.js";
import { loadClaims, putClaim, reindex, repoLedger } from "./ledger_store.js";
import { parseColor } from "./uicheck.js";
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
// The optional last group is the alpha (`, 0` or `/ 0%`): only used to skip a fully
// transparent color, which paints nothing.
const ALPHA_TAIL = String.raw`(?:\s*[,/]\s*([\d.]+%?))?`;
const RGB_RE = new RegExp(
  String.raw`rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})${ALPHA_TAIL}`,
  "gi",
);
const HSL_RE = new RegExp(
  String.raw`hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%${ALPHA_TAIL}`,
  "gi",
);
/** Is a captured alpha (`0`, `0.0`, `0%`) zero? Undefined (no alpha) is opaque. */
const zeroAlpha = (/** @type {string|undefined} */ a) =>
  a !== undefined && +a.replace("%", "") === 0;
const TW_COLOR_RE = new RegExp(
  `\\b(?:bg|text|border|from|via|to|ring|outline|fill|stroke|accent|caret|decoration|divide|shadow)-(${Object.keys(TW_FAMILY_HS).join("|")})-(50|100|200|300|400|500|600|700|800|900|950)\\b`,
  "g",
);
const TW_BW_RE = /\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(white|black)\b/g;
// oklch()/oklab() — Tailwind v4's default palette syntax (and what browsers report
// for colors authored that way). `_` is a space inside Tailwind arbitrary values.
const OKLAB_FN_RE = /\boklch\([^()]*\)|\boklab\([^()]*\)/gi;

// A Tailwind utility's value: a theme key (`card`, `brand-fill`, `primary-500`) or
// an arbitrary `[...]` value. Shared by the rounded/shadow/color matchers below.
const TW_KEY = String.raw`(?:[\w.]+(?:-[\w.]+)*|\[[^\]\s]+\])`;
// Color utilities matched against theme keys (default families stay on TW_COLOR_RE);
// an optional `/opacity` modifier is accepted and ignored — hue identity only.
const TW_TOKEN_COLOR_RE = new RegExp(
  String.raw`(?<![\w-])(?:bg|text|border(?:-[xytrblse])?|from|via|to|ring|outline|fill|stroke|accent|caret|decoration|divide|shadow|placeholder)-(${TW_KEY})(?:\/[\w.%\[\]]+)?(?![\w-])`,
  "g",
);

/** The inside of a Tailwind arbitrary value: `[0_1px_2px_#000]` → `0 1px 2px #000`. */
const arbitrary = (key) => key.slice(1, -1).replace(/_/g, " ");

const hslOf = (/** @type {{r:number,g:number,b:number}} */ c) => rgbToHsl(c.r, c.g, c.b);

/** parseColor, but null instead of a throw — for scanning free text. A fully
 *  transparent color (`transparent`, alpha 0) is null too: it paints nothing, so it is
 *  not a palette entry (and must not count as black). */
function tryHsl(value) {
  try {
    const c = parseColor(value);
    return c.a === 0 ? null : hslOf(c);
  } catch {
    return null;
  }
}

/** Does the whole string parse as one color? */
function isColor(value) {
  try {
    parseColor(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @param {ThemeTokens|null} [theme] resolves `bg-brand`-style token utilities
 */
function parseColors(text, theme = null) {
  /** @type {{h:number,s:number,l:number}[]} */
  const out = [];
  for (const [, hex] of text.matchAll(HEX_RE)) {
    // 3/4-digit shorthand expands per CSS; a trailing alpha channel is ignored — the
    // fingerprint cares about hue identity, not opacity — except alpha 0 (#0000,
    // #rrggbb00), which paints nothing.
    if (/^(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(hex)) continue;
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
  for (const [, r, g, b, a] of text.matchAll(RGB_RE))
    if (!zeroAlpha(a)) out.push(rgbToHsl(+r, +g, +b));
  for (const [, h, s, l, a] of text.matchAll(HSL_RE))
    if (!zeroAlpha(a)) out.push({ h: Math.round(+h) % 360, s: Math.round(+s), l: Math.round(+l) });
  for (const [fn] of text.matchAll(OKLAB_FN_RE)) {
    const c = tryHsl(fn.replace(/_/g, " "));
    if (c) out.push(c);
  }
  for (const [, family, shade] of text.matchAll(TW_COLOR_RE)) {
    // A theme that redefines a default family key wins — TW_TOKEN_COLOR_RE reads it.
    if (theme?.colors.has(`${family}-${shade}`)) continue;
    const [h, s] = TW_FAMILY_HS[family];
    // Lightness from the shade number: 50→95, 500→50, 950→5 — coarse but monotone,
    // and hue (what the slop signatures key on) is exact.
    out.push({ h, s, l: Math.min(96, Math.max(4, Math.round(100 - +shade / 10))) });
  }
  for (const [, bw] of text.matchAll(TW_BW_RE)) {
    if (theme?.colors.has(bw)) continue;
    out.push({ h: 0, s: 0, l: bw === "white" ? 100 : 0 });
  }
  // Token + arbitrary color utilities: `bg-brand-fill`, `text-on-band/80` resolve
  // through the theme; `text-[#abc]`, `bg-[oklch(0.6_0.1_250)]` parse in place.
  // Anything else (`text-sm`, `border-t`, `text-[13px]`) is not a color — skipped.
  for (const [, key] of text.matchAll(TW_TOKEN_COLOR_RE)) {
    const c = key.startsWith("[")
      ? tryHsl(arbitrary(key).replace(/^color:/, ""))
      : (theme?.colors.get(key) ?? null);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Custom-property resolution — a token-driven stylesheet (`--s4: 16px` consumed as
// `padding: var(--s4)`) carries its whole design system in var() indirections; the
// extractors below only see literals, so var() must be substituted FIRST or the
// fingerprint reads a 6-value scale as one value.
// ---------------------------------------------------------------------------

// `--name: value` declarations (value stops at `;`/`}` like every prop regex here).
const VAR_DECL_RE = /(--[\w-]+)\s*:\s*([^;}]+)/g;
// `var(--name)` / `var(--name, fallback)`; the fallback may contain ONE paren level
// (rgba(...), nested var(...)) — deeper nesting stays unmatched and thus untouched.
const VAR_USE_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\s*\)/g;

/** One substitution pass of `var(--name[, fallback])` against `decls`. */
const substituteVars = (/** @type {string} */ s, /** @type {Map<string,string>} */ decls) =>
  s.replace(VAR_USE_RE, (whole, name, fallback) => {
    const v = decls.get(name);
    if (v !== undefined) return v;
    return fallback !== undefined ? String(fallback).trim() : whole;
  });

// A block scoped to dark mode: a `.dark` class (Tailwind / shadcn), a
// `[data-theme="dark"]`-style attribute (next-themes), `prefers-color-scheme: dark`,
// or Tailwind's `@variant dark`. Negations (`:root:not(.dark)`, `@media not (…)`) are
// removed first: they scope a block to LIGHT mode.
const DARK_SCOPE_RE =
  /\.dark(?![\w-])|\[\s*data-[\w-]+\s*[~|^$*]?=\s*["']?dark["']?\s*[is]?\s*\]|prefers-color-scheme\s*:\s*dark\b|@(?:custom-)?variant\s+dark\b/i;
const NEGATION_RE = /\bnot\s*\([^()]*\)/gi;
const isDarkPrelude = (/** @type {string} */ p) => DARK_SCOPE_RE.test(p.replace(NEGATION_RE, ""));

/**
 * Split CSS into the text OUTSIDE dark-mode-scoped blocks and the bodies INSIDE them
 * (brace-matched, nesting included). Comments are blanked for the scan, so a brace or
 * a `.dark` inside one never scopes a block.
 * @param {string} text
 * @returns {{base:string, dark:string}}
 */
function splitDarkScoped(text) {
  const scan = text.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  let base = "";
  let dark = "";
  let from = 0; // start of the pending `base` slice
  let prelude = 0; // start of the current selector / at-rule prelude
  for (let i = 0; i < scan.length; i++) {
    const ch = scan[i];
    if (ch === "}" || ch === ";") prelude = i + 1;
    else if (ch === "{") {
      if (!isDarkPrelude(scan.slice(prelude, i))) {
        prelude = i + 1;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      for (; j < scan.length && depth; j++) {
        if (scan[j] === "{") depth++;
        else if (scan[j] === "}") depth--;
      }
      base += text.slice(from, prelude);
      dark += `${text.slice(i + 1, depth ? j : j - 1)}\n`;
      from = j;
      prelude = j;
      i = j - 1;
    }
  }
  return { base: base + text.slice(from), dark };
}

/**
 * Every `--name: value` declaration in `text` (last wins), each resolved through the
 * others. `seed` declarations (a theme stylesheet's) are visible too but lose to the
 * text's own. Declarations inside dark-mode-scoped blocks (`.dark {}`,
 * `[data-theme=dark] {}`, `@media (prefers-color-scheme: dark) {}`) never override a
 * default one — the default theme is what the fingerprint measures; a property
 * declared ONLY for dark mode still resolves through its dark value.
 * @param {string} text @param {Map<string,string>|null} [seed]
 * @returns {Map<string,string>}
 */
function cssVarDecls(text, seed = null) {
  /** @type {Map<string,string>} */
  const decls = new Map(seed ?? []);
  const { base, dark } = splitDarkScoped(String(text));
  for (const [, name, value] of base.matchAll(VAR_DECL_RE)) decls.set(name, value.trim());
  /** @type {Map<string,string>} */
  const darkOnly = new Map();
  for (const [, name, value] of dark.matchAll(VAR_DECL_RE))
    if (!decls.has(name)) darkOnly.set(name, value.trim());
  for (const [name, value] of darkOnly) decls.set(name, value);
  // Resolve the declarations themselves first (--a: var(--b)); 4 passes covers the
  // sane nesting depths and bounds a --a↔--b cycle to a fixed cost.
  for (let i = 0; i < 4; i++) {
    let changed = false;
    for (const [name, value] of decls) {
      if (!value.includes("var(")) continue;
      const next = substituteVars(value, decls);
      if (next !== value) {
        decls.set(name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return decls;
}

/**
 * Substitute `var(--name[, fallback])` with the declared custom-property value
 * (fallback when undeclared; left as-is when neither exists — the extractors ignore
 * unresolved `var(` just as before). One level of nesting (a custom property whose
 * value is itself a var()) resolves via a BOUNDED pass count, so declaration cycles
 * terminate instead of recursing: cyclic values simply keep their `var(` text and
 * stay invisible to the extractors.
 * @param {string} text
 * @param {{vars?:Map<string,string>|null}} [opts] `vars`: declarations from outside
 *   the text (the project theme) — a component's `var(--brand)` resolves through them
 *   without the theme's own values counting as the component's features.
 * @returns {string}
 */
export function resolveCssVars(text, opts = {}) {
  const t = String(text);
  return substituteAll(t, cssVarDecls(t, opts.vars));
}

/** Substitute `decls` through the whole text; extra passes let a fallback that is
 *  itself a var() land. */
function substituteAll(/** @type {string} */ t, /** @type {Map<string,string>} */ decls) {
  if (!decls.size && !t.includes("var(")) return t;
  let out = t;
  for (let i = 0; i < 3 && out.includes("var("); i++) {
    const next = substituteVars(out, decls);
    if (next === out) break;
    out = next;
  }
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

const CALC_TOKEN_RE = /\s*(?:(infinity|\d*\.?\d+)(px|rem|em)?|([-+*/()]))/iy;
// Real calc() radii nest a few levels; anything deeper is not a design token.
const MAX_CALC_DEPTH = 32;

/**
 * Evaluate a `calc()` body over px/rem/em lengths and unitless numbers (+ − × ÷,
 * parentheses, `infinity`). Null for anything else (%, vw, min()/max()/clamp()).
 * @param {string} expr
 * @returns {number|null} px
 */
function evalCalc(expr) {
  /** @type {({n:number, len:boolean}|string)[]} */
  const toks = [];
  CALC_TOKEN_RE.lastIndex = 0;
  const src = expr.trim();
  while (CALC_TOKEN_RE.lastIndex < src.length) {
    const m = CALC_TOKEN_RE.exec(src);
    if (!m) return null;
    if (m[3]) toks.push(m[3]);
    else {
      const n = m[1].toLowerCase() === "infinity" ? Number.POSITIVE_INFINITY : +m[1];
      toks.push({ n: m[2] && m[2].toLowerCase() !== "px" ? n * 16 : n, len: !!m[2] });
    }
  }
  let i = 0;
  // Recursive descent: bound the nesting (parens + unary minus) so a pathological
  // value is "not a length" (null) instead of a stack overflow that kills the run.
  let depth = 0;
  /** @returns {{n:number, len:boolean}|null} */
  const atom = () => {
    if (depth >= MAX_CALC_DEPTH) return null;
    depth++;
    const t = toks[i++];
    /** @type {{n:number, len:boolean}|null} */
    let v = null;
    if (t === "(") {
      const inner = sum();
      v = toks[i++] === ")" ? inner : null;
    } else if (t === "-") {
      const inner = atom();
      v = inner && { n: -inner.n, len: inner.len };
    } else if (typeof t === "object") v = t;
    depth--;
    return v;
  };
  const product = () => {
    let a = atom();
    while (a && (toks[i] === "*" || toks[i] === "/")) {
      const op = toks[i++];
      const b = atom();
      if (!b || (a.len && b.len) || (op === "/" && b.len)) return null;
      a = { n: op === "*" ? a.n * b.n : a.n / b.n, len: a.len || b.len };
    }
    return a;
  };
  function sum() {
    let a = product();
    while (a && (toks[i] === "+" || toks[i] === "-")) {
      const op = toks[i++];
      const b = product();
      if (!b || a.len !== b.len) return null;
      a = { n: op === "+" ? a.n + b.n : a.n - b.n, len: a.len };
    }
    return a;
  }
  const v = sum();
  return v && i === toks.length && v.len && !Number.isNaN(v.n) ? v.n : null;
}

/**
 * ONE length in px — a theme token or arbitrary value (`0.625rem`, `13px`,
 * `calc(1rem - 2px)`, `calc(infinity * 1px)`). Null when it isn't exactly one
 * absolute length; ≥999px pills normalize to 9999 like everywhere else.
 * @param {string} value
 * @returns {number|null}
 */
function lengthPx(value) {
  const v = String(value).trim();
  const calc = /^calc\((.*)\)$/is.exec(v);
  let px;
  if (calc) px = evalCalc(calc[1]);
  else if (/^0+(?:\.0+)?$/.test(v)) px = 0;
  else {
    const m = /^(\d*\.?\d+)(px|rem|em)$/i.exec(v);
    px = m ? +m[1] * (m[2].toLowerCase() === "px" ? 1 : 16) : null;
  }
  if (px === null || !(px >= 0)) return null;
  return px >= 999 ? 9999 : Math.round(px * 100) / 100;
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
// Arbitrary spacing: p-[13px], mt-[0.5rem], gap-[9px], px-[13px_7px].
const TW_SPACE_ARB_RE =
  /(?<![\w-])-?(?:[pm][trblxyse]?|gap(?:-[xy])?|space-[xy])-\[([^\]\s]+)\](?![\w-])/g;
// rounded[-side][-key]; side alternatives are ordered two-letter-first so `-tl`
// never half-matches as `-t`+garbage. The key is a default size, a theme key
// (`rounded-card` ← `--radius-card`) or an arbitrary `[13px]`; unknown keys are
// not measurable and are skipped (never mistaken for the bare 4px `rounded`).
const TW_ROUNDED_RE = new RegExp(
  String.raw`(?<![\w-])rounded(?:-(?:ss|se|ee|es|tl|tr|br|bl|t|r|b|l|s|e))?(?:-(${TW_KEY}))?(?![\w-])`,
  "g",
);
const TW_ROUNDED_PX = {
  none: 0,
  xs: 2,
  sm: 2,
  md: 6,
  lg: 8,
  xl: 12,
  "2xl": 16,
  "3xl": 24,
  "4xl": 32,
  full: 9999,
};
const TW_SHADOW_RE = new RegExp(String.raw`(?<![\w-])shadow(?:-(${TW_KEY}))?(?![\w-])`, "g");
const TW_SHADOW_KEYS = new Set(["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "inner"]);

const normShadow = (/** @type {string} */ v) => v.trim().replace(/\s+/g, " ");

/**
 * px radius of one `rounded-*` utility, or null when it isn't measurable.
 * @param {string|undefined} key @param {ThemeTokens|null} theme
 */
function twRadius(key, theme) {
  if (key === undefined) return theme?.radius.get("") ?? 4; // bare `rounded`
  if (key.startsWith("[")) return lengthPx(arbitrary(key));
  if (theme?.radius.has(key)) return theme.radius.get(key) ?? null;
  return Object.hasOwn(TW_ROUNDED_PX, key) ? TW_ROUNDED_PX[key] : null;
}

/**
 * The elevation level one `shadow-*` utility names, or null (none / not a shadow —
 * `shadow-brand`, `shadow-[#123456]` and `shadow-[color:…]` set a shadow COLOR). Theme
 * and arbitrary shadows key on their value, so `shadow-lift` and a CSS `box-shadow`
 * with the same value are ONE level.
 * @param {string|undefined} key @param {ThemeTokens|null} theme
 */
function twShadow(key, theme) {
  if (key === undefined) return theme?.shadow.get("") ?? "tw:base";
  if (key === "none") return null;
  if (key.startsWith("[")) {
    const value = arbitrary(key);
    return value.startsWith("color:") || isColor(value) ? null : normShadow(value);
  }
  if (theme?.shadow.has(key)) return theme.shadow.get(key) ?? null;
  return TW_SHADOW_KEYS.has(key) ? `tw:${key}` : null;
}
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
 * deterministic — the same text (and theme) always yields the same vector (it becomes
 * a content-addressed ledger claim, so this is a protocol requirement, not a nicety).
 * @param {string} text
 * @param {{theme?:ThemeTokens|null}} [opts] `theme`: the project's Tailwind tokens
 *   (loadThemeTokens) — without it, token utilities like `rounded-card`,
 *   `shadow-lift` and `bg-brand` carry no measurable value and are skipped.
 * @returns {Fingerprint}
 */
export function fingerprintText(text, opts = {}) {
  const theme = opts.theme ?? null;
  const t = resolveCssVars(String(text), { vars: theme?.vars });

  const seen = new Set();
  /** @type {Hsl[]} */
  const palette = [];
  for (const c of parseColors(t, theme)) {
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
    ...[...t.matchAll(TW_SPACE_ARB_RE)].flatMap(([, v]) => parseLengths(v.replace(/_/g, " "))),
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
      .map(([, key]) => twRadius(key, theme))
      .filter((r) => typeof r === "number" && r > 0),
  ]);

  const shadows = new Set([
    ...cssValues(t, SHADOW_PROP_RE)
      .map(normShadow)
      .filter((v) => v !== "none"),
    ...[...t.matchAll(TW_SHADOW_RE)].map(([, key]) => twShadow(key, theme)).filter(Boolean),
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
 * @param {{theme?:ThemeTokens|null}} [opts] see fingerprintText
 * @returns {Fingerprint}
 */
export function fingerprintFiles(root, files, opts = {}) {
  const texts = [];
  for (const f of [...files].sort()) {
    try {
      texts.push(readFileSync(isAbsolute(f) ? f : join(root, f), "utf8"));
    } catch {}
  }
  return fingerprintText(texts.join("\n"), opts);
}

/**
 * Does the vector carry ANY measurable design feature? An empty one (a markup-only
 * file, or token utilities with no theme to resolve them) is not evidence of good
 * design — the gate reports it as `insufficient-signal`, never PASS.
 * @param {Fingerprint} fingerprint
 */
export function hasDesignSignal(fingerprint) {
  const fp = asFp(fingerprint);
  return (
    fp.paletteSize > 0 ||
    fp.spacing.length > 0 ||
    fp.fontFamilies.length > 0 ||
    fp.radii.length > 0 ||
    fp.shadowLevels > 0
  );
}

// ---------------------------------------------------------------------------
// Theme tokens — a token-based Tailwind UI (`rounded-card`, `shadow-lift`,
// `bg-brand-fill`) carries its values in the THEME, not in the component. Read
// them statically from Tailwind v4 `@theme { --radius-* --shadow-* --color-* }`
// stylesheets and v3 `tailwind.config.*` objects so the fingerprint sees what the
// utilities actually paint. The config is PARSED, never executed — it is project
// code, and a lint must not run it.
// ---------------------------------------------------------------------------

/**
 * @typedef {{colors:Map<string,Hsl>, radius:Map<string,number>, shadow:Map<string,string>,
 *   vars:Map<string,string>, sources:string[]}} ThemeTokens
 *   Keys are utility suffixes (`brand-fill` for `bg-brand-fill`; "" for a DEFAULT);
 *   `vars` = the theme sources' custom properties, resolved.
 */

/** @returns {ThemeTokens} */
const emptyTheme = () => ({
  colors: new Map(),
  radius: new Map(),
  shadow: new Map(),
  vars: new Map(),
  sources: [],
});

/** @param {ThemeTokens} into @param {ThemeTokens} from */
function mergeTheme(into, from) {
  for (const [k, v] of from.colors) into.colors.set(k, v);
  for (const [k, v] of from.radius) into.radius.set(k, v);
  for (const [k, v] of from.shadow) into.shadow.set(k, v);
  for (const [k, v] of from.vars) into.vars.set(k, v);
  into.sources.push(...from.sources);
  return into;
}

/** File one token value under its namespace; unparseable values are skipped. */
function addToken(theme, ns, key, rawValue) {
  const value = String(rawValue).trim();
  if (ns === "color" || ns === "colors") {
    const c = key ? tryHsl(value) : null;
    if (c) theme.colors.set(key, c);
  } else if (ns === "radius" || ns === "borderRadius") {
    const px = lengthPx(value);
    if (px !== null) theme.radius.set(key, px);
  } else if (value && value !== "none") theme.shadow.set(key, normShadow(value));
}

const THEME_BLOCK_RE = /@theme\b[^{};]*\{/g;
const THEME_DECL_RE = /--(color|radius|shadow)-([\w-]+)\s*:\s*([^;}]+)/g;

/** The bodies of every `@theme [inline|static|…] { … }` block (brace-matched). */
function atThemeBodies(text) {
  const out = [];
  for (const m of text.matchAll(THEME_BLOCK_RE)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    out.push(text.slice(start, depth ? i : i - 1));
  }
  return out;
}

/**
 * Theme tokens from Tailwind v4 CSS: `@theme { --color-brand: …; --radius-card: …;
 * --shadow-lift: … }`, with var() resolved through every custom property in the
 * text (so `--color-fg: var(--hl-fg)` or shadcn's `hsl(var(--border))` land).
 * @param {string} text one or more stylesheets, concatenated
 * @returns {ThemeTokens}
 */
export function themeFromCss(text) {
  const t = String(text);
  const theme = emptyTheme();
  theme.vars = cssVarDecls(t);
  for (const body of atThemeBodies(substituteAll(t, theme.vars)))
    for (const [, ns, key, value] of body.matchAll(THEME_DECL_RE)) addToken(theme, ns, key, value);
  return theme;
}

/**
 * The string-valued leaves of ONE JS object literal starting at `src[open] === "{"`,
 * as [keyPath, value]. Spreads, calls, references and computed keys are skipped —
 * a static read, never an evaluation.
 * @param {string} src @param {number} open
 * @returns {[string[], string][]}
 */
function objectLiteralLeaves(src, open) {
  /** @type {[string[], string][]} */
  const leaves = [];
  let i = open;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("//", i)) {
        const nl = src.indexOf("\n", i);
        i = nl < 0 ? src.length : nl + 1;
      } else if (src.startsWith("/*", i)) {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? src.length : end + 2;
      } else return;
    }
  };
  // A quoted string at src[i]; null for a template literal with ${} (dynamic).
  const str = () => {
    const q = src[i++];
    let out = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
      } else out += src[i++];
    }
    i++;
    return q === "`" && out.includes("${") ? null : out;
  };
  // Skip an unreadable value: up to the next `,` or `}` at depth 0.
  const skip = () => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        str();
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) {
          if (c !== "}") i = src.length; // unbalanced — stop reading
          return;
        }
        depth--;
      } else if (c === "," && depth === 0) return;
      i++;
    }
  };
  const obj = (/** @type {string[]} */ path) => {
    i++; // past "{"
    while (i < src.length) {
      ws();
      if (src[i] === "}") {
        i++;
        return;
      }
      if (src[i] === ",") {
        i++;
        continue;
      }
      let key = null;
      if (src[i] === '"' || src[i] === "'") key = str();
      else {
        const m = /^[\w$]+/.exec(src.slice(i, i + 256));
        if (m) {
          key = m[0];
          i += key.length;
        }
      }
      ws();
      if (key === null || src[i] !== ":") {
        const at = i;
        skip();
        if (i === at && src[i] !== "}" && src[i] !== ",") return;
        continue;
      }
      i++;
      ws();
      const c = src[i];
      // Past MAX_CONFIG_DEPTH a nested object is skipped (iteratively), never recursed
      // into: a pathological config must not overflow the stack.
      if (c === "{") {
        if (path.length < MAX_CONFIG_DEPTH) obj([...path, key]);
        else skip();
      } else if (c === '"' || c === "'" || c === "`") {
        const v = str();
        if (v !== null) leaves.push([[...path, key], v]);
      } else skip();
    }
  };
  obj([]);
  return leaves;
}

const CONFIG_KEY_RE = /\b(colors|borderRadius|boxShadow)\s*:\s*\{/g;
// Color families nest 1–2 levels (`brand: { DEFAULT, 500 }`); 16 is far past any real one.
const MAX_CONFIG_DEPTH = 16;

/**
 * Theme tokens from a Tailwind v3 `tailwind.config.*` (`theme` or `theme.extend`
 * `colors` / `borderRadius` / `boxShadow` objects). Nested color families flatten
 * to utility keys (`brand: { DEFAULT, 500 }` → `brand`, `brand-500`); values may
 * use var() when `vars` (the stylesheets' custom properties) resolve them.
 * @param {string} text @param {{vars?:Map<string,string>|null}} [opts]
 * @returns {ThemeTokens}
 */
export function themeFromTailwindConfig(text, opts = {}) {
  const src = String(text);
  const theme = emptyTheme();
  for (const m of src.matchAll(CONFIG_KEY_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    for (const [path, value] of objectLiteralLeaves(src, open)) {
      const key = path.filter((p) => p !== "DEFAULT").join("-");
      addToken(theme, m[1], key, resolveCssVars(value, { vars: opts.vars }));
    }
  }
  return theme;
}

const THEME_CONFIG_RE = /^tailwind\.config\.[cm]?[jt]s$/;
const THEME_CSS_MARK_RE = /@theme\b|@tailwind\b|@import\s+(?:url\(\s*)?["']tailwindcss/;
const THEME_SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor"]);
const MAX_THEME_CSS_BYTES = 2 * 1024 * 1024;

/** Is this file a Tailwind theme source (a config, or a stylesheet with Tailwind directives)? */
function isThemeSource(path) {
  if (THEME_CONFIG_RE.test(basename(path))) return true;
  if (!path.endsWith(".css")) return false;
  try {
    if (statSync(path).size > MAX_THEME_CSS_BYTES) return false;
    return THEME_CSS_MARK_RE.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Discover the project's Tailwind theme sources under `root`: every
 * `tailwind.config.*` and every stylesheet carrying `@theme` / `@tailwind` /
 * `@import "tailwindcss"`. Bounded walk (depth, entry cap); dot-directories
 * (.git, .next, .claude worktrees …), node_modules and build output are skipped;
 * symlinks are not followed. Sorted, root-relative.
 * @param {string} root @param {{maxDepth?:number, maxEntries?:number}} [opts]
 * @returns {string[]}
 */
export function findThemeSources(root, { maxDepth = 5, maxEntries = 20000 } = {}) {
  /** @type {string[]} */
  const found = [];
  let seen = 0;
  const walk = (/** @type {string} */ dir, /** @type {string} */ rel, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++seen > maxEntries) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith(".") && !THEME_SKIP_DIRS.has(e.name))
          walk(join(dir, e.name), r, depth + 1);
      } else if (e.isFile() && isThemeSource(join(dir, e.name))) found.push(r);
    }
  };
  walk(resolve(root), "", 0);
  return found.sort();
}

/**
 * The theme sources a `uicheck fingerprint|design` run should read: the explicit
 * `--theme` list when given, else the discovered ones — plus any INPUT file that is
 * itself a theme source (gating `globals.css` alongside the components). Root-relative,
 * deduplicated, sorted.
 * @param {string} root @param {string[]} files @param {string[]} [explicit]
 * @returns {string[]}
 */
export function themeSourcesFor(root, files, explicit = []) {
  // Forward slashes on every OS: these are shown to the user and compared in tests.
  const rel = (/** @type {string} */ f) =>
    (relative(resolve(root), resolve(root, f)) || f).split(sep).join("/");
  const base = explicit.length ? explicit : findThemeSources(root);
  const fromInputs = files.filter((f) => isThemeSource(resolve(root, f)));
  return [...new Set([...base, ...fromInputs].map(rel))].sort();
}

/**
 * Read theme tokens from the given sources (root-relative or absolute). Stylesheets
 * are read together (a `@theme` may consume `:root` vars declared in another file);
 * `tailwind.config.*` keys load first so a v4 `@theme` wins on conflict. Unreadable
 * paths are skipped and left out of `sources`.
 * @param {string} root @param {string[]} paths
 * @returns {ThemeTokens}
 */
export function loadThemeTokens(root, paths) {
  const css = [];
  const configs = [];
  const sources = [];
  for (const p of [...new Set(paths)].sort()) {
    let text;
    try {
      text = readFileSync(isAbsolute(p) ? p : join(root, p), "utf8");
    } catch {
      continue;
    }
    sources.push(p);
    (THEME_CONFIG_RE.test(basename(p)) ? configs : css).push(text);
  }
  const fromCss = themeFromCss(css.join("\n"));
  const theme = emptyTheme();
  for (const c of configs) mergeTheme(theme, themeFromTailwindConfig(c, { vars: fromCss.vars }));
  mergeTheme(theme, fromCss);
  theme.sources = sources;
  return theme;
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
  palette: (_fp, near) =>
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
 * An EMPTY vector is neither: nothing was measured, so the verdict is
 * `insufficient-signal` (pass:false) — silence is not evidence of good design.
 * @param {Fingerprint} fingerprint
 * @param {{projectFp?:Fingerprint|null, tauSlop?:number, tauConform?:number}} [opts]
 * @returns {{pass:boolean, verdict:"pass"|"fail"|"insufficient-signal", slop:number,
 *   conform:number|null, violations:{feature:string, detail:string, hint:string}[]}}
 */
export function uiGate(fingerprint, opts = {}) {
  const { projectFp = null, tauSlop, tauConform } = { ...UI_GATE_DEFAULTS, ...opts };
  const fp = asFp(fingerprint);
  if (!hasDesignSignal(fp))
    return {
      pass: false,
      verdict: "insufficient-signal",
      slop: slopDistance(fp),
      conform: null,
      violations: [
        {
          feature: "signal",
          detail:
            "no measurable design feature — no color, spacing, font, radius or shadow was found, so there is nothing to gate",
          hint: "gate the files that carry the UI's styles or classes (markup alone has nothing to measure); Tailwind token utilities (rounded-card, bg-brand) resolve through the project's @theme stylesheet or tailwind.config — name it with --theme <file> if discovery misses it",
        },
      ],
    };
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
  const pass = violations.length === 0;
  return { pass, verdict: pass ? "pass" : "fail", slop, conform, violations };
}

/**
 * The run's overall verdict: the gate's, except a gate PASS with a failing check
 * (scale / taste) is a FAIL. `insufficient-signal` always survives — it is not a
 * PASS no matter what the (vacuous) checks say.
 * @param {{pass:boolean, verdict?:string}} gate @param {{pass:boolean}[]} checks
 * @returns {"pass"|"fail"|"insufficient-signal"}
 */
export function overallVerdict(gate, checks) {
  if (gate.verdict === "insufficient-signal") return "insufficient-signal";
  return gate.pass && checks.every((c) => c.pass) ? "pass" : "fail";
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
// Taste profiles as constraint sets (spec §3) — each prose global/taste/<name>.md
// keeps the *why* and steers generation; its JSON sibling is what the gate CHECKS.
// `chroma` in the JSON is an HSL saturation/100 proxy in [0,1] (documented in each
// profile's "why"); `ratio`/`chroma` bands steer generation but are not yet gated —
// only the checks below are, until P8 fixtures show separation.
// ---------------------------------------------------------------------------

/**
 * @typedef {{name:string, why:string,
 *   palette:{max_hues:number, chroma:[number,number], neutrals:string},
 *   space:{scale:string, ratio:[number,number], base:number[]},
 *   type:{max_families:number},
 *   shape:{radius_levels:[number,number], shadow_levels:[number,number]},
 *   gate:{tau_slop:number, tau_conform:number}}} TasteProfile
 */

/**
 * Load a taste-profile constraint set from global/taste/<name>.json (located
 * relative to the installed module via BRAND.root, same as `forge taste` finds the
 * prose files). Null when the name has no JSON sibling or it doesn't parse.
 * @param {string} name
 * @returns {TasteProfile|null}
 */
export function loadTasteProfile(name) {
  if (!/^[\w-]+$/.test(String(name))) return null; // a name, never a path
  try {
    const p = JSON.parse(readFileSync(join(BRAND.root, "global", "taste", `${name}.json`), "utf8"));
    return p && typeof p === "object" && p.gate ? p : null;
  } catch {
    return null;
  }
}

/**
 * The repo's pinned taste style, read from a `forge taste`-managed DESIGN.md (its
 * header: `<!-- Forge taste: <style> — … forge:sync:<hash> -->`). Null when there is
 * no DESIGN.md, it isn't Forge-managed, or it was written by hand.
 * @param {string} root
 * @returns {string|null}
 */
export function activeTasteStyle(root) {
  try {
    const head = readFileSync(join(root, "DESIGN.md"), "utf8").slice(0, 200);
    const m = head.match(/<!--\s*Forge taste:\s*([\w-]+)\s.*forge:sync:/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic profile-constraint checks — same {id, pass, detail, hint} shape as
 * scaleChecks so the CLI/hooks render them identically. Hue count is OCCUPIED
 * 30°-hue-bins (a warm palette of 8 near-identical h≈30 tints is ONE hue decision,
 * not eight); features the input doesn't exhibit pass vacuously, mirroring
 * sigFeatures' "don't judge what isn't there".
 * @param {Fingerprint} fingerprint @param {TasteProfile} profile
 * @returns {{id:string, pass:boolean, detail:string, hint:string}[]}
 */
export function profileChecks(fingerprint, profile) {
  const fp = asFp(fingerprint);
  const name = profile.name ?? "taste";
  const hues = fp.hueBuckets.filter((n) => n > 0).length;
  const [rLo, rHi] = profile.shape?.radius_levels ?? [0, Infinity];
  const [sLo, sHi] = profile.shape?.shadow_levels ?? [0, Infinity];
  const bases = profile.space?.base ?? [];
  const maxHues = profile.palette?.max_hues ?? Infinity;
  const maxFam = profile.type?.max_families ?? Infinity;
  return [
    {
      id: "taste-palette",
      pass: fp.paletteSize === 0 || hues <= maxHues,
      detail: `${hues} distinct hue bin(s) of ${fp.paletteSize} color(s) (${name} allows ≤ ${maxHues})`,
      hint: hues > maxHues ? `collapse accents to ${maxHues} hue(s) — ${name} palettes commit` : "",
    },
    {
      id: "taste-type",
      pass: fp.fontFamilies.length <= maxFam,
      detail: `${fp.fontFamilies.length} font family(ies) (${name} allows ≤ ${maxFam})`,
      hint:
        fp.fontFamilies.length > maxFam
          ? `drop to ≤${maxFam} families — [${fp.fontFamilies.join(", ")}] is more voices than ${name} speaks in`
          : "",
    },
    {
      id: "taste-radius",
      pass: fp.radiusLevels >= rLo && fp.radiusLevels <= rHi,
      detail: `${fp.radiusLevels} radius level(s) (${name} wants ${rLo}–${rHi})`,
      hint:
        fp.radiusLevels > rHi
          ? `flatten [${fp.radii.join(", ")}] to ≤${rHi} level(s)${rHi === 0 ? " — square corners are the style" : ""}`
          : fp.radiusLevels < rLo
            ? `add rounding — ${name} expects at least ${rLo} radius level(s)`
            : "",
    },
    {
      id: "taste-shadow",
      pass: fp.shadowLevels >= sLo && fp.shadowLevels <= sHi,
      detail: `${fp.shadowLevels} shadow level(s) (${name} wants ${sLo}–${sHi})`,
      hint:
        fp.shadowLevels > sHi
          ? `flatten elevation to ≤${sHi} level(s)`
          : fp.shadowLevels < sLo
            ? `add soft elevation — ${name} expects at least ${sLo} shadow level(s)`
            : "",
    },
    {
      id: "taste-spacing-base",
      pass: !fp.spacing.length || fp.spacingBase === null || bases.includes(fp.spacingBase),
      detail: `inferred spacing base ${fp.spacingBase ?? "(none)"}px (${name} allows [${bases.join(", ")}])`,
      hint:
        fp.spacing.length && fp.spacingBase !== null && !bases.includes(fp.spacingBase)
          ? `re-grid spacing onto a ${bases.join("- or ")}px base`
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
 * so teammates converge on one claim instead of duplicating. An EMPTY vector is
 * refused (nothing is written): stored as "home", it would fail every later `design`
 * run against a design system with no features.
 * @param {string} root @param {string[]} files
 * @param {{t?:number, theme?:ThemeTokens|null}} [opts] `theme`: see fingerprintText —
 *   mint with the same theme `design` gates with, or token utilities won't match.
 * @returns {{ok:true, id:string, existed:boolean, fingerprint:Fingerprint}|{ok:false, reason:string}}
 */
export function mintProjectFingerprint(root, files, { t = 0, theme = null } = {}) {
  const fingerprint = fingerprintFiles(root, files, { theme });
  if (!hasDesignSignal(fingerprint))
    return {
      ok: false,
      reason:
        "insufficient-signal: nothing stored — an empty vector is not a design system; mint from the files that carry the styles, and name the theme with --theme <file> if discovery misses it",
    };
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
