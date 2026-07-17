// forge init / catalog — the onboarding surface. init gets a repo to a working
// state in one command; catalog is the "Start Here" index of everything active.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BRAND } from "./brand.js";
import { GITATTRIBUTES_RULE } from "./ledger_store.js";
import { autoDetectProvider } from "./providers.js";
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

/** Rewrite the template's `~/.forge/…` hook + statusline commands to the ACTUAL installed
 *  package location. The npm global-install path never creates `~/.forge`, so a literal
 *  `~/.forge/guards/*.sh` reference points at nothing (P0-02). `~/.forge` is the `global/`
 *  dir (that's what install.sh symlinks), so `~/.forge/X` resolves to `<BRAND.root>/global/X`. */
function resolveManagedPaths(template) {
  const base = join(BRAND.root, "global");
  const fix = (cmd) => (typeof cmd === "string" ? cmd.replaceAll("~/.forge/", `${base}/`) : cmd);
  if (template.statusLine?.command) template.statusLine.command = fix(template.statusLine.command);
  for (const entries of Object.values(template.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) h.command = fix(h.command);
    }
  }
  return template;
}

function loadTemplate() {
  const path = join(BRAND.root, "global", "settings.template.json");
  return resolveManagedPaths(JSON.parse(readFileSync(path, "utf8")));
}

/** Read an existing settings file, distinguishing a MISSING file (safe to treat as empty
 *  and create) from one that is PRESENT BUT UNPARSEABLE (must never be silently replaced —
 *  P0-01). Returns `{status, data}` with status `missing` | `ok` | `corrupt`. */
function readExistingSettings(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { status: "missing", data: {} };
  }
  try {
    return { status: "ok", data: JSON.parse(raw) };
  } catch {
    return { status: "corrupt", data: null };
  }
}

/** Filesystem-safe timestamp for backup filenames. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Deduplicated union of two string arrays. */
function unionStrings(a = [], b = []) {
  const set = new Set(a);
  for (const s of b) set.add(s);
  return [...set];
}

/** Extract guard identity (basename + trailing args) from a hook command for dedup.
 *  `bash ~/.forge/guards/cortex.sh prompt` and
 *  `"${CLAUDE_PLUGIN_ROOT}"/global/guards/cortex.sh prompt` both → `cortex.sh prompt`. */
function guardKey(command) {
  const m = command.match(/([^/\\"]+\.sh)\s*(.*)/);
  return m ? `${m[1]} ${m[2]}`.trim() : command;
}

/** Merge Forge hook entries into existing hook arrays, matching by guard identity to avoid duplicates. */
function mergeHooks(existing = {}, template = {}) {
  const merged = { ...existing };
  for (const [event, entries] of Object.entries(template)) {
    const existingEntries = merged[event] || [];
    const existingKeys = new Set(
      existingEntries
        .flatMap((e) => (e.hooks || []).map((h) => h.command))
        .filter(Boolean)
        .map(guardKey),
    );
    const newEntries = [];
    for (const entry of entries) {
      const hooks = (entry.hooks || []).filter((h) => !existingKeys.has(guardKey(h.command)));
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
  const { status, data } = readExistingSettings(target);
  // Present-but-unparseable: refuse rather than overwrite the user's real (if broken) file.
  if (status === "corrupt") {
    return {
      action: "error",
      path: target,
      reason:
        "existing settings file is present but not valid JSON — refusing to overwrite. " +
        "Fix or remove it, or re-run with --no-settings.",
    };
  }
  const existing = data;
  const before = JSON.stringify(existing);
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

  // Nothing to do — don't rewrite (or back up) an already-current file.
  if (status !== "missing" && JSON.stringify(existing) === before) {
    return {
      action: "unchanged",
      path: target,
      added: [],
      unchanged: report.unchanged,
    };
  }

  // Back up any existing file, then write atomically (temp + rename) so a crash mid-write
  // can never leave a truncated settings.json (P0-01).
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  let backup = null;
  if (status === "ok" && existsSync(target)) {
    backup = `${target}.forge-bak-${stamp()}`;
    copyFileSync(target, backup);
  }
  const tmp = `${target}.forge-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`);
  renameSync(tmp, target);

  return {
    action: report.added.length ? "merged" : "created",
    backup,
    ...report,
  };
}

/** Valid policy profiles (P1-02). `standard` is the full engineering pack (default). */
export const PROFILES = [
  "minimal",
  "standard",
  "web-app",
  "backend-service",
  "library",
  "regulated",
];

/** Persist a chosen profile to `.forge/forge.config.json` so `sync` applies it. Merges into
 *  any existing config rather than clobbering it. Returns the resolved profile or null. */
function writeProfile(targetRoot, profile) {
  if (!profile) return null;
  if (!PROFILES.includes(profile)) return { error: `unknown profile: ${profile}` };
  const dir = join(targetRoot, ".forge");
  const path = join(dir, "forge.config.json");
  /** @type {Record<string, any>} */
  let cfg = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8")) || {};
    } catch {
      cfg = {};
    }
  }
  cfg.profile = profile;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { profile };
}

/**
 * Scaffold this repo's cross-tool config (emit every tool) in one step.
 * @param {{targetRoot?: string, noSettings?: boolean, profile?: string}} [opts]
 */
export function init({ targetRoot = process.cwd(), noSettings = false, profile } = {}) {
  const profileResult = writeProfile(targetRoot, profile);
  const r = sync({ targetRoot });
  ensureLedgerGitattributes(targetRoot);
  const settings = mergeSettings({ noSettings });
  const detected = autoDetectProvider();
  return { ...r, settings, detected, profile: profileResult };
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
