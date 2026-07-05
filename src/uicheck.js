// forge uicheck — the ASSERTABLE half of UI review. AI UI-audits hallucinate on subjective
// calls (hierarchy, taste); this computes the things that are pure math or a DOM fact, so a
// verifier can state them without guessing. WCAG contrast is exact arithmetic — no LLM, no
// false positives. The subjective calls stay ADVISORY (see the frontend-verifier calibration).

/** Parse #rgb / #rrggbb → {r,g,b} in 0..255. */
function parseHex(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad hex color: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// WCAG 2.1 sRGB → linear.
const linear = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a color. */
export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
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
];

export const ADVISORY_ONLY = [
  "visual hierarchy / type-scale balance",
  "which pattern fits (chatbot vs copilot vs canvas)",
  "error-message clarity",
  "empty-state usefulness",
  "does the motion feel right",
  "palette / taste",
];
