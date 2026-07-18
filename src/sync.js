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
import windsurf from "./emit/windsurf.js";
import zed from "./emit/zed.js";
import { managedMcpState } from "./integrations.js";
import { LEGACY_PROFILES, readForgeConfig } from "./repo_config.js";

const MODULES = [codex, cursor, copilot, windsurf, zed, claude, gemini, aider, continueTool];

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
  const override = join(targetRoot, ".forge/rules.json");
  if (existsSync(override)) {
    const extra = JSON.parse(readFileSync(override, "utf8"));
    base.sections = [...(base.sections || []), ...(extra.sections || [])];
  }
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

export function sync({ targetRoot = process.cwd() } = {}) {
  // Inline portable memory + learned lessons so every AGENTS.md-reading tool shares them.
  const canonical = buildCanonical(targetRoot);
  const hash = shared.hashContent(canonical);
  const bytes = Buffer.byteLength(canonical);

  // The shared AGENTS.md — read directly by Codex, Cursor, Copilot, Windsurf, Zed.
  // If the repo already has a hand-written (unmanaged) AGENTS.md, never destroy it
  // silently — back it up first so no rules are lost when adopting Forge.
  const agentsPath = join(targetRoot, "AGENTS.md");
  const existingAgents = shared.readIfExists(agentsPath);
  const backedUp = existingAgents !== null && !shared.isManaged(existingAgents);
  if (backedUp) writeFileSync(`${agentsPath}.forge-bak`, existingAgents);
  const agentsAction = shared.writeManaged(agentsPath, shared.mdHeader(hash), canonical);

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
      action: agentsAction,
      note: `${bytes} B`,
    },
  ];
  for (const mod of MODULES) {
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
  // tool's MCP config (real formats). Sharing managedMcpState with `integrations add`
  // means sync can never drop a server that add installed, and vice versa (RA-03). A
  // corrupt repo config falls back to registry-only with a warning — never treated as
  // "no integrations installed, overwrite everything".
  const warnings = [];
  const mcpFile = join(BRAND.root, "source", "mcp.json");
  if (existsSync(mcpFile)) {
    try {
      const { servers, owned, warning } = managedMcpState(targetRoot);
      if (warning) warnings.push(warning);
      for (const row of emitMcp({ targetRoot, servers, owned })) report.push(row);
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
  const cfg = loadConfig(targetRoot);
  if (cfg.corrupt)
    warnings.push(
      `${cfg.path} is not valid JSON — config ignored, default rules used (fix or delete it)`,
    );
  if (backedUp)
    warnings.push(
      "existing AGENTS.md was not Forge-managed — backed up to AGENTS.md.forge-bak; move any custom rules into source/rules.json or a per-repo .forge/rules.json",
    );
  if (bytes > SIZE_BUDGET_BYTES)
    warnings.push(
      `canonical is ${bytes} B (> ${SIZE_BUDGET_BYTES} B budget) — trim source/rules.json`,
    );
  return { hash, bytes, report, warnings, backedUp };
}

/** The assembled canonical body for a repo — same builder sync writes, so drift-check matches. */
export function canonical(targetRoot = process.cwd()) {
  return buildCanonical(targetRoot);
}

/**
 * Re-run sync ONLY when the managed AGENTS.md no longer matches the canonical source.
 * The Stop hook calls this, so lessons/facts learned in a session reach every
 * AGENTS.md-reading tool immediately — not whenever someone remembers `forge sync`
 * (nothing did before: doctor DETECTED drift but nothing repaired it).
 * Never adopts a repo: AGENTS.md must already exist AND be Forge-managed.
 * Kill switch: FORGE_AUTOSYNC=0.
 * @returns {{synced: boolean, reason: string}}
 */
export function autoSyncIfDrifted(targetRoot = process.cwd()) {
  if (process.env.FORGE_AUTOSYNC === "0") return { synced: false, reason: "disabled" };
  const existing = shared.readIfExists(join(targetRoot, "AGENTS.md"));
  if (existing === null || !shared.isManaged(existing))
    return { synced: false, reason: "no managed AGENTS.md here" };
  // Full-byte comparison against the exact content sync would write (RA-16): the embedded
  // marker hash alone proves nothing — a hand-edited body with an intact marker must
  // still count as drift. managedContent is the same helper writeManaged writes through,
  // so the two paths cannot diverge again.
  const body = buildCanonical(targetRoot);
  const expected = shared.managedContent(shared.mdHeader(shared.hashContent(body)), body);
  if (existing === expected) return { synced: false, reason: "in sync" };
  sync({ targetRoot });
  return { synced: true, reason: "drifted — resynced" };
}
