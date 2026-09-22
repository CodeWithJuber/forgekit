// forge .gitignore block manager — owns ONLY a marked block inside <root>/.gitignore
// and never touches a user's own lines. The block is delimited by begin/end markers
// (marker discipline mirrors emit/_shared.js): everything between the markers is
// Forge's to rewrite, everything outside is the user's and is preserved byte-for-byte.
// Writes follow the writeIfChanged contract — identical content is a no-op, so calling
// ensureGitignoreBlock repeatedly is idempotent. removeGitignoreBlock reverses it,
// stripping the block alone. This lets `forge tools` hide secondary-tool artifacts
// (.cursor/, .gemini/, …) for a repo that only uses one agent, reversibly.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";

export const BEGIN = "# forge:gitignore:begin";
export const END = "# forge:gitignore:end";
const NOTE = "# secondary-tool artifacts — managed by `forge tools`; edit lines OUTSIDE this block";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Matches the whole managed block including a single trailing newline if present.
const blockRe = () => new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`);

/** Normalize the requested paths: trim, drop blanks, dedupe, sort (order-stable). */
function normalize(paths) {
  const seen = new Set();
  for (const p of paths || []) {
    const t = typeof p === "string" ? p.trim() : "";
    if (t) seen.add(t);
  }
  return [...seen].sort();
}

const buildBlock = (paths) => [BEGIN, NOTE, ...paths, END].join("\n");

const gitignorePath = (root) => join(root, ".gitignore");

/**
 * Write or update the managed block in <root>/.gitignore so it lists exactly `paths`.
 * Replaces the content between the markers in place when the block already exists, else
 * appends the block (keeping any missing trailing newline honest). Empty `paths` removes
 * the block entirely. No-op when the resulting file is byte-identical.
 * @param {string} root
 * @param {string[]} paths exact target strings (e.g. from sync()'s report rows)
 * @returns {{action:"written"|"unchanged"|"removed", path:string, paths:string[]}}
 */
export function ensureGitignoreBlock(root, paths) {
  const rel = normalize(paths);
  if (rel.length === 0) {
    const r = removeGitignoreBlock(root);
    return { ...r, paths: [] };
  }
  const file = gitignorePath(root);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = buildBlock(rel);
  const re = blockRe();
  let next;
  if (re.test(existing)) {
    next = existing.replace(re, `${block}\n`);
  } else if (existing === "") {
    next = `${block}\n`;
  } else {
    // Preserve user lines; guarantee a newline boundary before the block.
    const sep = existing.endsWith("\n") ? "" : "\n";
    next = `${existing}${sep}${block}\n`;
  }
  if (next === existing) return { action: "unchanged", path: file, paths: rel };
  writeFileSync(file, next);
  return { action: "written", path: file, paths: rel };
}

/**
 * Strip ONLY the managed block from <root>/.gitignore, leaving every user line intact.
 * @param {string} root
 * @returns {{action:"removed"|"unchanged", path:string}}
 */
export function removeGitignoreBlock(root) {
  const file = gitignorePath(root);
  if (!existsSync(file)) return { action: "unchanged", path: file };
  const existing = readFileSync(file, "utf8");
  const next = existing.replace(blockRe(), "");
  if (next === existing) return { action: "unchanged", path: file };
  writeFileSync(file, next);
  return { action: "removed", path: file };
}

// Per-session hook logs (raw prompts and shell commands) under .forge/sessions/ are local
// runtime state that must never reach git, and .forge/cache/ holds derived HTTP responses
// (model catalogs) that are re-fetched on demand. A repo may deliberately commit OTHER .forge/
// content (the ledger, decisions.md), so rather than rewrite the user's root .gitignore
// the tool owns a nested .forge/.gitignore listing only its private runtime dirs.
export const FORGE_PRIVATE_DIRS = ["sessions/", "cache/"];

/**
 * Ensure `<root>/.forge/.gitignore` ignores every FORGE_PRIVATE_DIRS entry. Appends only
 * the missing lines and keeps anything already there; identical content is a no-op.
 * @param {string} root
 * @returns {{action:"written"|"unchanged", path:string}}
 */
export function ensureForgePrivateIgnored(root) {
  const dir = join(root, ".forge");
  const file = join(dir, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")));
  const missing = FORGE_PRIVATE_DIRS.filter((p) => !have.has(p) && !have.has(p.slice(0, -1)));
  if (!missing.length) return { action: "unchanged", path: file };
  const lead = existing
    ? existing.endsWith("\n")
      ? ""
      : "\n"
    : `# ${BRAND.brand} runtime state — never committed (written by \`${BRAND.cli} init\`)\n`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${existing}${lead}${missing.join("\n")}\n`);
  return { action: "written", path: file };
}

/**
 * The paths currently listed in the managed block (comment/marker lines excluded).
 * Empty array when there is no block.
 * @param {string} root
 * @returns {string[]}
 */
export function readGitignoreBlock(root) {
  const file = gitignorePath(root);
  if (!existsSync(file)) return [];
  const m = readFileSync(file, "utf8").match(blockRe());
  if (!m) return [];
  return m[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== BEGIN && l !== END && !l.startsWith("#"));
}
