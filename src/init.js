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
  // ME-21: only a REAL, active attribute line counts as "already present" — not a comment
  // or prose that merely mentions the path. A substring check would let a comment mentioning
  // `.forge/ledger/` suppress the actual rule forever. Parse the effective rule (the sole
  // non-comment line of GITATTRIBUTES_RULE) into <pattern> + <attrs>, then look for a
  // non-comment line that binds the SAME pattern to (at least) the same attribute.
  const ruleLine = GITATTRIBUTES_RULE.split("\n").find(
    (l) => l.trim() && !l.trim().startsWith("#"),
  );
  const [pattern, ...attrs] = ruleLine.trim().split(/\s+/);
  const active = existing.split("\n").some((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return false;
    const [pat, ...rest] = t.split(/\s+/);
    return pat === pattern && attrs.every((a) => rest.includes(a));
  });
  if (active) return { written: false };
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
// Sibling of the `_forge` marker: the ownership manifest (HI-05). It records the EXACT
// entries this (and any earlier) install ADDED — permission strings genuinely absent
// before, hook guard-identities Forge inserted, and whether Forge set the statusLine /
// $schema — so uninstall reverses only Forge's own additions and never a user-owned entry
// that happened to match the template. Absent on pre-HI-05 installs → template-match fallback.
const FORGE_OWNED_KEY = "_forgeOwned";

// The installed-assets root every Forge hook/statusline command resolves under. Used to
// tell a Forge-owned command (some spelling of a path under here, or the plugin root) apart
// from a user's OWN hook that merely shares a basename+args — those must never collide for
// ownership/removal purposes (HI-05).
const FORGE_GLOBAL = join(BRAND.root, "global");

/** True iff `hook` is a Forge-managed hook/statusline entry — i.e. it resolves to a path
 *  under the installed assets root (`~/.forge/…`, the resolved `<root>/global/…`, quoted or
 *  not) or the plugin root (`${CLAUDE_PLUGIN_ROOT}/global/…`). Works on BOTH forms: a legacy
 *  shell-string `command`, and an exec-form entry whose path lives in `args[]`. A user's
 *  same-basename hook at a different absolute path is NOT Forge-owned, so it is never blocked
 *  on merge or removed on uninstall. Path-aware on purpose: `guardKey` (basename+args) is for
 *  dedup only. */
function isForgeCommand(hook) {
  const c = canonicalCommand(hook);
  return c.includes(`${FORGE_GLOBAL}/`) || c.includes("${CLAUDE_PLUGIN_ROOT}/global/");
}

/** Single-quote a path for safe embedding in a shell command: an install prefix containing
 *  spaces (or any shell metacharacter) must not split into words. Embedded single quotes use
 *  the standard `'\''` escape. ME-23 moved hooks to exec form (`command`+`args`, spawned with
 *  NO shell), which removes the need to quote the guard path at all — this helper survives only
 *  for the defensive legacy shell-string path in `resolveManagedPaths` and for tests that model
 *  a pre-ME-23 install. */
export function shellQuote(path) {
  return `'${String(path).replaceAll("'", `'\\''`)}'`;
}

/** Rewrite the template's `~/.forge/…` hook + statusline entries to the ACTUAL installed
 *  package location. The npm global-install path never creates `~/.forge`, so a literal
 *  `~/.forge/guards/*.sh` reference points at nothing (P0-02). `~/.forge` is the `global/`
 *  dir (that's what install.sh symlinks), so `~/.forge/X` resolves to `<BRAND.root>/global/X`.
 *  In exec form (ME-23) the path is its OWN `args[]` element and is rewritten UNQUOTED — the
 *  hook is spawned directly with no shell, so an install path containing spaces just works
 *  with no quoting. A legacy shell-string `command` (should no longer appear in the template,
 *  but handled defensively) keeps the single-quoting a real shell would still need. */
function resolveManagedPaths(template) {
  const base = join(BRAND.root, "global");
  const fixStr = (cmd) =>
    typeof cmd === "string"
      ? cmd.replace(/~\/\.forge\/(\S+)/g, (_, rest) => shellQuote(join(base, rest)))
      : cmd;
  const fixArg = (a) =>
    typeof a === "string" ? a.replace(/^~\/\.forge\/(.+)$/, (_, rest) => join(base, rest)) : a;
  const fixEntry = (h) => {
    if (h && Array.isArray(h.args)) h.args = h.args.map(fixArg);
    else if (h && typeof h.command === "string") h.command = fixStr(h.command);
  };
  if (template.statusLine) fixEntry(template.statusLine);
  for (const entries of Object.values(template.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) fixEntry(h);
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

/** Reduce ANY hook/statusLine entry to one comparable command string, quote-normalized and
 *  with the legacy `~/.forge/` prefix resolved, so the SAME guard compares equal across forms:
 *   - legacy shell-string:  `{command:"bash /x/guards/cortex.sh prompt"}`
 *   - exec form (ME-23):    `{command:"bash", args:["/x/guards/cortex.sh","prompt"]}`
 *  In exec form the `args[]` are joined onto `command` before normalizing. A bare string is
 *  accepted too. Used for ownership/removal matching (identity of the WHOLE command, not just
 *  the basename — that is `guardKey`'s job). */
function canonicalCommand(hook) {
  if (hook && typeof hook === "object") {
    if (Array.isArray(hook.args)) return normalizeCommand([hook.command, ...hook.args].join(" "));
    return normalizeCommand(hook.command);
  }
  return normalizeCommand(hook);
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
    const parsed = JSON.parse(raw);
    // ME-12: valid JSON that is not a top-level object (null / [] / "x" / 42) is corrupt,
    // not empty settings — refusing to overwrite preserves the user's real bytes.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { status: "corrupt", data: null };
    return { status: "ok", data: parsed };
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

/** Extract guard identity (`basename.sh` + trailing args) from a hook for dedup/ownership.
 *  THE CRUX of ME-23: it must derive the SAME key from BOTH forms of the same guard —
 *   - legacy shell-string:  `bash /x/guards/cortex.sh prompt`                        → `cortex.sh prompt`
 *   - exec form:            `{command:"bash", args:["/x/guards/cortex.sh","prompt"]}` → `cortex.sh prompt`
 *  so a user carrying the OLD shell-string install and a re-merge with the NEW exec-form
 *  template dedupe to ONE entry instead of growing a duplicate. For the legacy string it is
 *  quote-normalized (RA-12), collapsing quoted / unquoted / `~/.forge` / plugin-root spellings.
 *  For exec form it takes the basename of the `args[]` element that holds the `.sh` path and
 *  appends the remaining args. Accepts a whole hook object (preferred) or a bare command string
 *  (back-compat). Exported for tests + doctor. */
export function guardKey(hook) {
  // Exec form: the script path is an `args[]` element; the elements after it are its arguments.
  if (hook && typeof hook === "object" && Array.isArray(hook.args)) {
    const args = hook.args.map((a) => String(a));
    const i = args.findIndex((a) => a.includes(".sh"));
    if (i >= 0) {
      const base = args[i].split(/[/\\]/).pop();
      const rest = args
        .slice(i + 1)
        .join(" ")
        .trim();
      return rest ? `${base} ${rest}` : base;
    }
    return canonicalCommand(hook); // no script arg — fall back to the whole invocation
  }
  // Legacy shell-string, or an object carrying only `.command`.
  const cmd = normalizeCommand(hook && typeof hook === "object" ? hook.command : hook);
  const m = cmd.match(/([^/\\]+\.sh)\s*(.*)/);
  return m ? `${m[1]} ${m[2]}`.trim() : cmd;
}

/** Merge Forge hook entries into existing hook arrays, matching by guard identity to avoid
 *  duplicates. An existing entry that is the SAME resolved command as the template's — spelled
 *  as a legacy shell string (a pre-ME-23 install) or differently quoted — is upgraded in place
 *  to the exec form (`command`+`args`). A template hook counts as "already installed" only when
 *  an existing FORGE-owned entry (some path/form spelling of it) shares its guard key: a user's
 *  same-basename hook at a DIFFERENT path must NOT block Forge's own install (HI-05). Returns the
 *  merged tree plus the guard identities actually added this merge (`added: [{event, key,
 *  command, args?}]`) so the ownership manifest can reverse exactly them later. */
function mergeHooks(existing = {}, template = {}) {
  const merged = { ...existing };
  /** @type {{event:string, key:string, command:string, args?:string[]}[]} */
  const added = [];
  for (const [event, entries] of Object.entries(template)) {
    const existingEntries = merged[event] || [];
    // guardKey → template hook, to heal legacy shell-string spellings of the same guard.
    const templateByKey = new Map();
    for (const entry of entries) {
      for (const h of entry.hooks || []) templateByKey.set(guardKey(h), h);
    }
    // Upgrade an existing FORGE-owned entry that is the SAME resolved command as the template's
    // — a legacy shell string (pre-ME-23) or a differently-quoted spelling — in place to the exec
    // form. A user's same-basename hook at a DIFFERENT path has a different canonical command, so
    // it is never touched.
    for (const entry of existingEntries) {
      for (const h of entry.hooks || []) {
        if (h.command == null && !Array.isArray(h.args)) continue;
        const tpl = templateByKey.get(guardKey(h));
        if (tpl && canonicalCommand(h) === canonicalCommand(tpl)) {
          h.command = tpl.command;
          if (Array.isArray(tpl.args)) h.args = [...tpl.args];
          else delete h.args;
        }
      }
    }
    const presentForgeKeys = new Set(
      existingEntries
        .flatMap((e) => e.hooks || [])
        .filter((h) => isForgeCommand(h))
        .map((h) => guardKey(h)),
    );
    const newEntries = [];
    for (const entry of entries) {
      const hooks = (entry.hooks || []).filter((h) => !presentForgeKeys.has(guardKey(h)));
      for (const h of hooks)
        added.push({
          event,
          key: guardKey(h),
          command: h.command,
          args: Array.isArray(h.args) ? [...h.args] : undefined,
        });
      if (hooks.length) {
        newEntries.push({ ...entry, hooks });
      }
    }
    merged[event] = [...existingEntries, ...newEntries];
  }
  return { merged, added };
}

/** Best-effort reconstruction of Forge's footprint from a settings file that predates the
 *  ownership manifest but still carries the `_forge` marker (i.e. Forge installed into it with
 *  older code). Used to SEED the manifest on the first re-merge with new code, so a later
 *  uninstall still removes exactly what old Forge added rather than leaving orphaned hooks.
 *  Template-match based, hardened with `isForgeCommand` for hooks so a user's different-path
 *  hook is never adopted. Conservative: only entries that both match the template AND (for
 *  hooks) resolve to a Forge path are claimed. */
function legacyOwnedScan(settings, template) {
  const owned = {
    permissions: { allow: [], ask: [], deny: [] },
    /** @type {{event:string, key:string, command:string, args?:string[]}[]} */
    hooks: [],
    statusLine: false,
    schema: false,
  };
  if (settings.permissions && template.permissions) {
    for (const level of ["allow", "ask", "deny"]) {
      const tpl = template.permissions[level];
      const cur = settings.permissions[level];
      if (!Array.isArray(tpl) || !Array.isArray(cur)) continue;
      const tplSet = new Set(tpl);
      for (const s of cur) if (tplSet.has(s)) owned.permissions[level].push(s);
    }
  }
  const templateKeys = new Set();
  for (const entries of Object.values(template.hooks || {}))
    for (const entry of entries) for (const h of entry.hooks || []) templateKeys.add(guardKey(h));
  if (settings.hooks && typeof settings.hooks === "object") {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries)
        for (const h of entry?.hooks || [])
          if (
            h &&
            (typeof h.command === "string" || Array.isArray(h.args)) &&
            isForgeCommand(h) &&
            templateKeys.has(guardKey(h))
          )
            owned.hooks.push({
              event,
              key: guardKey(h),
              command: h.command,
              args: Array.isArray(h.args) ? [...h.args] : undefined,
            });
    }
  }
  if (
    settings.statusLine?.command &&
    template.statusLine?.command &&
    canonicalCommand(settings.statusLine) === canonicalCommand(template.statusLine)
  )
    owned.statusLine = true;
  if (settings.$schema && settings.$schema === template.$schema) owned.schema = true;
  return owned;
}

/**
 * Merge Forge settings (hooks, permissions, statusline) into the user's
 * ~/.claude/settings.json. Preserves all existing entries. Idempotent.
 *
 * ME-22: `onNotice(target)`, when given, is invoked with the resolved settings path BEFORE
 * any read/mutation of that GLOBAL file — so the CLI's consent/disclosure line always
 * precedes the merge it describes, never trails it. Not called when the merge is skipped.
 * @param {{settingsPath?: string, noSettings?: boolean, onNotice?: (target: string) => void}} [opts]
 */
export function mergeSettings({ settingsPath, noSettings, onNotice } = {}) {
  if (noSettings) return { action: "skipped", reason: "--no-settings" };
  const target = settingsPath || join(homedir(), ".claude", "settings.json");
  if (typeof onNotice === "function") onNotice(target);
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

  // Ownership manifest (HI-05): accumulate across re-merges so a re-install never forgets what
  // an earlier install added. Seed from the prior manifest if present; else, if the legacy
  // `_forge` marker is present (old install, no manifest), reconstruct old Forge's footprint by
  // template-match so a later uninstall still reverses it precisely.
  const prior =
    existing[FORGE_OWNED_KEY] &&
    typeof existing[FORGE_OWNED_KEY] === "object" &&
    existing[FORGE_OWNED_KEY].added
      ? existing[FORGE_OWNED_KEY].added
      : existing._forge === FORGE_SETTINGS_MARKER
        ? legacyOwnedScan(existing, template)
        : null;
  const ownedPerms = {
    allow: [...(prior?.permissions?.allow || [])],
    ask: [...(prior?.permissions?.ask || [])],
    deny: [...(prior?.permissions?.deny || [])],
  };
  const ownedHooks = [...(prior?.hooks || [])];
  let ownedStatusLine = Boolean(prior?.statusLine);
  let ownedSchema = Boolean(prior?.schema);

  // Hooks
  if (template.hooks) {
    const beforeHooks = JSON.stringify(existing.hooks || {});
    const { merged, added } = mergeHooks(existing.hooks, template.hooks);
    existing.hooks = merged;
    // Dedup by event+key: in exec form `command` is always "bash", so a hook's identity is its
    // guard key (basename+args), not the command string.
    for (const a of added)
      if (!ownedHooks.some((o) => o.event === a.event && o.key === a.key)) ownedHooks.push(a);
    if (JSON.stringify(existing.hooks) !== beforeHooks) report.added.push("hooks");
    else report.unchanged.push("hooks");
  }

  // Permissions
  if (template.permissions) {
    const ep = existing.permissions || {};
    for (const level of ["allow", "ask", "deny"]) {
      if (template.permissions[level]) {
        const cur = ep[level] || [];
        const curSet = new Set(cur);
        const newlyAdded = template.permissions[level].filter((s) => !curSet.has(s));
        ep[level] = unionStrings(cur, template.permissions[level]);
        if (newlyAdded.length) {
          report.added.push(`permissions.${level}`);
          for (const s of newlyAdded) if (!ownedPerms[level].includes(s)) ownedPerms[level].push(s);
        } else report.unchanged.push(`permissions.${level}`);
      }
    }
    if (!ep.defaultMode) ep.defaultMode = template.permissions.defaultMode || "default";
    existing.permissions = ep;
  }

  // Statusline — set only if not already configured (a user's own statusLine is left alone
  // AND not claimed, so uninstall never removes it).
  if (template.statusLine && !existing.statusLine) {
    existing.statusLine = template.statusLine;
    report.added.push("statusLine");
    ownedStatusLine = true;
  } else if (template.statusLine) {
    report.unchanged.push("statusLine");
  }

  // Schema — set only when absent; record whether WE set it.
  if (template.$schema && !existing.$schema) {
    existing.$schema = template.$schema;
    ownedSchema = true;
  }

  // Mark as forge-managed (metadata, won't affect Claude Code) + persist the ownership manifest.
  existing._forge = FORGE_SETTINGS_MARKER;
  existing[FORGE_OWNED_KEY] = {
    version: BRAND.version,
    added: {
      permissions: {
        allow: ownedPerms.allow,
        ask: ownedPerms.ask,
        deny: ownedPerms.deny,
      },
      hooks: ownedHooks,
      statusLine: ownedStatusLine,
      schema: ownedSchema,
    },
  };

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
 * Remove every entry Forge added from the user's ~/.claude/settings.json (RA-17, HI-05).
 * Authoritative source is the `_forgeOwned` ownership manifest written by `mergeSettings`:
 * only the permission strings, hook commands, statusLine, and `$schema` Forge genuinely
 * ADDED are reversed — a user's own `Bash(git status:*)`, identical statusLine/`$schema`,
 * or same-basename hook at a DIFFERENT path is preserved byte-for-byte because it was never
 * recorded as Forge-added. When the manifest is absent (a pre-HI-05 install, marked only by
 * `_forge`) it falls back to a conservative template match: permission strings verbatim, hook
 * commands whose guardKey matches a template guard AND resolve to a Forge path (so a user's
 * different-path hook stays), statusLine/`$schema` only if they equal the template's. Empty
 * containers are pruned; the `_forge` marker + `_forgeOwned` manifest are removed. Timestamped
 * backup + atomic tmp-file+rename write. Corrupt file → refuses; missing file → noop.
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

  // What to reverse. With an ownership manifest (HI-05) it is EXACTLY what Forge added; without
  // one (a pre-HI-05 install) fall back to the template shape, hardened so a user's different-path
  // hook is never removed and preferring to leave an entry when unsure.
  const manifest =
    settings[FORGE_OWNED_KEY] &&
    typeof settings[FORGE_OWNED_KEY] === "object" &&
    settings[FORGE_OWNED_KEY].added
      ? settings[FORGE_OWNED_KEY].added
      : null;
  const owned = manifest || legacyOwnedScan(settings, template);
  const ownedPerms = {
    allow: new Set(owned.permissions?.allow || []),
    ask: new Set(owned.permissions?.ask || []),
    deny: new Set(owned.permissions?.deny || []),
  };
  /** @type {Map<string, Set<string>>} event → canonical commands Forge owns (either form) */
  const ownedHookCmds = new Map();
  for (const h of owned.hooks || []) {
    if (!ownedHookCmds.has(h.event)) ownedHookCmds.set(h.event, new Set());
    ownedHookCmds.get(h.event).add(canonicalCommand(h));
  }
  // Drop the statusLine/$schema only if Forge set it AND it is still the template's value —
  // if the user replaced it after install, it is theirs now (leave it).
  const dropStatusLine =
    Boolean(owned.statusLine) &&
    Boolean(settings.statusLine?.command) &&
    Boolean(template.statusLine?.command) &&
    canonicalCommand(settings.statusLine) === canonicalCommand(template.statusLine);
  const dropSchema =
    Boolean(owned.schema) && Boolean(settings.$schema) && settings.$schema === template.$schema;

  // Hooks: drop only the exact commands Forge added (matched canonically within the event, so a
  // manifest entry recorded in either form removes the installed hook in either form).
  if (settings.hooks && typeof settings.hooks === "object") {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      const ownedCmds = ownedHookCmds.get(event);
      if (!ownedCmds || !ownedCmds.size) continue;
      let changed = false;
      const kept = [];
      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.hooks)) {
          kept.push(entry);
          continue;
        }
        const hooks = entry.hooks.filter((h) => !(h && ownedCmds.has(canonicalCommand(h))));
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

  // Permissions: remove only the exact strings Forge added, from the SAME list they sit in.
  if (settings.permissions) {
    for (const level of ["allow", "ask", "deny"]) {
      const drop = ownedPerms[level];
      const cur = settings.permissions[level];
      if (!drop.size || !Array.isArray(cur)) continue;
      const kept = cur.filter((s) => !drop.has(s));
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
      settings.permissions.defaultMode === (template.permissions?.defaultMode || "default")
    ) {
      delete settings.permissions;
    } else if (settings.permissions && Object.keys(settings.permissions).length === 0) {
      delete settings.permissions;
    }
  }

  if (dropStatusLine) {
    delete settings.statusLine;
    removed.push("statusLine");
  }
  if (dropSchema) delete settings.$schema;

  if (FORGE_OWNED_KEY in settings) delete settings[FORGE_OWNED_KEY];
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
 * `onSettingsNotice(target)` is forwarded to `mergeSettings` so the GLOBAL-settings
 * disclosure is emitted BEFORE the merge mutates ~/.claude/settings.json (ME-22).
 * @param {{targetRoot?: string, noSettings?: boolean, profile?: string, settingsOnly?: boolean, settingsPath?: string, onSettingsNotice?: (target: string) => void}} [opts]
 */
export function init({
  targetRoot = process.cwd(),
  noSettings = false,
  profile,
  settingsOnly = false,
  settingsPath,
  onSettingsNotice,
} = {}) {
  if (settingsOnly) {
    return {
      settings: mergeSettings({
        noSettings,
        settingsPath,
        onNotice: onSettingsNotice,
      }),
      settingsOnly: true,
    };
  }
  // RA-13: an invalid profile aborts BEFORE any filesystem/settings side effect —
  // no AGENTS.md, no .forge/, no .gitattributes append, no settings merge.
  const valid = validateProfile(profile);
  // `=== false` (not `!valid.ok`): tsc only narrows the discriminated union this way here.
  if (valid.ok === false) return { profile: { error: valid.error }, aborted: true };
  const profileResult = writeProfile(targetRoot, profile);
  // HI-09: the profile name is valid, but persistence can still FAIL at write time when
  // `.forge/forge.config.json` is corrupt (writeForgeConfig refuses). Abort BEFORE any further
  // side effect — no sync/AGENTS.md, no .gitattributes append, no settings merge — exactly like
  // the invalid-name path, so a corrupt config never leaves a half-initialized repo.
  if (profileResult?.error) return { profile: profileResult, aborted: true };
  const r = sync({ targetRoot });
  ensureLedgerGitattributes(targetRoot);
  const settings = mergeSettings({
    noSettings,
    settingsPath,
    onNotice: onSettingsNotice,
  });
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
