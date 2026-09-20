#!/usr/bin/env node
// Forge hook launcher — runs a bash guard from an exec-form Claude Code hook on every OS.
//
// Why this exists: exec-form hooks (`command` + `args`) are spawned directly — no shell, just a
// plain PATH lookup of `command`. Forge's hooks were `command: "bash"`. On Windows, Git for Windows
// puts `git.exe` on PATH (`Git\cmd`) but NOT `bash.exe` (`Git\bin`, `Git\usr\bin`), so every hook
// — SessionStart first — died with `spawn bash ENOENT` before a guard ever ran. `node` IS a real
// executable on PATH wherever this package is installed, so hooks now spawn
// `node run.mjs <guard.sh> [args…]` and THIS file finds bash: $FORGE_BASH, Claude Code's own
// $CLAUDE_CODE_GIT_BASH_PATH, the Git for Windows install that owns the `git` on PATH, the standard
// install dirs, then PATH itself — skipping the WSL launcher in System32, which is not Git Bash.
// POSIX is unchanged: `bash` from PATH, exactly as before.
//
// It must never weaken a guard: stdin (the hook JSON), stdout (SessionStart context,
// `updatedToolOutput`) and stderr are inherited untouched, and bash's exit code is returned
// verbatim — a guard's exit 2 still blocks. With no bash anywhere it prints ONE actionable line and
// exits 1: the same visible, non-blocking hook error the ENOENT was, minus the mystery. Node
// built-ins only — a launcher that itself failed to load would be exactly the silent no-op the
// guards exist to prevent.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const NO_BASH_HINT =
  "no bash found to run the hook guards — install Git for Windows (bash ships with it) or point " +
  "FORGE_BASH (or CLAUDE_CODE_GIT_BASH_PATH) at your bash executable";

/**
 * Windows dirs that ship a `bash.exe` which is NOT Git Bash (the WSL launcher in System32).
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} env
 */
function isSystemDir(dir, env) {
  /** @param {string} p */
  const norm = (p) => String(p).toLowerCase().replaceAll("/", "\\").replace(/\\+$/, "");
  const d = norm(dir);
  return [env.SystemRoot, env.windir, "C:\\Windows"]
    .filter(Boolean)
    .some((r) => d === norm(r) || d.startsWith(`${norm(r)}\\`));
}

/**
 * Locate the bash that runs the guards. `path` is what to spawn (`null` when nothing usable
 * exists); `via` says how it was found (doctor prints it). Pure — env, platform and the
 * filesystem probe are injectable, so the Windows logic is unit-tested on every OS.
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {{ path: string | null, via: string }}
 */
export function resolveBash({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  // 1. Explicit overrides win on every OS: FORGE_BASH (ours), then CLAUDE_CODE_GIT_BASH_PATH —
  //    Claude Code's own setting for the same problem (portable Git, MSYS2, a custom prefix).
  /** @type {[string, string | undefined][]} */
  const overrides = [
    ["FORGE_BASH", env.FORGE_BASH],
    ["CLAUDE_CODE_GIT_BASH_PATH", env.CLAUDE_CODE_GIT_BASH_PATH],
  ];
  for (const [via, p] of overrides) if (p && exists(p)) return { path: p, via };
  // 2. POSIX: bash from PATH, exactly as the hooks always did (spawn reports ENOENT if absent).
  if (platform !== "win32") return { path: "bash", via: "PATH" };
  // 3. Windows — Windows path semantics regardless of the host running this logic (tests).
  const P = win32;
  const pathDirs = String(env.PATH ?? env.Path ?? "")
    .split(P.delimiter)
    .filter(Boolean);
  const seen = new Set();
  /** @type {string[]} */
  const candidates = [];
  /** @param {string} p */
  const add = (p) => {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      candidates.push(p);
    }
  };
  // 3a. The Git for Windows install that owns the `git` on PATH: a default install exposes
  //     `Git\cmd\git.exe` only; its siblings `Git\bin\bash.exe` / `Git\usr\bin\bash.exe` are the
  //     bash the guards need. Also covers `Git\bin` or `Git\mingw64\bin` being the PATH entry.
  for (const dir of pathDirs) {
    if (isSystemDir(dir, env) || !exists(P.join(dir, "git.exe"))) continue;
    const root = P.dirname(dir);
    for (const r of [root, P.dirname(root)]) {
      add(P.join(r, "bin", "bash.exe"));
      add(P.join(r, "usr", "bin", "bash.exe"));
    }
  }
  // 3b. Standard install dirs: system-wide, per-user, scoop.
  for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]]) {
    if (base) add(P.join(base, "Git", "bin", "bash.exe"));
  }
  if (env.LOCALAPPDATA) add(P.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  if (env.USERPROFILE)
    add(P.join(env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe"));
  for (const p of candidates) if (exists(p)) return { path: p, via: "git-for-windows" };
  // 3c. A bash.exe on PATH — but never the WSL launcher in System32.
  for (const dir of pathDirs) {
    if (isSystemDir(dir, env)) continue;
    const p = P.join(dir, "bash.exe");
    if (exists(p)) return { path: p, via: "PATH" };
  }
  return { path: null, via: "none" };
}

/**
 * `${CLAUDE_PLUGIN_ROOT}` is substituted as a native `C:\…` string on Windows; Git Bash's
 * `dirname`/`cd` are happiest with forward slashes. No-op on POSIX.
 * @param {string} p
 */
const toPosix = (p) => String(p).replaceAll("\\", "/");

/**
 * Spawn `bash <script> …args` with inherited stdio and return the exit code to report.
 * @param {string[]} argv `[guardScript, ...guardArgs]`
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function runGuard(argv, env = process.env) {
  const self = basename(fileURLToPath(import.meta.url));
  const [script, ...rest] = argv;
  if (!script) {
    process.stderr.write(`${self}: usage: node ${self} <guard.sh> [args…]\n`);
    return 1;
  }
  const { path } = resolveBash({ env });
  if (!path) {
    process.stderr.write(`${self}: ${NO_BASH_HINT}\n`);
    return 1;
  }
  const r = spawnSync(path, [toPosix(script), ...rest], {
    stdio: "inherit",
    env,
    windowsHide: true,
  });
  if (r.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (r.error).code;
    process.stderr.write(`${self}: ${code === "ENOENT" ? NO_BASH_HINT : r.error.message}\n`);
    return 1;
  }
  // A signal-killed guard has no status: 1 keeps it a visible non-blocking error, never a block.
  return r.status ?? 1;
}

// Run only as the hook entrypoint (`node run.mjs …`). Importing it (doctor, tests) must not spawn
// anything — and the check is by basename, so a `~/.forge` symlink install cannot fool it.
const invokedAs = process.argv[1] ? basename(process.argv[1]).toLowerCase() : "";
if (invokedAs === basename(fileURLToPath(import.meta.url)).toLowerCase()) {
  process.exitCode = runGuard(process.argv.slice(2));
}
