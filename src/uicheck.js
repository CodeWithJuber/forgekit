// forge uicheck — the ASSERTABLE half of UI review. AI UI-audits hallucinate on subjective
// calls (hierarchy, taste); this computes the things that are pure math or a DOM fact, so a
// verifier can state them without guessing. WCAG contrast is exact arithmetic — no LLM, no
// false positives. The subjective calls stay ADVISORY (see the frontend-verifier calibration).

// ---------------------------------------------------------------------------
// Color parsing — every CSS syntax a stylesheet (or Tailwind v4's oklch default
// palette) actually uses, normalized to sRGB {r,g,b} in 0..255 plus alpha a in 0..1.
// ---------------------------------------------------------------------------

/** @typedef {{r:number, g:number, b:number, a:number}} Rgba */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** A bare CSS number (`none` is 0, per CSS Color 4); NaN when it isn't one. */
function cssNumber(tok) {
  if (tok === "none") return 0;
  return NUM_RE.test(tok) ? Number(tok) : Number.NaN;
}

/** `<number>` or `<percentage>`: a percentage maps onto `pctScale` (100% → pctScale). */
function numOrPct(tok, pctScale) {
  return tok.endsWith("%") ? (cssNumber(tok.slice(0, -1)) / 100) * pctScale : cssNumber(tok);
}

/** A CSS `<hue>` in degrees (unitless = degrees; deg/grad/rad/turn accepted). */
function cssHue(tok) {
  const m = /^(.*?)(deg|grad|rad|turn)?$/i.exec(tok);
  const n = cssNumber(m?.[1] ?? "");
  const unit = (m?.[2] ?? "deg").toLowerCase();
  const deg =
    unit === "turn"
      ? n * 360
      : unit === "rad"
        ? (n * 180) / Math.PI
        : unit === "grad"
          ? n * 0.9
          : n;
  return ((deg % 360) + 360) % 360;
}

/** Alpha as `<number>` or `<percentage>`, clamped to 0..1 (absent → opaque). */
function cssAlpha(tok) {
  return tok === undefined ? 1 : clamp(numOrPct(tok, 1), 0, 1);
}

/**
 * The arguments of a color function, in either syntax: legacy commas
 * (`rgba(0, 0, 0, .5)`) or modern space-separated with a `/ alpha` tail
 * (`rgb(0 0 0 / 50%)`). Null when the shape is wrong.
 * @param {string} inner
 * @returns {{parts:string[], alpha:string|undefined}|null}
 */
function colorArgs(inner) {
  let body = inner.trim();
  let alpha;
  const slash = body.split("/");
  if (slash.length > 2) return null;
  if (slash.length === 2) {
    body = slash[0].trim();
    alpha = slash[1].trim();
  }
  const parts = body.includes(",") ? body.split(",").map((p) => p.trim()) : body.split(/\s+/);
  if (body.includes(",") && parts.length === 4 && alpha === undefined) alpha = parts.pop();
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  if (alpha !== undefined && (!alpha || /\s/.test(alpha))) return null;
  return { parts, alpha };
}

/** HSL (h degrees, s/l 0..1) → sRGB 0..255 (CSS Color 4 algorithm). */
function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return { r: f(0), g: f(8), b: f(4) };
}

/** OKLab → sRGB 0..255 (Ottosson's matrices; out-of-gamut channels are clipped). */
function oklabToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const [r, g, bl] = lin.map((c) => {
    const x = clamp(c, 0, 1);
    return (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255;
  });
  return { r, g, b: bl };
}

const NAMED = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/**
 * Parse one CSS color: #rgb / #rgba / #rrggbb / #rrggbbaa (the `#` optional — an
 * unquoted `#777` is a shell comment), rgb()/rgba(), hsl()/hsla(), oklch(), oklab(),
 * and black/white/transparent. Legacy comma and modern `/ alpha` syntaxes both work.
 * Throws on anything else — a contrast verdict must never rest on a guessed color.
 * @param {string} input
 * @returns {Rgba} channels in 0..255 (floats, not rounded), alpha in 0..1
 */
export function parseColor(input) {
  const raw = String(input).trim();
  const s = raw.toLowerCase();
  const bad = () =>
    new Error(`bad color: ${input} (expected #hex, rgb(), hsl(), oklch() or oklab())`);
  if (Object.hasOwn(NAMED, s)) return { ...NAMED[s] };
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const byte = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?|oklch|oklab)\(([^()]*)\)$/.exec(s);
  if (!fn) throw bad();
  const args = colorArgs(fn[2]);
  if (!args) throw bad();
  const [p0, p1, p2] = args.parts;
  const a = cssAlpha(args.alpha);
  let rgb;
  if (fn[1].startsWith("rgb")) {
    rgb = { r: numOrPct(p0, 255), g: numOrPct(p1, 255), b: numOrPct(p2, 255) };
    for (const k of ["r", "g", "b"]) rgb[k] = clamp(rgb[k], 0, 255);
  } else if (fn[1].startsWith("hsl")) {
    // Modern hsl() accepts bare numbers for s/l; they mean percentages.
    const sat = clamp(numOrPct(p1, 100), 0, 100) / 100;
    const light = clamp(numOrPct(p2, 100), 0, 100) / 100;
    rgb = hslToRgb(cssHue(p0), sat, light);
  } else if (fn[1] === "oklch") {
    const L = numOrPct(p0, 1);
    const C = Math.max(0, numOrPct(p1, 0.4)); // 100% chroma = 0.4
    const H = (cssHue(p2) * Math.PI) / 180;
    rgb = oklabToRgb(L, C * Math.cos(H), C * Math.sin(H));
  } else {
    rgb = oklabToRgb(numOrPct(p0, 1), numOrPct(p1, 0.4), numOrPct(p2, 0.4)); // 100% a/b = 0.4
  }
  if ([rgb.r, rgb.g, rgb.b, a].some((x) => !Number.isFinite(x))) throw bad();
  return { r: rgb.r, g: rgb.g, b: rgb.b, a };
}

/**
 * Source-over compositing of `top` onto an opaque `bottom` (in sRGB space, which is
 * how browsers blend by default). A translucent text color is only as legible as the
 * color it actually PAINTS, so contrast is measured on the composite.
 * @param {Rgba} top @param {Rgba} bottom
 * @returns {Rgba} opaque
 */
export function compositeOver(top, bottom) {
  const mix = (t, b) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

const WHITE = { r: 255, g: 255, b: 255, a: 1 };

/** An opaque color: a translucent one is composited over white (the default canvas). */
const opaque = (/** @type {Rgba} */ c) => (c.a < 1 ? compositeOver(c, WHITE) : c);

const asRgba = (c) => (typeof c === "string" ? parseColor(c) : c);

/** `#rrggbb` of an sRGB color (channels rounded, alpha dropped). */
export function toHex(color) {
  const c = asRgba(color);
  return `#${[c.r, c.g, c.b]
    .map((x) =>
      Math.round(clamp(x, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

// WCAG 2.1 sRGB → linear.
const linear = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/**
 * WCAG relative luminance of a color (any syntax parseColor takes, or an Rgba). A
 * translucent color is composited over white first.
 * @param {string|Rgba} color
 */
export function relativeLuminance(color) {
  const { r, g, b } = opaque(asRgba(color));
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Round channels to the 8-bit values a display actually paints. */
const quantize = (/** @type {Rgba} */ c) => ({
  r: Math.round(clamp(c.r, 0, 255)),
  g: Math.round(clamp(c.g, 0, 255)),
  b: Math.round(clamp(c.b, 0, 255)),
  a: c.a,
});

/**
 * WCAG contrast ratio between two colors (1..21). A translucent background is
 * composited over white; a translucent foreground over that background. Both are
 * measured as the 8-bit colors that get painted, so the ratio always matches the
 * `#rrggbb` a report shows for them.
 * @param {string|Rgba} fg @param {string|Rgba} bg
 */
export function contrastRatio(fg, bg) {
  const back = quantize(opaque(asRgba(bg)));
  const front = quantize(compositeOver(asRgba(fg), back));
  const l1 = relativeLuminance(front);
  const l2 = relativeLuminance(back);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Grade a contrast ratio. Normal text needs 4.5 (AA) / 7 (AAA); large text or UI components
 * need 3 (AA) / 4.5 (AAA).
 */
export function wcagLevel(ratio, { large = false } = {}) {
  const aa = large ? 3 : 4.5;
  const aaa = large ? 4.5 : 7;
  return {
    ratio: Math.round(ratio * 100) / 100,
    passesAA: ratio >= aa,
    passesAAA: ratio >= aaa,
    level: ratio >= aaa ? "AAA" : ratio >= aa ? "AA" : "fail",
  };
}

/**
 * The whole contrast verdict for one pair — what `uicheck contrast` prints (and emits
 * under --json). `fgHex`/`bgHex` are the colors actually compared: the background made
 * opaque (over white), the foreground composited onto it; `notes` says when either
 * step changed a color, so a translucent input never passes silently.
 * @param {string} fg @param {string} bg @param {{large?:boolean}} [opts]
 * @returns {{fg:string, bg:string, fgHex:string, bgHex:string, ratio:number,
 *   level:string, passesAA:boolean, passesAAA:boolean, large:boolean,
 *   required:{aa:number, aaa:number}, notes:string[]}}
 */
export function contrastReport(fg, bg, { large = false } = {}) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  // Quantized exactly as contrastRatio does, so the ratio, the hexes and
  // contrastRatio(fg, bg) always agree (even when BOTH colors are translucent).
  const back = quantize(opaque(b));
  const front = quantize(compositeOver(f, back));
  const notes = [];
  if (b.a < 1)
    notes.push(
      `background ${bg} has alpha ${Math.round(b.a * 1000) / 1000} — composited over white to ${toHex(back)}; pass an opaque background for an exact ratio`,
    );
  if (f.a < 1)
    notes.push(
      `foreground ${fg} has alpha ${Math.round(f.a * 1000) / 1000} — composited over the background to ${toHex(front)}`,
    );
  return {
    fg,
    bg,
    fgHex: toHex(front),
    bgHex: toHex(back),
    ...wcagLevel(contrastRatio(front, back), { large }),
    large,
    required: large ? { aa: 3, aaa: 4.5 } : { aa: 4.5, aaa: 7 },
    notes,
  };
}

// The deterministic checks a verifier may ASSERT (vs. the advisory, subjective ones). Kept as
// data so the frontend-verifier and docs share one source of truth.
export const ASSERTABLE_CHECKS = [
  { id: "contrast", how: "compute WCAG ratio; body ≥4.5:1, large/UI ≥3:1" },
  {
    id: "focus-visible",
    how: "every interactive element has a visible :focus-visible style",
  },
  { id: "alt-text", how: "every <img> has a non-empty alt attribute" },
  {
    id: "form-labels",
    how: "every input/select/textarea has a <label> or aria-label",
  },
  { id: "tap-target", how: "clickable targets ≥24×24px (AA) / ≥44×44px (AAA)" },
  {
    id: "reduced-motion",
    how: "animations ≥200ms are wrapped in @media (prefers-reduced-motion)",
  },
  // Scale-conformance checks (P6): executable versions live in uifingerprint.js
  // scaleChecks() under the SAME ids — a test pins the two lists together.
  {
    id: "spacing-scale",
    how: "≥90% of spacing values are multiples of the declared base within ε=0.5px",
  },
  {
    id: "radius-levels",
    how: "≤3 distinct border-radius levels (a design system uses few, deliberately)",
  },
  { id: "shadow-levels", how: "≤3 distinct box-shadow levels (deliberate elevation steps)" },
  { id: "palette-size", how: "≤8 distinct colors after HSL normalization" },
];

export const ADVISORY_ONLY = [
  "visual hierarchy / type-scale balance",
  "which pattern fits (chatbot vs copilot vs canvas)",
  "error-message clarity",
  "empty-state usefulness",
  "does the motion feel right",
  "palette / taste",
];
