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
//
// SECURITY guards are the exception to "exit 1": for a PreToolUse guard, exit 1 lets the tool call
// through, so a guard that cannot run would be silently OFF. A fail-closed guard (GUARD_POLICY, or
// `--fail-closed` before the guard path) turns every failure to reach a verdict — no interpreter, a
// spawn error, a signal, an exit other than 0/2 — into exit 2: a block, with the reason on stderr.
// protect-paths also skips bash entirely: its `.sh` is a thin launcher over a Node twin, which runs
// on this very node, so the guard works where bash does not.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const NO_BASH_HINT =
  "no bash found to run the hook guards — install Git for Windows (bash ships with it) or point " +
  "FORGE_BASH (or CLAUDE_CODE_GIT_BASH_PATH) at your bash executable";

/**
 * Windows dirs that ship a `bash.exe` which is NOT Git Bash: the WSL launcher in System32,
 * and the Store app-execution aliases in `…\Microsoft\WindowsApps` (a zero-byte reparse
 * point for the same WSL launcher — picking it made every guard exit 127, i.e. fail open).
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} env
 */
function isSystemDir(dir, env) {
  /** @param {string} p */
  const norm = (p) => String(p).toLowerCase().replaceAll("/", "\\").replace(/\\+$/, "");
  const d = norm(dir);
  if (d.endsWith("\\microsoft\\windowsapps")) return true;
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
 * Guards the launcher treats specially, keyed by basename.
 *  - `node`: the `.sh` is only a thin launcher over this same-directory Node twin, so the twin
 *    runs on THIS node and bash leaves the path (one process fewer on every tool call, too).
 *  - `failClosed`: a PreToolUse security guard; failing to reach a verdict blocks (exit 2).
 * @type {Record<string, {node?: string, failClosed?: boolean}>}
 */
export const GUARD_POLICY = {
  "protect-paths.sh": { node: "protect-paths.mjs", failClosed: true },
};

/**
 * Run a guard with inherited stdio and return the exit code to report: `bash <script> …args`, or
 * `node <twin.mjs> …args` for a guard with a Node twin. `--fail-closed` before the script (or
 * GUARD_POLICY) turns every launcher-level failure into a block. `deps` are test seams.
 * @param {string[]} argv `[--fail-closed] guardScript ...guardArgs`
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{spawn?: typeof spawnSync, locateBash?: typeof resolveBash, exists?: (p: string) => boolean}} [deps]
 * @returns {number}
 */
export function runGuard(
  argv,
  env = process.env,
  { spawn = spawnSync, locateBash = resolveBash, exists = existsSync } = {},
) {
  const self = basename(fileURLToPath(import.meta.url));
  const args = [...argv];
  let failClosed = false;
  while (args[0] === "--fail-closed") {
    failClosed = true;
    args.shift();
  }
  const [script, ...rest] = args;
  if (!script) {
    process.stderr.write(`${self}: usage: node ${self} [--fail-closed] <guard.sh> [args…]\n`);
    return 1;
  }
  const guard = basename(toPosix(script));
  const policy = GUARD_POLICY[guard.toLowerCase()] ?? {};
  failClosed ||= Boolean(policy.failClosed);
  /** @param {string} why */
  const failed = (why) => {
    if (!failClosed) {
      process.stderr.write(`${self}: ${why}\n`);
      return 1;
    }
    process.stderr.write(
      `BLOCKED by ${guard} (fail-closed): ${why} — a security guard that cannot reach a verdict blocks the tool call.\n`,
    );
    return 2;
  };
  const twin = policy.node ? join(dirname(script), policy.node) : "";
  let cmd = process.execPath;
  let cmdArgs = [twin, ...rest];
  if (!twin || !exists(twin)) {
    const { path } = locateBash({ env });
    if (!path) return failed(NO_BASH_HINT);
    cmd = path;
    cmdArgs = [toPosix(script), ...rest];
  }
  const r = spawn(cmd, cmdArgs, { stdio: "inherit", env, windowsHide: true });
  if (r.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (r.error).code;
    return failed(code === "ENOENT" && cmd !== process.execPath ? NO_BASH_HINT : r.error.message);
  }
  // A signal-killed guard has no status: a visible non-blocking error (1) or, fail-closed, a block.
  if (r.status === null) return failed(`the guard was killed by ${r.signal ?? "a signal"}`);
  if (failClosed && r.status !== 0 && r.status !== 2) return failed(`the guard exited ${r.status}`);
  return r.status;
}

// Run only as the hook entrypoint (`node run.mjs …`). Importing it (doctor, tests) must not spawn
// anything — and the check is by basename, so a `~/.forge` symlink install cannot fool it.
const invokedAs = process.argv[1] ? basename(process.argv[1]).toLowerCase() : "";
if (invokedAs === basename(fileURLToPath(import.meta.url)).toLowerCase()) {
  process.exitCode = runGuard(process.argv.slice(2));
}
