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
import { validateProfile, writeForgeConfig } from "./repo_config.js";
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

/** Single-quote a path for safe embedding in a shell command (RA-12): an install
 *  prefix containing spaces (or any shell metacharacter) must not split into words.
 *  Embedded single quotes use the standard `'\''` escape. */
export function shellQuote(path) {
  return `'${String(path).replaceAll("'", `'\\''`)}'`;
}

/** Rewrite the template's `~/.forge/…` hook + statusline commands to the ACTUAL installed
 *  package location. The npm global-install path never creates `~/.forge`, so a literal
 *  `~/.forge/guards/*.sh` reference points at nothing (P0-02). `~/.forge` is the `global/`
 *  dir (that's what install.sh symlinks), so `~/.forge/X` resolves to `<BRAND.root>/global/X` —
 *  single-quoted, so an install path with spaces still runs (RA-12). Trailing args stay
 *  outside the quotes: `bash '<base>/guards/cortex.sh' prompt`. */
function resolveManagedPaths(template) {
  const base = join(BRAND.root, "global");
  const fix = (cmd) =>
    typeof cmd === "string"
      ? cmd.replace(/~\/\.forge\/(\S+)/g, (_, rest) => shellQuote(join(base, rest)))
      : cmd;
  if (template.statusLine?.command) template.statusLine.command = fix(template.statusLine.command);
  for (const entries of Object.values(template.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) h.command = fix(h.command);
    }
  }
  return template;
}

/** Strip shell quoting from a command string so quoted and unquoted spellings of the
 *  same command compare equal: `bash '/x/a.sh' p` ≡ `bash /x/a.sh p`. Undoes the
 *  `'\''` embedded-quote escape first, then drops the remaining quote characters.
 *  Also normalizes the legacy `~/.forge/` prefix to the resolved install base so
 *  entries merged by very old installs still match. */
function normalizeCommand(command) {
  return String(command ?? "")
    .replaceAll("'\\''", "'")
    .replace(/["']/g, "")
    .replaceAll("~/.forge/", `${join(BRAND.root, "global")}/`);
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
 *  Quote-normalized (RA-12), so all of `bash ~/.forge/guards/cortex.sh prompt`,
 *  `bash '/install path/global/guards/cortex.sh' prompt`, and
 *  `"${CLAUDE_PLUGIN_ROOT}"/global/guards/cortex.sh prompt` → `cortex.sh prompt` —
 *  old unquoted installed entries and new quoted template entries must dedupe, or
 *  every existing install would grow duplicate hooks on re-merge. Exported for tests. */
export function guardKey(command) {
  const cmd = normalizeCommand(command);
  const m = cmd.match(/([^/\\]+\.sh)\s*(.*)/);
  return m ? `${m[1]} ${m[2]}`.trim() : cmd;
}

/** Merge Forge hook entries into existing hook arrays, matching by guard identity to avoid
 *  duplicates. An existing entry that is the SAME resolved command as the template's — just
 *  spelled without quotes (a pre-RA-12 install) — is upgraded in place to the quoted form. */
function mergeHooks(existing = {}, template = {}) {
  const merged = { ...existing };
  for (const [event, entries] of Object.entries(template)) {
    const existingEntries = merged[event] || [];
    // guardKey → template command, to heal old unquoted spellings of the same command.
    const templateByKey = new Map();
    for (const entry of entries) {
      for (const h of entry.hooks || []) {
        if (h.command) templateByKey.set(guardKey(h.command), h.command);
      }
    }
    for (const entry of existingEntries) {
      for (const h of entry.hooks || []) {
        if (!h.command) continue;
        const tpl = templateByKey.get(guardKey(h.command));
        if (tpl && tpl !== h.command && normalizeCommand(h.command) === normalizeCommand(tpl)) {
          h.command = tpl; // same command, pre-quoting spelling → upgrade to the quoted form
        }
      }
    }
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

// Policy profiles (P1-02, RA-14) live in repo_config.js — the single config module —
// and are re-exported here so `import { PROFILES } from "./init.js"` keeps working.
export { LEGACY_PROFILES, PROFILES, validateProfile } from "./repo_config.js";

/**
 * Remove every Forge-managed entry that `mergeSettings` added from the user's
 * ~/.claude/settings.json, using the settings template as the authoritative shape
 * (RA-17): hook entries whose guardKey matches a template guard (quote-normalized),
 * permission strings appearing verbatim in the template's allow/ask/deny (removed only
 * from the same list they are in), the statusLine iff its command matches the template's
 * resolved command (quote-normalized), the `$schema` iff it is the template's, and the
 * `_forge` marker. Everything user-owned is preserved unchanged; empty containers left
 * behind are pruned. Timestamped backup + atomic tmp-file+rename write, same as
 * `mergeSettings`. Corrupt file → refuses; missing file → noop.
 * @param {{settingsPath?: string}} [opts]
 * @returns {{action:"removed", path:string, removed:string[], backup:string}
 *   | {action:"noop", path:string, reason:string}
 *   | {action:"error", path:string, reason:string}}
 */
export function removeForgeSettings({ settingsPath } = {}) {
  const target = settingsPath || join(homedir(), ".claude", "settings.json");
  const { status, data } = readExistingSettings(target);
  if (status === "missing") return { action: "noop", path: target, reason: "no settings file" };
  if (status === "corrupt") {
    return {
      action: "error",
      path: target,
      reason:
        "existing settings file is present but not valid JSON — refusing to modify. " +
        "Fix or remove it by hand, then re-run.",
    };
  }
  const template = loadTemplate();
  const settings = data;
  /** @type {string[]} */
  const removed = [];

  // Hooks: drop every hook whose guard identity is one the template installs.
  const templateKeys = new Set();
  for (const entries of Object.values(template.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) if (h.command) templateKeys.add(guardKey(h.command));
    }
  }
  if (settings.hooks && typeof settings.hooks === "object") {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      let changed = false;
      const kept = [];
      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.hooks)) {
          kept.push(entry);
          continue;
        }
        const hooks = entry.hooks.filter(
          (h) => !(typeof h?.command === "string" && templateKeys.has(guardKey(h.command))),
        );
        if (hooks.length !== entry.hooks.length) changed = true;
        if (hooks.length) kept.push({ ...entry, hooks });
      }
      if (changed) {
        removed.push(`hooks.${event}`);
        if (kept.length) settings.hooks[event] = kept;
        else delete settings.hooks[event];
      }
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  // Permissions: remove template strings verbatim, only from the SAME list they sit in.
  if (settings.permissions && template.permissions) {
    for (const level of ["allow", "ask", "deny"]) {
      const tpl = template.permissions[level];
      const cur = settings.permissions[level];
      if (!Array.isArray(tpl) || !Array.isArray(cur)) continue;
      const tplSet = new Set(tpl);
      const kept = cur.filter((s) => !tplSet.has(s));
      if (kept.length !== cur.length) {
        removed.push(`permissions.${level}`);
        if (kept.length) settings.permissions[level] = kept;
        else delete settings.permissions[level];
      }
    }
    // Merge residue only: a permissions object reduced to the template's own defaultMode
    // is what mergeSettings itself left behind — prune it. A user-set custom mode stays.
    if (
      settings.permissions &&
      Object.keys(settings.permissions).length === 1 &&
      settings.permissions.defaultMode === (template.permissions.defaultMode || "default")
    ) {
      delete settings.permissions;
    } else if (settings.permissions && Object.keys(settings.permissions).length === 0) {
      delete settings.permissions;
    }
  }

  // Statusline: only if it IS the template's (quote-normalized) — a user's own stays.
  if (
    settings.statusLine?.command &&
    template.statusLine?.command &&
    normalizeCommand(settings.statusLine.command) === normalizeCommand(template.statusLine.command)
  ) {
    delete settings.statusLine;
    removed.push("statusLine");
  }

  // Schema: mergeSettings sets it only when absent — remove only the template's own value.
  if (settings.$schema && settings.$schema === template.$schema) delete settings.$schema;

  if ("_forge" in settings) {
    delete settings._forge;
    removed.push("_forge");
  }

  if (!removed.length)
    return {
      action: "noop",
      path: target,
      reason: "no forge-managed entries found",
    };

  const backup = `${target}.forge-bak-${stamp()}`;
  copyFileSync(target, backup);
  const tmp = `${target}.forge-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, target);
  return { action: "removed", path: target, removed, backup };
}

/** Persist a chosen profile to `.forge/forge.config.json` so `sync` applies it. Merges into
 *  any existing config rather than clobbering it (unknown keys round-trip); a corrupt
 *  config file makes the write refuse loudly instead of discarding the bytes (RA-15).
 *  Legacy profile names are accepted, stored as their mapped profile, and surfaced via
 *  `deprecated` so the CLI can warn (RA-14). Returns the resolved profile or null. */
function writeProfile(targetRoot, profile) {
  if (!profile) return null;
  const v = validateProfile(profile);
  // `=== false` (not `!v.ok`): tsc only narrows the discriminated union this way here.
  if (v.ok === false) return { error: v.error };
  const res = writeForgeConfig(targetRoot, (cfg) => {
    cfg.profile = v.profile;
    return cfg;
  });
  if (res.ok === false) return { error: res.reason };
  return v.deprecated ? { profile: v.profile, deprecated: v.deprecated } : { profile: v.profile };
}

/**
 * Scaffold this repo's cross-tool config (emit every tool) in one step.
 *
 * `settingsOnly` runs the idempotent, marker-guarded `mergeSettings` ONLY — no repo
 * emit, no AGENTS.md, no gitattributes. That is the surface `install.sh` calls to wire
 * hooks + permissions into ~/.claude/settings.json without ever touching the user's repo.
 * @param {{targetRoot?: string, noSettings?: boolean, profile?: string, settingsOnly?: boolean, settingsPath?: string}} [opts]
 */
export function init({
  targetRoot = process.cwd(),
  noSettings = false,
  profile,
  settingsOnly = false,
  settingsPath,
} = {}) {
  if (settingsOnly) {
    return {
      settings: mergeSettings({ noSettings, settingsPath }),
      settingsOnly: true,
    };
  }
  // RA-13: an invalid profile aborts BEFORE any filesystem/settings side effect —
  // no AGENTS.md, no .forge/, no .gitattributes append, no settings merge.
  const valid = validateProfile(profile);
  // `=== false` (not `!valid.ok`): tsc only narrows the discriminated union this way here.
  if (valid.ok === false) return { profile: { error: valid.error }, aborted: true };
  const profileResult = writeProfile(targetRoot, profile);
  const r = sync({ targetRoot });
  ensureLedgerGitattributes(targetRoot);
  const settings = mergeSettings({ noSettings, settingsPath });
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
