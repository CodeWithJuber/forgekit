// forge util — shared micro-utilities. Extracted from duplicated copies across
// cortex.js, recall.js, cortex_hook.js, doctor.js, harden.js, route.js, adjudicate.js,
// scope.js, atlas.js, preflight.js, and cortex_hook_main.js.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Filesystem- and id-safe slug. Unicode-aware: letters, marks and digits of ANY script
 * survive (NFKC-normalized, lower-cased), so "مفتاح الواجهة" and "数据库地址" get distinct
 * slugs — an ASCII-only class turned every non-Latin name into "" and every caller's
 * fallback then collided them (two facts, one "fact" slug). A name with no letter or digit
 * at all (emoji, punctuation) falls back to a short content hash, so distinct names still
 * never collide; blank input stays "" for the callers' own fallbacks. ASCII input slugs
 * exactly as before.
 * @param {unknown} s
 * @returns {string}
 */
export const slug = (s) => {
  const text = String(s ?? "");
  const out = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
  if (out || !text.trim()) return out;
  return `h-${contentHash(text).slice(0, 10)}`;
};

/** Clamp to [0,1]. NaN and non-numeric input fail to 0 — Math.max/min would pass NaN
 *  straight through, and one NaN poisons every score it touches. */
export const clamp01 = (x) => {
  const n = Number(x);
  return n > 0 ? (n < 1 ? n : 1) : 0;
};

// Normalize a path to POSIX separators. Node's path.relative()/join() emit `\` on Windows,
// but the graph/atlas/scope layers use repo-relative paths as MAP KEYS, NODE IDS, and values
// compared against `/`-joined strings (in code and tests). Backslash keys silently miss those
// lookups on Windows. Canonicalizing to `/` makes every comparison portable; it's a no-op on
// POSIX (no `\` in the path) and safe on Windows (fs/join accept `/`).
export const toPosix = (p) => String(p).replaceAll("\\", "/");

/** `s` without its trailing slashes. A backward scan, not `/\/+$/`: that regex backtracks
 *  quadratically on a long run of slashes followed by anything else (polynomial ReDoS). */
export function stripTrailingSlashes(s) {
  const t = String(s ?? "");
  let end = t.length;
  while (end > 0 && t.charCodeAt(end - 1) === 47) end--;
  return t.slice(0, end);
}

export const MS_PER_DAY = 86400000;
export const epochDay = () => Math.floor(Date.now() / MS_PER_DAY);

// Legacy-store retirement (ROADMAP): the PCM ledger is the convergent WRITE store
// (dual-write via ledger_bridge since P1) and serves the read view (ledger_read). The
// ledger is now the DEFAULT and only store — legacy files (lessons/*.md, recall/brain
// fact files) are no longer written or read. Set FORGE_LEDGER_ONLY=0 (the one-release
// escape hatch) to restore the legacy file store while external tooling migrates.
export const ledgerOnly = () =>
  process.env.FORGE_LEDGER_ONLY !== "0" && process.env.FORGE_LEDGER_ONLY !== "false";

export function hasBin(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Run a read-only git command in `root`; return trimmed stdout, or "" on ANY failure
 *  (stderr silenced). Consolidated from four byte-identical copies (session/handoff/
 *  update/docs_check). Deliberately-divergent variants stay local: verify.js uses a
 *  different arg order and logs stderr under FORGE_DEBUG; docs_sync/docs_impact keep
 *  raw (un-trimmed) output on purpose. */
export function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Parse a JSON file, returning null on a missing/corrupt file instead of throwing —
 *  one bad file must never take down the caller. (Distinct from a strict parse that
 *  should surface a bad config; those callers keep their own throwing readJson.) */
export function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

let cachedAuthor;
/** The identity stamped on ledger provenance/evidence — FORGE_AUTHOR env override,
 *  else the git identity, else "" (attribution is best-effort, never a hard fail).
 *  Cached per process: hooks call this per event and `git config` is a subprocess. */
export function gitAuthor() {
  if (process.env.FORGE_AUTHOR !== undefined) return process.env.FORGE_AUTHOR;
  if (cachedAuthor !== undefined) return cachedAuthor;
  try {
    const get = (k) =>
      execFileSync("git", ["config", "--get", k], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    const name = get("user.name");
    const email = get("user.email");
    cachedAuthor = email ? `${name} <${email}>` : name;
  } catch {
    cachedAuthor = "";
  }
  return cachedAuthor;
}

export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  "__pycache__",
  ".forge",
  "coverage",
  ".venv",
  "vendor",
]);

export const SRC_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py)$/;

export const CODE_EXT =
  /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|json|ya?ml|toml|md|css|scss|html|vue|svelte)$/i;
