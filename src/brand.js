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
