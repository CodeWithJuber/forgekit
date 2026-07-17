// forge fmt — zero-dependency CLI formatting. One capability decision
// (FORCE_COLOR > NO_COLOR > TERM=dumb > isTTY), brand-token painting (truecolor
// from brand.json when the terminal declares 24-bit, portable 16-color SGR
// otherwise — the statusline.sh degradation pattern), aligned tables, and a
// confidence meter. Everything degrades to the exact plain text commands print
// today: with color off, `paint` is the identity and `table`/`bar` are pure ASCII…
// so piped output, tests, and dumb terminals never see an escape byte.
import { BRAND } from "./brand.js";
import { clamp01 } from "./util.js";

// Contract note: the default-argument reads below are process.env.FORCE_COLOR,
// process.env.NO_COLOR, process.env.TERM and process.env.COLORTERM — named
// literally here so docs_check.envVarsRead collects them into the documented
// env contract even though the code takes them via the injectable `env` param.

/**
 * Should output to `stream` be colored? Precedence (the no-color.org / Node
 * convention): FORCE_COLOR set wins both ways (`"0"` forces off, anything else
 * forces on — even when piped, e.g. CI) > NO_COLOR set (non-empty) forces off >
 * TERM=dumb forces off > otherwise color iff the stream is a TTY.
 * @param {{isTTY?: boolean}} [stream]
 * @param {Record<string, string|undefined>} [env]
 */
export function supportsColor(stream = process.stdout, env = process.env) {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY);
}

/** Does the terminal declare 24-bit color (COLORTERM=truecolor|24bit)? */
export function supportsTruecolor(env = process.env) {
  const ct = env.COLORTERM || "";
  return ct.includes("truecolor") || ct.includes("24bit");
}

const RESET = "\x1b[0m";

/** `#rrggbb` → the SGR foreground parameter `38;2;r;g;b`, or null if unparsable. */
function hexSgr(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return `38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`;
}

// Semantic roles → brand.json dark-palette tokens (the terminal is a dark
// surface) + a portable 16-color/SGR fallback. `err` has no brand token yet —
// the warm red matches statusline.sh's diff-removed red, distinct from ember.
const DARK = BRAND.colors?.dark ?? {};
const ROLES = {
  ok: { hex: DARK.ok, basic: "32" }, // green — pass / confirm / trusted
  warn: { hex: DARK["brand-2"], basic: "33" }, // soft ember — caution / uncertain
  err: { hex: "#e0605a", basic: "31" }, // warm red — fail / contradict
  accent: { hex: DARK.brand, basic: "36" }, // ember — the answer / the pick
  dim: { hex: DARK.muted, basic: "2" }, // warm taupe — chrome, footnotes
};

/** @typedef {keyof typeof ROLES} Role */

/**
 * Wrap `text` in the role's color when color is on; identity otherwise (and for
 * unknown roles — a bad role name must never corrupt output).
 * @param {unknown} text
 * @param {Role} role
 * @param {{enabled?: boolean, truecolor?: boolean}} [opts] injectable for tests
 */
export function paint(text, role, opts = {}) {
  const enabled = opts.enabled ?? supportsColor();
  const r = ROLES[role];
  if (!enabled || !r) return String(text);
  const truecolor = opts.truecolor ?? supportsTruecolor();
  const code = (truecolor ? hexSgr(r.hex) : null) ?? r.basic;
  return `\x1b[${code}m${text}${RESET}`;
}

/**
 * A title line: bold + accent when color is on, the plain text otherwise.
 * @param {unknown} text
 * @param {{enabled?: boolean, truecolor?: boolean}} [opts]
 */
export function heading(text, opts = {}) {
  const enabled = opts.enabled ?? supportsColor();
  if (!enabled) return String(text);
  return `\x1b[1m${paint(text, "accent", { ...opts, enabled })}\x1b[22m`;
}

/**
 * Confidence meter over [0,1]: `bar(0.7)` → `███████░░░`. Clamped (NaN → 0),
 * pure ASCII-art blocks — readable with color off, paintable by the caller.
 * @param {number} v01
 * @param {number} [width]
 */
export function bar(v01, width = 10) {
  const w = Math.max(1, Math.floor(width));
  const filled = Math.round(clamp01(Number(v01) || 0) * w);
  return "█".repeat(filled) + "░".repeat(w - filled);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR escapes is the point
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a cell — SGR escapes take no columns. */
function visibleWidth(s) {
  return String(s).replace(ANSI_RE, "").length;
}

/**
 * Align rows of cells into columns (two-space gutter). Widths are computed on
 * VISIBLE characters, so painted cells align with plain ones. The last column
 * is never padded (no trailing whitespace).
 * @param {unknown[][]} rows
 * @param {{indent?: string}} [opts]
 * @returns {string} the rendered block ("" for no rows)
 */
export function table(rows, opts = {}) {
  const indent = opts.indent ?? "  ";
  if (!rows?.length) return "";
  const widths = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
    });
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) =>
            i === row.length - 1
              ? String(cell)
              : String(cell) + " ".repeat(widths[i] - visibleWidth(cell)),
          )
          .join("  "),
    )
    .join("\n");
}
