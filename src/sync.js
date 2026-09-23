// forge sync — compile the one canonical source (source/rules.json, plus an
// optional per-repo .forge/rules.json) into every tool's native config target.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brainBlock } from "./brain.js";
import { BRAND } from "./brand.js";
import { cortexBlock } from "./cortex.js";
import * as shared from "./emit/_shared.js";
import aider from "./emit/aider.js";
import claude from "./emit/claude.js";
import codex from "./emit/codex.js";
import continueTool from "./emit/continue.js";
import copilot from "./emit/copilot.js";
import cursor from "./emit/cursor.js";
import gemini from "./emit/gemini.js";
import { emitMcp } from "./emit/mcp.js";
import openclaw from "./emit/openclaw.js";
import windsurf from "./emit/windsurf.js";
import zed from "./emit/zed.js";
import { managedMcpState } from "./integrations.js";
import {
  KNOWN_TOOLS,
  LEGACY_PROFILES,
  parseTools,
  readForgeConfig,
  rowToolKey,
} from "./repo_config.js";

const MODULES = [
  codex,
  cursor,
  copilot,
  windsurf,
  zed,
  claude,
  gemini,
  aider,
  continueTool,
  openclaw,
];

// Soft budget: Codex hard-truncates at 32 KiB, Windsurf caps ~12k chars. Warn early.
const SIZE_BUDGET_BYTES = 12 * 1024;

/** Turn the rules object into the canonical AGENTS.md markdown body. */
export function assemble(rules) {
  const out = [`# AGENTS.md — ${rules.title || "engineering rules"}`, ""];
  if (rules.intro) out.push(rules.intro, "");
  for (const section of rules.sections || []) {
    out.push(`## ${section.title}`);
    for (const rule of section.rules || []) out.push(`- ${rule}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

// The `minimal` profile: only the five non-negotiable safety rules, for repos that don't
// want forge's full engineering-philosophy pack imposed on an existing architecture (P1-02).
const MINIMAL_SECTION = {
  id: "core-safety",
  title: "Core safety",
  rules: [
    "Never expose or write secrets, tokens, or keys into code, commits, or output.",
    "Inspect the surrounding code before editing; match the existing conventions.",
    "Verify before claiming completion — run tests/build/lint and show the command + output.",
    "Respect the repository's existing architecture and conventions over any default.",
    "Ask before destructive or irreversible actions (rm -rf, history rewrite, prod changes).",
  ],
};

/** Read the optional per-repo config — the unified `.forge/forge.config.json`, with
 *  legacy `.forge/config.json` keys folded in (repo_config.js is the single config
 *  module, RA-15). Rule loading stays fail-open so a typo can't break `forge sync`,
 *  but corrupt JSON is no longer silent: readForgeConfig warns once on stderr and
 *  marks the result (`corrupt`/`path`) so sync() can surface a warning row. */
export function loadConfig(targetRoot) {
  return readForgeConfig(targetRoot);
}

// Warn once per process when a stored legacy profile name is read (RA-14) — loadRules
// runs on every sync/drift check and the hooks would otherwise repeat the warning.
let warnedLegacyProfile = false;
// Same one-warning-per-process discipline for a corrupt legacy `.forge/rules.json` (ME-20).
let warnedCorruptRules = false;

/**
 * Read the optional legacy `.forge/rules.json` through a guarded parser (ME-20). The
 * unified config is already fail-safe (loadConfig), but this override used to be parsed
 * with a bare `JSON.parse`, so a single typo threw and ABORTED the whole `forge sync`.
 * Now invalid JSON warns once on stderr and falls back to no override — never throws,
 * and the file's bytes are left exactly as the user wrote them (nothing is rewritten).
 * @param {string} targetRoot
 * @returns {{sections:any[], corrupt:boolean, path:string}}
 */
function readLegacyRules(targetRoot) {
  const path = join(targetRoot, ".forge/rules.json");
  if (!existsSync(path)) return { sections: [], corrupt: false, path };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { sections: [], corrupt: false, path };
  }
  try {
    const extra = JSON.parse(text);
    return {
      sections: Array.isArray(extra?.sections) ? extra.sections : [],
      corrupt: false,
      path,
    };
  } catch {
    if (!warnedCorruptRules) {
      warnedCorruptRules = true;
      process.stderr.write(
        `${BRAND.cli}: ${path} is not valid JSON — ignoring it (fix or delete it); using default rules\n`,
      );
    }
    return { sections: [], corrupt: true, path };
  }
}

/**
 * Resolve the rule set for a repo with explicit, deterministic override semantics (P1-03):
 *   1. profile — `minimal` replaces the pack with the core-safety section; anything else
 *      (including the deprecated legacy names web-app/backend-service/library/regulated,
 *      which warn once per process) behaves as `standard`, the full source pack (RA-14).
 *   2. disableSections — drop sections by id or title.
 *   3. appends — legacy `.forge/rules.json` sections, then `config.rules` sections.
 */
function loadRules(targetRoot) {
  const cfg = loadConfig(targetRoot);
  const base = JSON.parse(readFileSync(join(BRAND.root, "source/rules.json"), "utf8"));
  if (
    typeof cfg.profile === "string" &&
    Object.hasOwn(LEGACY_PROFILES, cfg.profile) &&
    !warnedLegacyProfile
  ) {
    warnedLegacyProfile = true;
    process.stderr.write(
      `${BRAND.cli}: profile "${cfg.profile}" is deprecated — treated as "standard"\n`,
    );
  }
  if (cfg.profile === "minimal") {
    base.sections = [MINIMAL_SECTION];
  } else if (Array.isArray(cfg.disableSections) && cfg.disableSections.length) {
    const drop = new Set(cfg.disableSections);
    base.sections = (base.sections || []).filter((s) => !drop.has(s.id) && !drop.has(s.title));
  }
  const legacy = readLegacyRules(targetRoot);
  if (legacy.sections.length) base.sections = [...(base.sections || []), ...legacy.sections];
  if (Array.isArray(cfg.rules) && cfg.rules.length) {
    base.sections = [...(base.sections || []), ...cfg.rules];
  }
  return base;
}

/** Full canonical body: rules + portable memory + learned lessons — one source of truth. */
function buildCanonical(targetRoot) {
  const rules = loadRules(targetRoot);
  const brain = brainBlock(targetRoot); // durable facts (forge brain)
  const lessons = cortexBlock(targetRoot); // learned corrections (forge cortex)
  return assemble(rules) + (brain ? `\n${brain}` : "") + (lessons ? `\n${lessons}` : "");
}

/** Filesystem-safe timestamp for backup names (same convention as init / repo_config). */
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Where AGENTS.md stands against the block sync would write. The ONE reader shared by sync,
 * the Stop-hook auto-sync and doctor, so they can never disagree about which text is forge's:
 *   missing        no AGENTS.md
 *   hand-written   a person's file with no forge block (sync appends one, never rewrites it)
 *   in-sync        the block matches the canonical source byte for byte
 *   drifted        the block differs (stale source, or an edit inside the markers)
 *   legacy         the pre-block, fully generated format, hash-verified: it converts to a block
 *                  keeping any text a person added above or below forge's region
 *   legacy-edited  pre-block format whose generated region was itself edited; converting it
 *                  needs a backup, so only an explicit `forge sync` does it
 *   damaged        one marker without the other; forge will not guess where its text ends
 * @param {string} [targetRoot]
 * @param {string} [body] the canonical body (built from the repo when omitted)
 * @returns {{state:"missing"|"hand-written"|"in-sync"|"drifted"|"legacy"|"legacy-edited"|"damaged",
 *   path:string, text:string|null, block:string,
 *   found?:{start:number, end:number}, legacy?:{lossless:boolean, before:string, after:string}}}
 */
export function agentsMdStatus(targetRoot = process.cwd(), body = buildCanonical(targetRoot)) {
  const path = join(targetRoot, "AGENTS.md");
  const text = shared.readIfExists(path);
  const block = shared.managedBlock(shared.mdHeader(shared.hashContent(body)), body);
  if (text === null) return { state: "missing", path, text, block };
  const found = shared.findManagedBlock(text);
  if (found?.damaged === true) return { state: "damaged", path, text, block };
  if (found?.damaged === false) {
    const current = text.slice(found.start, found.end);
    return { state: current === block ? "in-sync" : "drifted", path, text, block, found };
  }
  const legacy = shared.splitLegacyManaged(text);
  if (legacy)
    return { state: legacy.lossless ? "legacy" : "legacy-edited", path, text, block, legacy };
  return { state: "hand-written", path, text, block };
}

/**
 * Bring AGENTS.md to the canonical block, touching nothing outside the markers. A person's
 * file gets the block APPENDED; a legacy fully generated file is converted, keeping every
 * byte a person added around forge's region. Only `legacy-edited` needs a full rewrite, and
 * only when `allowBackup` is set: the whole old file is first copied to a timestamped
 * `AGENTS.md.forge-bak-<time>` (never one fixed name that a later run would overwrite).
 * @param {ReturnType<typeof agentsMdStatus>} status
 * @param {{allowBackup:boolean}} opts
 * @returns {{action:string, note:string, backup?:string, warning?:string}}
 */
function writeAgentsBlock(status, { allowBackup }) {
  const { state, path, block } = status;
  const text = status.text ?? "";
  const put = (next, note, extra = {}) => {
    writeFileSync(path, next);
    return { action: "written", note, ...extra };
  };
  // An older forge moved a hand-written AGENTS.md aside to this one fixed name.
  const oldBak = existsSync(`${path}.forge-bak`)
    ? "AGENTS.md.forge-bak (the hand-written file an older forge replaced) can now go back into AGENTS.md, outside the Forge block."
    : "";
  if (state === "in-sync") return { action: "unchanged", note: "Forge block current" };
  if (state === "missing") return put(block, "new file (Forge block)");
  if (state === "drifted" && status.found) {
    const { start, end } = status.found;
    return put(
      text.slice(0, start) + block + text.slice(end),
      "Forge block refreshed; text outside it untouched",
    );
  }
  if (state === "hand-written") {
    const sep = !text.trim()
      ? ""
      : text.endsWith("\n\n")
        ? ""
        : text.endsWith("\n")
          ? "\n"
          : "\n\n";
    return put(
      `${text.trim() ? text : ""}${sep}${block}`,
      "Forge block appended; your text untouched",
    );
  }
  if (state === "legacy" && status.legacy) {
    const { before, after } = status.legacy;
    return put(
      `${before}${block}${after ? `\n${after}` : ""}`,
      "converted to a Forge block (lossless)",
      oldBak ? { warning: oldBak } : {},
    );
  }
  if (state === "legacy-edited" && status.legacy) {
    if (!allowBackup)
      return { action: "skipped", note: "generated text was hand-edited — run `forge sync`" };
    const backup = `${path}.forge-bak-${stamp()}`;
    writeFileSync(backup, text);
    const name = `AGENTS.md${backup.slice(path.length)}`;
    return put(`${status.legacy.before}${block}`, "converted to a Forge block", {
      backup,
      warning: [
        `AGENTS.md was fully generated but edited inside the generated text — converted to a Forge block; the previous file is saved as ${name}.`,
        "Copy your edits back OUTSIDE the <!-- forge:begin --> / <!-- forge:end --> markers, where sync never touches them.",
        oldBak,
      ]
        .filter(Boolean)
        .join(" "),
    });
  }
  return {
    action: "skipped",
    note: "damaged Forge markers",
    warning:
      "AGENTS.md has a forge:begin marker without forge:end (or the reverse) — nothing written; fix or remove the marker lines by hand",
  };
}

/**
 * Which tools sync emits for: an explicit list (init passes one) wins, then the repo config's
 * `tools` key (recorded by `forge init`), else every tool — a repo that never chose keeps the
 * emit-everything behaviour it always had. `tools: null` means every tool.
 * @param {unknown} explicit
 * @param {Record<string, any>} cfg
 * @returns {{tools: string[]|null, unknown: string[]}}
 */
function resolveTools(explicit, cfg) {
  if (explicit !== undefined && explicit !== null) return parseTools(explicit);
  if (typeof cfg.tools === "string" || Array.isArray(cfg.tools)) return parseTools(cfg.tools);
  return { tools: null, unknown: [] };
}

/**
 * Compile the canonical source into AGENTS.md (forge's marked block only) and each selected
 * tool's native config.
 * @param {{targetRoot?: string, tools?: string|string[]|null}} [opts] `tools`: KNOWN_TOOLS keys
 *   or "all"; omitted = the repo config's `tools`, else every tool.
 */
export function sync({ targetRoot = process.cwd(), tools } = {}) {
  // Inline portable memory + learned lessons so every AGENTS.md-reading tool shares them.
  const canonical = buildCanonical(targetRoot);
  const hash = shared.hashContent(canonical);
  const bytes = Buffer.byteLength(canonical);
  const cfg = loadConfig(targetRoot);
  const selection = resolveTools(tools, cfg);
  const emits = (key) => selection.tools === null || selection.tools.includes(key);

  // The shared AGENTS.md — read directly by Codex, Cursor, Copilot, Windsurf, Zed, OpenClaw.
  // Forge owns only its marked block in it: a hand-written file keeps every line (the old
  // behaviour replaced the whole file and parked the original in AGENTS.md.forge-bak).
  const agentsPath = join(targetRoot, "AGENTS.md");
  const agents = writeAgentsBlock(agentsMdStatus(targetRoot, canonical), { allowBackup: true });

  const ctx = {
    targetRoot,
    canonical,
    hash,
    bytes,
    chars: canonical.length,
    agentsPath,
    shared,
    join,
  };
  const report = [
    {
      tool: "shared source",
      target: "AGENTS.md",
      action: agents.action,
      note: `${bytes} B · ${agents.note}`,
    },
  ];
  for (const mod of MODULES) {
    if (!emits(rowToolKey(mod.tool))) continue;
    try {
      report.push(mod.emit(ctx));
    } catch (err) {
      report.push({
        tool: mod.tool,
        target: "-",
        action: "error",
        note: err.message,
      });
    }
  }

  // MCP servers — emit the FULL managed set (registry ∪ recorded integrations) into each
  // selected tool's MCP config (real formats). Sharing managedMcpState with `integrations add`
  // means sync can never drop a server that add installed, and vice versa (RA-03). A
  // corrupt repo config falls back to registry-only with a warning — never treated as
  // "no integrations installed, overwrite everything".
  const warnings = [];
  const mcpFile = join(BRAND.root, "source", "mcp.json");
  if (existsSync(mcpFile)) {
    try {
      const { servers, owns, warning } = managedMcpState(targetRoot);
      if (warning) warnings.push(warning);
      for (const row of emitMcp({ targetRoot, servers, owns, tools: selection.tools }))
        report.push(row);
    } catch (err) {
      report.push({
        tool: "MCP",
        target: "-",
        action: "error",
        note: err.message,
      });
    }
  }
  // Corrupt repo config: rules were built from defaults (fail-open), but say so in the
  // report instead of only on stderr — a typo'd config must not vanish silently (RA-15).
  if (cfg.corrupt)
    warnings.push(
      `${cfg.path} is not valid JSON — config ignored, default rules used (fix or delete it)`,
    );
  // Legacy `.forge/rules.json`: corrupt JSON is ignored (fail-safe, ME-20) — say so in the
  // report instead of only on stderr, mirroring the corrupt-config warning above.
  const legacyRules = readLegacyRules(targetRoot);
  if (legacyRules.corrupt)
    warnings.push(
      `${legacyRules.path} is not valid JSON — ignored, default rules used (fix or delete it)`,
    );
  if (agents.warning) warnings.push(agents.warning);
  if (selection.unknown.length)
    warnings.push(
      `unknown tool(s) in the tool selection ignored: ${selection.unknown.join(", ")} (known: ${KNOWN_TOOLS.join(", ")})`,
    );
  if (bytes > SIZE_BUDGET_BYTES)
    warnings.push(
      `canonical is ${bytes} B (> ${SIZE_BUDGET_BYTES} B budget) — trim source/rules.json`,
    );
  // Aggregate status (ME-19): sync writes AGENTS.md, then per-tool files, then MCP files
  // and is NOT transactional — a mid-way failure is recorded as an `action:"error"` row but
  // used to be reported per-target only, so a caller (init/CLI) could still imply every
  // tool is ready. Surface an explicit aggregate: if ANY target errored, the whole result
  // is PARTIAL. Callers must reflect PARTIAL rather than claim unconditional success.
  const partial = report.some((r) => r.action === "error");
  return {
    hash,
    bytes,
    report,
    warnings,
    // A backup is written only when a legacy file edited inside its generated text had to be
    // rewritten in full; a hand-written AGENTS.md is never moved aside any more.
    backedUp: Boolean(agents.backup),
    backup: agents.backup ?? null,
    tools: selection.tools,
    partial,
    status: partial ? "PARTIAL" : "OK",
  };
}

/** The assembled canonical body for a repo — same builder sync writes, so drift-check matches. */
export function canonical(targetRoot = process.cwd()) {
  return buildCanonical(targetRoot);
}

/**
 * Refresh ONLY forge's block in AGENTS.md when it no longer matches the canonical source.
 * The Stop hook calls this, so lessons/facts learned in a session reach every
 * AGENTS.md-reading tool immediately — not whenever someone remembers `forge sync`.
 * It never adopts a repo (no block → no write), never touches text outside the markers,
 * and never runs the full per-tool emit. The one other file it refreshes is Continue's
 * rules copy of the same body, and only when that forge-owned file already exists.
 * A legacy fully generated AGENTS.md is converted in place only when the conversion is
 * provably lossless; one edited inside its generated text is left for `forge sync`.
 * Kill switch: FORGE_AUTOSYNC=0.
 * @returns {{synced: boolean, reason: string}}
 */
export function autoSyncIfDrifted(targetRoot = process.cwd()) {
  if (process.env.FORGE_AUTOSYNC === "0") return { synced: false, reason: "disabled" };
  const body = buildCanonical(targetRoot);
  const status = agentsMdStatus(targetRoot, body);
  switch (status.state) {
    case "in-sync":
      return { synced: false, reason: "in sync" };
    case "missing":
    case "hand-written":
      return { synced: false, reason: "no managed AGENTS.md here" };
    case "legacy-edited":
      return {
        synced: false,
        reason:
          "legacy AGENTS.md edited inside its generated text — run `forge sync` to convert it",
      };
    case "damaged":
      return { synced: false, reason: "damaged Forge markers in AGENTS.md — fix them by hand" };
  }
  writeAgentsBlock(status, { allowBackup: false });
  const continueRules = join(targetRoot, ".continue", "rules", "00-forge.md");
  if (shared.isManaged(shared.readIfExists(continueRules)))
    shared.writeManaged(continueRules, shared.mdHeader(shared.hashContent(body)), body);
  return {
    synced: true,
    reason: status.state === "legacy" ? "converted to a Forge block" : "drifted — block refreshed",
  };
}
