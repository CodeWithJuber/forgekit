// forge init / catalog — the onboarding surface. init gets a repo to a working
// state in one command; catalog is the "Start Here" index of everything active.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { sync } from "./sync.js";
import { list as tasteList } from "./taste.js";

/** Scaffold this repo's cross-tool config (emit every tool) in one step. */
export function init({ targetRoot = process.cwd() } = {}) {
  return sync({ targetRoot });
}

function skillDescription(dir) {
  try {
    const match = readFileSync(join(dir, "SKILL.md"), "utf8").match(/description:\s*(.*)/);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

/** Everything Forge makes available, grouped by layer, for the Start-Here list. */
export function catalog() {
  const g = join(BRAND.root, "global");
  const dir = (p) => (existsSync(p) ? readdirSync(p) : []);
  return {
    tools: dir(join(g, "tools"))
      .filter((name) => existsSync(join(g, "tools", name, "SKILL.md")))
      .map((name) => ({ name, why: skillDescription(join(g, "tools", name)) })),
    crew: dir(join(g, "crew"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, "")),
    guards: dir(join(g, "guards"))
      .filter((f) => f.endsWith(".sh") && !f.startsWith("_"))
      .map((f) => f.replace(/\.sh$/, "")),
    taste: tasteList(),
  };
}
