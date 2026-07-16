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
    `:root{color-scheme:dark;${cssVars("dark")};${fonts}}` +
    `@media(prefers-color-scheme:light){:root{color-scheme:light;${cssVars("light")}}}`
  );
}
