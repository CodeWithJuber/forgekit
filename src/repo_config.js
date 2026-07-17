// forge repo config — reads/writes <root>/.forge/config.json, a small per-repo file
// that records which agent tool this repo actually uses (`primaryTool`). Reading is a
// pure, throw-free probe; when no config exists the primary tool is auto-detected from
// which agent folders/files are present (mirrors autoDetectProvider in providers.js).
//
// The config drives ONE thing: which emitted targets `forge tools` hides in .gitignore.
// Default behaviour is unchanged — `forge sync` still emits every tool. Only the
// secondary-tool artifacts (the ones for tools this repo does NOT use) get gitignored,
// and only when the user opts in via `forge tools <name>`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureGitignoreBlock } from "./gitignore.js";

const CONFIG_REL = ".forge/config.json";

// Canonical primary-tool names Forge understands, and the on-disk marker that reveals
// a tool is in use. Order = auto-detect precedence.
const DETECT = [
  { tool: "claude", marker: "CLAUDE.md" },
  { tool: "cursor", marker: ".cursor" },
  { tool: "gemini", marker: ".gemini" },
  { tool: "codex", marker: ".codex" },
  { tool: "zed", marker: ".zed" },
  { tool: "vscode", marker: ".vscode" },
];

/** Tool names accepted by `forge tools <name>`. */
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
];

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
];

const configPath = (root) => join(root, CONFIG_REL);

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
 * Read <root>/.forge/config.json. Never throws — a missing or malformed file yields {}.
 * @param {string} [root]
 * @returns {{primaryTool?:string, tools?:string[]}}
 */
export function readRepoConfig(root = process.cwd()) {
  const file = configPath(root);
  let raw = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") raw = parsed;
    } catch {
      // malformed → treat as absent
    }
  }
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

/** Persist primaryTool into <root>/.forge/config.json, preserving other keys. */
export function setPrimaryTool(root, tool) {
  const file = configPath(root);
  /** @type {Record<string, any>} */
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf8")) || {};
    } catch {
      cfg = {};
    }
  }
  cfg.primaryTool = tool;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

/**
 * Clear the primary-tool config. Removes only the `primaryTool` key; if the file is
 * left empty it is deleted. Never throws.
 * @param {string} root
 * @returns {{cleared:boolean, path:string}}
 */
export function clearRepoConfig(root) {
  const file = configPath(root);
  if (!existsSync(file)) return { cleared: false, path: file };
  /** @type {Record<string, any>} */
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(file, "utf8")) || {};
  } catch {
    cfg = {};
  }
  const had = "primaryTool" in cfg;
  delete cfg.primaryTool;
  if (Object.keys(cfg).length === 0) rmSync(file, { force: true });
  else writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { cleared: had, path: file };
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
 * artifacts. Runs a real sync to learn the emit targets (injectable via `syncFn` for
 * tests), so the gitignore block always reflects what Forge actually emits.
 * @param {string} root
 * @param {string} name canonical primary-tool key (must be in KNOWN_TOOLS)
 * @param {{syncFn?:(root:string)=>Promise<{report:any[]}>|{report:any[]}}} [opts]
 * @returns {Promise<{primaryTool:string, configPath:string, targets:string[],
 *   gitignore:string, gitignorePath:string}>}
 */
export async function applyPrimaryTool(root, name, { syncFn } = {}) {
  if (!KNOWN_TOOLS.includes(name))
    throw new Error(`unknown tool: ${name} (known: ${KNOWN_TOOLS.join(", ")})`);
  const cfgFile = setPrimaryTool(root, name);
  const runSync = syncFn || (async (r) => (await import("./sync.js")).sync({ targetRoot: r }));
  const { report } = await runSync(root);
  const targets = nonPrimaryTargets(report, name);
  const gi = ensureGitignoreBlock(root, targets);
  return {
    primaryTool: name,
    configPath: cfgFile,
    targets,
    gitignore: gi.action,
    gitignorePath: gi.path,
  };
}
