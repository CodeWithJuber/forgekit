// forge init / catalog — the onboarding surface. init gets a repo to a working
// state in one command; catalog is the "Start Here" index of everything active.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

// ---------------------------------------------------------------------------
// Settings merge — auto-install Forge hooks + permissions into the user's
// ~/.claude/settings.json without clobbering existing entries.
// ---------------------------------------------------------------------------

const FORGE_SETTINGS_MARKER = "forge-managed";

function loadTemplate() {
  const path = join(BRAND.root, "global", "settings.template.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Deduplicated union of two string arrays. */
function unionStrings(a = [], b = []) {
  const set = new Set(a);
  for (const s of b) set.add(s);
  return [...set];
}

/** Merge Forge hook entries into existing hook arrays, matching by command to avoid duplicates. */
function mergeHooks(existing = {}, template = {}) {
  const merged = { ...existing };
  for (const [event, entries] of Object.entries(template)) {
    const existingEntries = merged[event] || [];
    const existingCommands = new Set(
      existingEntries
        .flatMap((e) => (e.hooks || []).map((h) => h.command))
        .filter(Boolean),
    );
    const newEntries = [];
    for (const entry of entries) {
      const hooks = (entry.hooks || []).filter(
        (h) => !existingCommands.has(h.command),
      );
      if (hooks.length) {
        newEntries.push({ ...entry, hooks });
      }
    }
    merged[event] = [...existingEntries, ...newEntries];
  }
  return merged;
}

/**
 * Merge Forge settings (hooks, permissions, statusline) into the user's
 * ~/.claude/settings.json. Preserves all existing entries. Idempotent.
 * @param {{settingsPath?: string, noSettings?: boolean}} [opts]
 */
export function mergeSettings({ settingsPath, noSettings } = {}) {
  if (noSettings) return { action: "skipped", reason: "--no-settings" };
  const target = settingsPath || join(homedir(), ".claude", "settings.json");
  const template = loadTemplate();
  const existing = readJsonSafe(target) || {};
  const report = { added: [], unchanged: [], path: target };

  // Hooks
  if (template.hooks) {
    const before = JSON.stringify(existing.hooks || {});
    existing.hooks = mergeHooks(existing.hooks, template.hooks);
    if (JSON.stringify(existing.hooks) !== before) report.added.push("hooks");
    else report.unchanged.push("hooks");
  }

  // Permissions
  if (template.permissions) {
    const ep = existing.permissions || {};
    for (const level of ["allow", "ask", "deny"]) {
      if (template.permissions[level]) {
        const before = (ep[level] || []).length;
        ep[level] = unionStrings(ep[level], template.permissions[level]);
        if (ep[level].length > before) report.added.push(`permissions.${level}`);
        else report.unchanged.push(`permissions.${level}`);
      }
    }
    if (!ep.defaultMode) ep.defaultMode = template.permissions.defaultMode || "default";
    existing.permissions = ep;
  }

  // Statusline — set only if not already configured
  if (template.statusLine && !existing.statusLine) {
    existing.statusLine = template.statusLine;
    report.added.push("statusLine");
  } else if (template.statusLine) {
    report.unchanged.push("statusLine");
  }

  // Schema
  if (template.$schema && !existing.$schema) existing.$schema = template.$schema;

  // Mark as forge-managed (metadata, won't affect Claude Code)
  existing._forge = FORGE_SETTINGS_MARKER;

  // Write back
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`);

  return {
    action: report.added.length ? "merged" : "unchanged",
    ...report,
  };
}

/** Scaffold this repo's cross-tool config (emit every tool) in one step. */
export function init({ targetRoot = process.cwd(), noSettings = false } = {}) {
  const r = sync({ targetRoot });
  ensureLedgerGitattributes(targetRoot);
  const settings = mergeSettings({ noSettings });
  return { ...r, settings };
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
