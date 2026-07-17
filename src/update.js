// forge update — the missing self-update path. forgekit ships three ways (git checkout +
// install.sh symlink, npm global, Claude Code plugin); this module figures out which one
// is live and how to move it forward, plus a cached freshness check the doctor surfaces.
// FAIL-OPEN everywhere: no network, no upstream, detached HEAD, or a non-git install must
// never throw or nag — updating is opt-in, noticing is best-effort.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";

// The real npm name (scope included) for the `npm i -g` instruction — read, never guessed.
function npmName(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name || BRAND.pkg;
  } catch {
    return BRAND.pkg;
  }
}

function git(root, args) {
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

const isGitCheckout = (root) => git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";

// Fetch is the only network step — do it at most once an hour (FETCH_HEAD mtime), so a
// per-command doctor check never blocks on the network repeatedly.
function maybeFetch(root, { maxAgeMs = 3_600_000, now = Date.now() } = {}) {
  const fetchHead = join(root, ".git", "FETCH_HEAD");
  try {
    if (existsSync(fetchHead) && now - statSync(fetchHead).mtimeMs < maxAgeMs) return "cached";
  } catch {}
  try {
    execFileSync("git", ["fetch", "--quiet"], {
      cwd: root,
      stdio: "ignore",
      timeout: 8000,
    });
    return "fetched";
  } catch {
    return "offline";
  }
}

/**
 * How far behind upstream this install is. Never throws.
 * @param {{root?: string, fetch?: boolean, now?: number}} [opts]
 * @returns {{mode:string, behind:number, current:string, unknown?:boolean, network?:string, upstream?:string}}
 */
export function updateStatus({ root = BRAND.root, fetch = true, now = Date.now() } = {}) {
  const current = BRAND.version;
  if (!isGitCheckout(root)) {
    // Installed via npm (or a bare copy): can't diff commits — updating is `npm i -g`.
    return { mode: "npm-or-copy", behind: 0, current, unknown: true };
  }
  const network = fetch ? maybeFetch(root, { now }) : "skipped";
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) return { mode: "git", behind: 0, current, unknown: true, network };
  const count = git(root, ["rev-list", "--count", "HEAD..@{u}"]);
  const behind = Number(count) || 0;
  return { mode: "git", behind, current, network, upstream };
}

/**
 * Apply an update for the live install mode. git checkout → ff-only pull (symlink/npm-link
 * installs go live immediately); npm/copy → hand back the install command.
 * @param {{root?: string}} [opts]
 */
export function applyUpdate({ root = BRAND.root } = {}) {
  if (!isGitCheckout(root))
    return {
      ok: false,
      mode: "npm-or-copy",
      instruction: `npm install -g ${npmName(root)}`,
      reason: "not a git checkout — update via npm",
    };
  maybeFetch(root, { maxAgeMs: 0 }); // force a fresh fetch before pulling
  try {
    const before = git(root, ["rev-parse", "HEAD"]);
    execSync("git pull --ff-only", {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const after = git(root, ["rev-parse", "HEAD"]);
    return {
      ok: true,
      mode: "git",
      changed: before !== after,
      before: before.slice(0, 8),
      after: after.slice(0, 8),
      note: "symlink/npm-link installs are already live; a plugin install re-reads on next launch",
    };
  } catch (e) {
    return {
      ok: false,
      mode: "git",
      reason: "git pull --ff-only failed (diverged or offline) — resolve manually",
      detail: String(e.message || e).slice(-200),
    };
  }
}

/**
 * Pin or downgrade the live install to an exact released version. Git checkout:
 * fetch tags (best-effort — the tag may already be local), verify the release tag
 * exists, then a detached checkout with a note on how to get back to latest.
 * npm/copy installs get the exact `npm i -g <pkg>@<version>` instruction instead.
 * Never throws — a missing tag or a dirty tree is an honest `{ok:false, reason}`.
 * @param {string} version - target version, with or without a leading "v"
 * @param {{root?: string}} [opts]
 * @returns {{ok:boolean, mode:string, tag?:string, changed?:boolean, before?:string,
 *   after?:string, note?:string, instruction?:string, reason?:string, detail?:string}}
 */
export function applyUpdateTo(version, { root = BRAND.root } = {}) {
  const want = String(version ?? "")
    .trim()
    .replace(/^v/, "");
  // Empty or flag-shaped (`--to --json`) input: fail before touching git at all.
  if (!want || want.startsWith("-"))
    return {
      ok: false,
      mode: "none",
      reason: `missing version — usage: \`${BRAND.cli} update --to <version>\` (e.g. --to 0.17.0)`,
    };
  if (!isGitCheckout(root))
    return {
      ok: false,
      mode: "npm-or-copy",
      instruction: `npm install -g ${npmName(root)}@${want}`,
      reason: "not a git checkout — pin via npm",
    };
  try {
    execFileSync("git", ["fetch", "--tags", "--quiet"], {
      cwd: root,
      stdio: "ignore",
      timeout: 8000,
    });
  } catch {} // offline / no remote is fine — the tag may already be local
  // Release tags here are `vX.Y.Z`, but accept a bare `X.Y.Z` tag too.
  const tag = [`v${want}`, want].find((t) =>
    git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${t}^{commit}`]),
  );
  if (!tag)
    return {
      ok: false,
      mode: "git",
      reason: `no release tag v${want} found (tags fetched) — see \`git tag\` for available versions`,
    };
  const before = git(root, ["rev-parse", "HEAD"]);
  try {
    execFileSync("git", ["checkout", "--quiet", "--detach", tag], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    return {
      ok: false,
      mode: "git",
      reason: "checkout failed (uncommitted changes?) — stash or commit, then retry",
      detail: String(e.message || e).slice(-200),
    };
  }
  const after = git(root, ["rev-parse", "HEAD"]);
  return {
    ok: true,
    mode: "git",
    tag,
    changed: before !== after,
    before: before.slice(0, 8),
    after: after.slice(0, 8),
    note: `detached at ${tag} — \`git checkout <branch>\` then \`${BRAND.cli} update\` returns to latest`,
  };
}
