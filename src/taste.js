// forge taste — a MENU of visual directions. Each repo pins exactly ONE
// (consistency) chosen from the menu (optionality) by writing a managed DESIGN.md.
// The shared rules already tell every tool to "follow DESIGN.md", so one choice
// steers Claude, Cursor, Codex, Gemini, and the rest.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import {
  hashContent,
  isManaged,
  markerString,
  readIfExists,
  writeIfChanged,
} from "./emit/_shared.js";

const stylesDir = () => join(BRAND.root, "global", "taste");

export function list() {
  const dir = stylesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

export function spec(style) {
  const p = join(stylesDir(), `${style}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function apply(style, targetRoot = process.cwd()) {
  const body = spec(style);
  if (!body)
    return {
      ok: false,
      reason: `unknown style "${style}" — run \`forge taste\` to list them`,
    };
  const dest = join(targetRoot, "DESIGN.md");
  const existing = readIfExists(dest);
  if (existing !== null && !isManaged(existing)) {
    return {
      ok: false,
      reason:
        "DESIGN.md exists and isn't Forge-managed — edit it yourself, or delete it to let forge taste manage it",
    };
  }
  const hash = hashContent(body);
  const header = `<!-- Forge taste: ${style} — regenerate with \`forge taste ${style}\`. ${markerString(hash)} -->`;
  return {
    ok: true,
    style,
    action: writeIfChanged(dest, `${header}\n${body}`),
  };
}
