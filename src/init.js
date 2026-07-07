// forge init / catalog — the onboarding surface. init gets a repo to a working
// state in one command; catalog is the "Start Here" index of everything active.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { GITATTRIBUTES_RULE } from "./ledger_store.js";
import { sync } from "./sync.js";
import { list as tasteList } from "./taste.js";

/** Without the union merge driver, two teammates appending to the same ledger log get
 *  a git conflict — the exact thing the ledger's design promises can't happen
 *  (docs/plans/substrate-v2/02-team-memory.md §1). Idempotent append. */
export function ensureLedgerGitattributes(targetRoot = process.cwd()) {
  const path = join(targetRoot, ".gitattributes");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(".forge/ledger/")) return { written: false };
  appendFileSync(
    path,
    `${existing && !existing.endsWith("\n") ? "\n" : ""}${GITATTRIBUTES_RULE}\n`,
  );
  return { written: true };
}

/** Scaffold this repo's cross-tool config (emit every tool) in one step. */
export function init({ targetRoot = process.cwd() } = {}) {
  const r = sync({ targetRoot });
  ensureLedgerGitattributes(targetRoot);
  return r;
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
    cortex:
      "self-correcting project memory — learns from your mistakes on this repo (`forge cortex`)",
    preflight:
      "size the work before spending tokens — assumption-check / model-route / decompose (`forge preflight` · `route` · `scope`)",
  };
}
