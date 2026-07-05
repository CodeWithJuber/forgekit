// forge preflight — the assumption detector. Before the agent spends a token, scan the task
// for code identifiers/files it NAMES but the repo doesn't DEFINE — those are the things it
// will silently ASSUME (the user's "biggest problem"). Plus vague wording with no acceptance
// criteria. Surface the known-unknowns so the agent ASKS instead of confabulating.
// PURE logic here (no fs) so it's fully testable; the repo wrapper (bottom) adds atlas + file checks.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build as buildAtlas, has, load as loadAtlas } from "./atlas.js";

const CODE_EXT =
  /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|json|ya?ml|toml|md|css|scss|html|vue|svelte)$/i;

// Very common words that look like identifiers but aren't worth grounding.
const STOP = new Set([
  "the",
  "this",
  "that",
  "add",
  "fix",
  "make",
  "use",
  "code",
  "file",
  "test",
  "error",
  "errors",
  "function",
  "class",
  "value",
  "data",
  "type",
  "name",
  "todo",
  "note",
]);

const isCodeIdent = (p, backticked) => {
  if (!p || p.length < 2) return false;
  if (STOP.has(p.toLowerCase())) return false;
  if (backticked) return /^[A-Za-z_$][\w$]*$/.test(p); // trust anything quoted as code
  // bare tokens must LOOK like code: camelCase, snake_case, or Pascal+camel
  return (
    /[a-z][A-Z]/.test(p) || (p.includes("_") && /[a-z]/i.test(p)) || /^[A-Z][a-z]+[A-Z]/.test(p)
  );
};

/** Pure: pull the code identifiers + file paths a task references. */
export function referencedEntities(text) {
  const s = String(text);
  const symbols = new Set();
  const files = new Set();
  const consider = (raw, backticked) => {
    const tok = raw
      .trim()
      .replace(/\(\)$/, "")
      .replace(/[.,;:]+$/, "");
    if (!tok) return;
    if (tok.includes("/") || CODE_EXT.test(tok)) {
      files.add(tok);
      return;
    }
    for (const part of tok.split(".").filter(Boolean)) {
      if (isCodeIdent(part, backticked)) symbols.add(part);
    }
  };
  for (const m of s.matchAll(/`([^`]+)`/g)) {
    for (const t of m[1].split(/\s+/)) consider(t, true);
  }
  for (const m of s.matchAll(/[A-Za-z_$][\w$./-]*/g)) {
    const t = m[0];
    if (t.includes("/") || CODE_EXT.test(t) || /[a-z][A-Z]/.test(t) || t.includes("_")) {
      consider(t, false);
    }
  }
  return { symbols: [...symbols], files: [...files] };
}

const AMBIGUITY = [
  /\bsome(how|thing)?\b/i,
  /\betc\.?\b/i,
  /\band so on\b/i,
  /\bas needed\b/i,
  /\bappropriate(ly)?\b/i,
  /\bproper(ly)?\b/i,
  /\ba few\b/i,
  /\bseveral\b/i,
  /\bmake it work\b/i,
  /\bhandle (the )?errors?\b/i,
  /\bvarious\b/i,
  /\band more\b/i,
];

/** Pure: vague phrases that signal missing acceptance criteria. */
export function ambiguityMarkers(text) {
  const out = [];
  for (const re of AMBIGUITY) {
    const m = String(text).match(re);
    if (m) out.push(m[0].trim().toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * Pure: the information gap — unresolved references + ambiguity, normalized to [0,1].
 * @param {string} text
 * @param {{hasSymbol?:(name:string)=>boolean, fileExists?:(path:string)=>boolean}} [deps]
 */
export function informationGap(text, deps = {}) {
  const { hasSymbol = () => false, fileExists = () => false } = deps;
  const { symbols, files } = referencedEntities(text);
  const ambiguous = ambiguityMarkers(text);
  const unresolvedSymbols = symbols.filter((s) => !hasSymbol(s));
  const unresolvedFiles = files.filter((f) => !fileExists(f));
  const problems = unresolvedSymbols.length + unresolvedFiles.length + ambiguous.length;
  const denom = symbols.length + files.length + ambiguous.length;
  const gap = denom === 0 ? 0 : Math.min(1, problems / denom);
  return {
    gap,
    unresolved: { symbols: unresolvedSymbols, files: unresolvedFiles },
    ambiguous,
    entities: { symbols, files },
  };
}

/**
 * Pure: render the clarify prompt — or "" when nothing needs clarifying. A single unresolved
 * concrete reference always clarifies (high value); pure ambiguity needs to clear the threshold.
 */
export function clarifyBlock(result, { threshold = 0.5 } = {}) {
  const nRef = result.unresolved.symbols.length + result.unresolved.files.length;
  if (nRef === 0 && result.gap < threshold) return "";
  const lines = [
    "## Before starting — clarify (Forge Preflight)",
    "This task names things that aren't grounded in the codebase. Confirm before assuming:",
    "",
  ];
  for (const s of result.unresolved.symbols) {
    lines.push(`- \`${s}\` — not found in the code. Different name, or should it be created?`);
  }
  for (const f of result.unresolved.files) {
    lines.push(`- \`${f}\` — file not found. Confirm the path, or that it's new.`);
  }
  if (result.ambiguous.length) {
    lines.push(
      `- Ambiguous: ${result.ambiguous.map((a) => `"${a}"`).join(", ")} — state the concrete acceptance criteria.`,
    );
  }
  lines.push("", "_Advisory: ask rather than assume._");
  return lines.join("\n");
}

/**
 * Repo wrapper: gap against the real atlas + filesystem. In hooks pass `allowBuild:false` so we
 * only use a CACHED atlas (fast, and if none exists we skip symbol-flagging rather than
 * false-alarm on an unindexed repo); the explicit CLI builds it.
 */
export function preflightRepo(root, text, { allowBuild = true } = {}) {
  const atlas = loadAtlas(root) || (allowBuild ? buildAtlas({ root }) : null);
  return informationGap(text, {
    hasSymbol: atlas ? (name) => has(atlas, name) : () => true,
    fileExists: (f) => existsSync(join(root, f)),
  });
}
