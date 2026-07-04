// forge sync — compile the one canonical source (source/rules.json, plus an
// optional per-repo .forge/rules.json) into every tool's native config target.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import * as shared from './emit/_shared.js';

import claude from './emit/claude.js';
import codex from './emit/codex.js';
import cursor from './emit/cursor.js';
import gemini from './emit/gemini.js';
import aider from './emit/aider.js';
import copilot from './emit/copilot.js';
import windsurf from './emit/windsurf.js';
import zed from './emit/zed.js';

const MODULES = [codex, cursor, copilot, windsurf, zed, claude, gemini, aider];

// Soft budget: Codex hard-truncates at 32 KiB, Windsurf caps ~12k chars. Warn early.
const SIZE_BUDGET_BYTES = 12 * 1024;

/** Turn the rules object into the canonical AGENTS.md markdown body. */
export function assemble(rules) {
  const out = [`# AGENTS.md — ${rules.title || 'engineering rules'}`, ''];
  if (rules.intro) out.push(rules.intro, '');
  for (const section of rules.sections || []) {
    out.push(`## ${section.title}`);
    for (const rule of section.rules || []) out.push(`- ${rule}`);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

function loadRules(targetRoot) {
  const base = JSON.parse(readFileSync(join(BRAND.root, 'source/rules.json'), 'utf8'));
  const override = join(targetRoot, '.forge/rules.json');
  if (existsSync(override)) {
    const extra = JSON.parse(readFileSync(override, 'utf8'));
    base.sections = [...(base.sections || []), ...(extra.sections || [])];
  }
  return base;
}

export function sync({ targetRoot = process.cwd() } = {}) {
  const rules = loadRules(targetRoot);
  const canonical = assemble(rules);
  const hash = shared.hashContent(canonical);
  const bytes = Buffer.byteLength(canonical);

  // The shared AGENTS.md — read directly by Codex, Cursor, Copilot, Windsurf, Zed.
  const agentsPath = join(targetRoot, 'AGENTS.md');
  const agentsAction = shared.writeManaged(agentsPath, shared.mdHeader(hash), canonical);

  const ctx = { targetRoot, canonical, hash, bytes, chars: canonical.length, agentsPath, shared, join };
  const report = [{ tool: 'shared source', target: 'AGENTS.md', action: agentsAction, note: `${bytes} B` }];
  for (const mod of MODULES) {
    try { report.push(mod.emit(ctx)); }
    catch (err) { report.push({ tool: mod.tool, target: '-', action: 'error', note: err.message }); }
  }

  const warnings = [];
  if (bytes > SIZE_BUDGET_BYTES) warnings.push(`canonical is ${bytes} B (> ${SIZE_BUDGET_BYTES} B budget) — trim source/rules.json`);
  return { hash, bytes, report, warnings };
}
