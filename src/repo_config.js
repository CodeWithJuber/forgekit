// forge repo config — THE single per-repo config module (RA-15). The unified file is
// <root>/.forge/forge.config.json: profile / disableSections / rules / tools (read by
// sync; `tools` is the set of agent tools this repo emits config for, recorded by
// `forge init`) plus primaryTool (read by `forge tools`), and any future keys — unknown keys
// always round-trip through writeForgeConfig. The legacy <root>/.forge/config.json
// (primaryTool/tools only) is still migration-read; on key conflicts the unified
// forge.config.json wins, and the legacy file is left in place.
//
// Malformed JSON is never silently discarded: reads warn ONCE per process on stderr and
// report `{corrupt: true, path}` alongside whatever valid data the other file held;
// writes REFUSE (`{ok:false, reason}`) rather than replace bytes a human may still want
// to fix. When no config exists the primary tool is auto-detected from which agent
// folders/files are present (mirrors autoDetectProvider in providers.js).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BRAND } from "./brand.js";
import { ensureGitignoreBlock } from "./gitignore.js";

const FORGE_CONFIG_REL = ".forge/forge.config.json";
const LEGACY_CONFIG_REL = ".forge/config.json";

// Canonical primary-tool names Forge understands, and the on-disk marker that reveals
// a tool is in use. Order = auto-detect precedence.
const DETECT = [
  { tool: "claude", marker: "CLAUDE.md" },
  { tool: "cursor", marker: ".cursor" },
  { tool: "gemini", marker: ".gemini" },
  { tool: "codex", marker: ".codex" },
  { tool: "zed", marker: ".zed" },
  { tool: "vscode", marker: ".vscode" },
  { tool: "aider", marker: ".aider.conf.yml" },
  { tool: "continue", marker: ".continue" },
  { tool: "windsurf", marker: ".windsurf" },
  { tool: "roo", marker: ".roo" },
  { tool: "openclaw", marker: ".openclaw" },
];

/** Tool names accepted by `forge tools <name>`. Kept in lockstep with the emit targets
 *  (rowToolKey / TOOL_KEYS) — every tool Forge can emit for is selectable as primary. */
export const KNOWN_TOOLS = [
  "claude",
  "cursor",
  "gemini",
  "codex",
  "zed",
  "vscode",
  "aider",
  "continue",
  "windsurf",
  "roo",
  "openclaw",
];

// Every on-disk sign that a repo already uses a tool — the evidence `forge init` needs to
// emit that tool's config. Broader than DETECT (which only ranks a single primary tool):
// a tool's legacy rules files count too, e.g. `.github/copilot-instructions.md` for Copilot.
/** @type {Record<string, string[]>} */
const TOOL_MARKERS = {
  claude: ["CLAUDE.md", ".claude", ".mcp.json"],
  cursor: [".cursor", ".cursorrules"],
  gemini: [".gemini", "GEMINI.md"],
  codex: [".codex"],
  zed: [".zed", ".rules"],
  vscode: [".vscode", ".github/copilot-instructions.md"],
  aider: [".aider.conf.yml"],
  continue: [".continue"],
  windsurf: [".windsurf", ".windsurfrules", ".devin"],
  roo: [".roo", ".roomodes"],
  openclaw: [".openclaw"],
};

// Names people type for a tool whose canonical key differs.
/** @type {Record<string, string>} */
const TOOL_ALIASES = { copilot: "vscode", devin: "windsurf", "claude-code": "claude" };

/**
 * Every tool this repo already shows signs of using (KNOWN_TOOLS order). Pure read.
 * @param {string} [root]
 * @returns {string[]}
 */
export function detectTools(root = process.cwd()) {
  return KNOWN_TOOLS.filter((t) => TOOL_MARKERS[t].some((m) => existsSync(join(root, m))));
}

/**
 * Normalise a tool selection — a `--tools` value (`"claude,cursor"`, `"all"`) or the config's
 * `tools` key (an array, or `"all"`) — into canonical keys in KNOWN_TOOLS order. `tools: null`
 * means every tool. Unrecognised names come back in `unknown` so a caller can refuse them
 * (init) or warn (sync). Pure.
 * @param {unknown} value
 * @returns {{tools: string[]|null, unknown: string[]}}
 */
export function parseTools(value) {
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const names = list
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .map((t) => TOOL_ALIASES[t] ?? t);
  if (names.includes("all")) return { tools: null, unknown: [] };
  return {
    tools: KNOWN_TOOLS.filter((t) => names.includes(t)),
    unknown: [...new Set(names.filter((t) => !KNOWN_TOOLS.includes(t)))],
  };
}

/**
 * The tool set a repo config records (`tools`, written by `forge init`) as canonical keys, or
 * null when it records none or `all`: every tool. The one reader shared by sync, integrations
 * and `forge tools`, so they always emit for the same set. Pure.
 * @param {Record<string, any>} cfg a parsed repo config (readForgeConfig)
 * @returns {string[]|null}
 */
export function recordedTools(cfg) {
  const value = cfg?.tools;
  return typeof value === "string" || Array.isArray(value) ? parseTools(value).tools : null;
}

// Map a sync-report row's tool label to a canonical tool key. The shared source
// (AGENTS.md) and any unmapped label return null and are never gitignored.
/** @type {[string, RegExp][]} */
const TOOL_KEYS = [
  ["claude", /^Claude Code/],
  ["cursor", /^Cursor/],
  ["gemini", /^Gemini/],
  ["codex", /^Codex/],
  ["zed", /^Zed/],
  ["vscode", /Copilot|VS Code/],
  ["aider", /^Aider/],
  ["continue", /^Continue/],
  ["windsurf", /^Windsurf/],
  ["roo", /^Roo/],
  ["openclaw", /^OpenClaw/],
];

const forgeConfigPath = (root) => join(root, FORGE_CONFIG_REL);
const legacyConfigPath = (root) => join(root, LEGACY_CONFIG_REL);

// One loud warning per process (not per read) — the cortex hooks re-read config on every
// event, and repeating the same corruption warning on each hook fire would be spam.
let warnedCorruptConfig = false;

/** Filesystem-safe timestamp for backup filenames. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function warnCorrupt(path) {
  if (warnedCorruptConfig) return;
  warnedCorruptConfig = true;
  process.stderr.write(
    `${BRAND.cli}: ${path} is not valid JSON — ignoring it (fix or delete it); refusing to overwrite\n`,
  );
}

/**
 * Parse one config file without ever throwing.
 * @param {string} path
 * @returns {{status:"missing"|"ok"|"corrupt", data:Record<string, any>}}
 */
function readConfigFile(path) {
  if (!existsSync(path)) return { status: "missing", data: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    // ME-12: valid JSON that is NOT a top-level object (null / [] / "x" / 42) is treated
    // as corrupt, exactly like unparseable bytes — never coerced to `{}`, or a later write
    // would silently replace bytes a human may still want (violating the config invariant).
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { status: "corrupt", data: {} };
    return { status: "ok", data: parsed };
  } catch {
    return { status: "corrupt", data: {} };
  }
}

/**
 * Read the unified repo config: `.forge/forge.config.json` merged over the legacy
 * `.forge/config.json` (migration read — the unified file wins on key conflicts).
 * Never throws. A corrupt file is reported (`corrupt: true`, `path` = the corrupt
 * file) alongside whatever valid data the other file held, and warned once per
 * process on stderr — never silently treated as absent.
 * @param {string} [root]
 * @returns {Record<string, any> & {corrupt?: true, path?: string}}
 */
export function readForgeConfig(root = process.cwd()) {
  const unified = readConfigFile(forgeConfigPath(root));
  const legacy = readConfigFile(legacyConfigPath(root));
  const out = { ...legacy.data, ...unified.data };
  const corruptPath =
    unified.status === "corrupt"
      ? forgeConfigPath(root)
      : legacy.status === "corrupt"
        ? legacyConfigPath(root)
        : null;
  if (!corruptPath) return out;
  warnCorrupt(corruptPath);
  return { ...out, corrupt: true, path: corruptPath };
}

/**
 * Read-modify-write of `.forge/forge.config.json` via `mutator(cfg)`. Unknown keys
 * round-trip untouched (later features store their own keys here). Legacy
 * `.forge/config.json` keys are folded in on write — the unified file wins on
 * conflicts and the legacy file itself is left in place. If forge.config.json exists
 * but is corrupt JSON the write REFUSES and the bytes on disk are preserved.
 * @param {string} root
 * @param {(cfg: Record<string, any>) => Record<string, any>|undefined} mutator mutate the
 *   draft in place (and return it) or return a replacement object
 * @returns {{ok:true, path:string, config:Record<string, any>}|{ok:false, path:string, reason:string}}
 */
export function writeForgeConfig(root, mutator) {
  const path = forgeConfigPath(root);
  const unified = readConfigFile(path);
  if (unified.status === "corrupt") {
    warnCorrupt(path);
    return {
      ok: false,
      path,
      reason: `${path} is not valid JSON — refusing to overwrite (fix or delete it)`,
    };
  }
  const legacy = readConfigFile(legacyConfigPath(root));
  if (legacy.status === "corrupt") warnCorrupt(legacyConfigPath(root));
  const draft = { ...legacy.data, ...unified.data };
  const next = mutator(draft) ?? draft;
  mkdirSync(dirname(path), { recursive: true });
  // ME-13: back up an existing valid config before overwriting, then write via a temp file
  // + atomic rename (same pattern as mergeSettings) so a crash mid-write can never truncate
  // the unified config. First write (no existing file) needs no backup.
  if (unified.status === "ok" && existsSync(path))
    copyFileSync(path, `${path}.forge-bak-${stamp()}`);
  const tmp = `${path}.forge-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
  return { ok: true, path, config: next };
}

// ---------------------------------------------------------------------------
// Policy profiles (P1-02, RA-14). Defined here — the config module — so sync.js can
// read them without a static import cycle through init.js (init.js re-exports them).
// ---------------------------------------------------------------------------

/** Valid policy profiles. `standard` is the full engineering pack (default). */
export const PROFILES = ["minimal", "standard"];

/** Pre-RA-14 profile names. They were always aliases of the full pack (`sync` only ever
 *  branched on `minimal`), so they are now accepted as deprecated aliases of `standard`. */
export const LEGACY_PROFILES = {
  "web-app": "standard",
  "backend-service": "standard",
  library: "standard",
  regulated: "standard",
};

/**
 * Validate a profile name. Pure. Legacy names map to their real profile with
 * `deprecated` set to the old name so callers can warn BEFORE any side effect.
 * Absence (`undefined`/empty) is valid: no profile was requested (RA-13).
 * @param {string} [p]
 * @returns {{ok:true, profile?:string, deprecated?:string}|{ok:false, error:string}}
 */
export function validateProfile(p) {
  if (!p) return { ok: true };
  if (PROFILES.includes(p)) return { ok: true, profile: p };
  if (Object.hasOwn(LEGACY_PROFILES, p))
    return { ok: true, profile: LEGACY_PROFILES[p], deprecated: p };
  return {
    ok: false,
    error: `unknown profile: ${p} (valid: ${PROFILES.join(", ")}; deprecated aliases of standard: ${Object.keys(LEGACY_PROFILES).join(", ")})`,
  };
}

/**
 * The primary tool inferred from on-disk agent markers, or null if none present.
 * @param {string} [root]
 * @returns {string|null}
 */
export function detectPrimaryTool(root = process.cwd()) {
  for (const d of DETECT) if (existsSync(join(root, d.marker))) return d.tool;
  return null;
}

/**
 * Read the primary-tool view of the repo config (unified file, with legacy migration
 * read). Never throws — missing or malformed files yield {}.
 * @param {string} [root]
 * @returns {{primaryTool?:string, tools?:string[]}}
 */
export function readRepoConfig(root = process.cwd()) {
  const raw = readForgeConfig(root);
  const out = {};
  if (typeof raw.primaryTool === "string" && raw.primaryTool) out.primaryTool = raw.primaryTool;
  if (Array.isArray(raw.tools)) out.tools = raw.tools.filter((t) => typeof t === "string");
  return out;
}

/**
 * Resolve the effective primary tool: explicit config wins, else auto-detect, else none.
 * @param {string} [root]
 * @returns {{tool:string|null, source:"config"|"auto-detect"|"none"}}
 */
export function resolvePrimaryTool(root = process.cwd()) {
  const cfg = readRepoConfig(root);
  if (cfg.primaryTool) return { tool: cfg.primaryTool, source: "config" };
  const detected = detectPrimaryTool(root);
  if (detected) return { tool: detected, source: "auto-detect" };
  return { tool: null, source: "none" };
}

/** Persist primaryTool into <root>/.forge/forge.config.json, preserving other keys. When
 *  `forge init` recorded a tool set that lacks the tool, the tool joins it in the same write:
 *  sync emits only the recorded set, and a primary tool without its own config is a dead end.
 *  Throws (fail loudly) when the existing file is corrupt JSON — it is never replaced.
 *  @param {string} root
 *  @param {string} tool canonical tool key
 *  @returns {{path:string, addedTool:boolean}} */
export function setPrimaryTool(root, tool) {
  let addedTool = false;
  const res = writeForgeConfig(root, (cfg) => {
    cfg.primaryTool = tool;
    const tools = recordedTools(cfg);
    if (tools !== null && !tools.includes(tool)) {
      cfg.tools = Array.isArray(cfg.tools) ? [...cfg.tools, tool] : [...tools, tool];
      addedTool = true;
    }
    return cfg;
  });
  // `=== false` (not `!res.ok`): tsc only narrows the discriminated union this way here.
  if (res.ok === false) throw new Error(res.reason);
  return { path: res.path, addedTool };
}

/**
 * Clear the primary-tool config: removes the `primaryTool` key from BOTH the unified
 * forge.config.json and the legacy config.json (else a legacy value would resurface on the
 * next migration read), preserving every other key. `tools` (the emit set `forge init`
 * recorded) stays: dropping it would make the next sync emit every tool again. A file left
 * empty is deleted; a corrupt file is left untouched (never rewritten). Never throws.
 * @param {string} root
 * @returns {{cleared:boolean, path:string}}
 */
export function clearRepoConfig(root) {
  let had = false;
  for (const file of [forgeConfigPath(root), legacyConfigPath(root)]) {
    const { status, data } = readConfigFile(file);
    if (status === "missing") continue;
    if (status === "corrupt") {
      warnCorrupt(file);
      continue;
    }
    if (!("primaryTool" in data)) continue;
    had = true;
    delete data.primaryTool;
    if (Object.keys(data).length === 0) rmSync(file, { force: true });
    else writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  return { cleared: had, path: forgeConfigPath(root) };
}

/** Canonical tool key for a sync-report row's tool label, or null when shared/unmapped. */
export function rowToolKey(toolLabel) {
  for (const [key, re] of TOOL_KEYS) if (re.test(toolLabel || "")) return key;
  return null;
}

/**
 * The emitted target paths that belong to a tool OTHER than `primary` — the artifacts a
 * repo using only `primary` should gitignore. The shared AGENTS.md and the primary tool's
 * own files are always kept tracked. Deduped, order-stable.
 * @param {{tool:string, target:string}[]} report sync()'s report rows
 * @param {string} primary canonical primary-tool key
 * @returns {string[]}
 */
export function nonPrimaryTargets(report, primary) {
  const out = new Set();
  for (const row of report || []) {
    const target = row?.target;
    if (!target || target === "AGENTS.md" || target === "-") continue;
    const key = rowToolKey(row.tool);
    if (!key || key === primary) continue;
    out.add(target);
  }
  return [...out].sort();
}

/**
 * Set `name` as the repo's primary tool and gitignore every other tool's emitted
 * artifacts. The caller injects `syncFn` (the sync runner) so this config-leaf module
 * never imports the sync compiler; the gitignore block reflects what Forge actually emits.
 * A tool missing from the set `forge init` recorded is added to it first (`addedTool`), so
 * the sync emits the primary tool's config.
 * @param {string} root
 * @param {string} name canonical primary-tool key (must be in KNOWN_TOOLS)
 * @param {{syncFn?:(root:string)=>Promise<{report:any[]}>|{report:any[]}}} [opts] syncFn is required at runtime
 * @returns {Promise<{primaryTool:string, configPath:string, addedTool:boolean,
 *   targets:string[], gitignore:string, gitignorePath:string}>}
 */
export async function applyPrimaryTool(root, name, { syncFn } = {}) {
  if (!KNOWN_TOOLS.includes(name))
    throw new Error(`unknown tool: ${name} (known: ${KNOWN_TOOLS.join(", ")})`);
  const { path: cfgFile, addedTool } = setPrimaryTool(root, name);
  // syncFn is injected by the caller (cli.js / tests). Required so this config-leaf
  // module never imports the sync compiler — keeping the layering acyclic.
  if (typeof syncFn !== "function")
    throw new Error("applyPrimaryTool requires an injected syncFn(root) -> { report }");
  const { report } = await syncFn(root);
  const targets = nonPrimaryTargets(report, name);
  const gi = ensureGitignoreBlock(root, targets);
  return {
    primaryTool: name,
    configPath: cfgFile,
    addedTool,
    targets,
    gitignore: gi.action,
    gitignorePath: gi.path,
  };
}
