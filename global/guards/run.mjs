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
// It must never weaken a guard: stdin (the hook JSON) and stderr are inherited untouched,
// stdout is captured only so the hook token budget (hooks/budget.json) can cap what gets
// injected into context — a guard's BLOCK verdict (exit 2) is never truncated — and bash's
// exit code is returned verbatim. With no bash anywhere it prints ONE actionable line and
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
import { existsSync, readFileSync } from "node:fs";
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

// ---------------------------------------------------------------- hook token budget
//
// Every hook's stdout is injected into the model's context (SessionStart) or attached to the
// tool call (UserPromptSubmit/PreToolUse/PostToolUse/Stop). Guards used to emit unbounded
// output — recall-load.sh dumped the whole MEMORY.md on every SessionStart — so a single
// `hooks/budget.json` now caps hook stdout per event. The launcher truncates past the cap with
// a "[truncated: N bytes over budget]" note and the full content stays retrievable on demand
// (lazy recall: SessionStart injects the memory INDEX, not the full text).
//
// Safety rule: a guard that BLOCKS (exit 2) is NEVER truncated — its verdict is
// security-critical and a half-cut JSON decision would fail open. stderr is never truncated
// (it lands in the transcript, not the injected context).

/**
 * Built-in fallback budget, used when hooks/budget.json is missing or unreadable.
 * Fail safe toward capping, never toward unbounded silence.
 * @type {{default_bytes: number, events: Record<string, number>}}
 */
export const DEFAULT_HOOK_BUDGET = {
  default_bytes: 4096,
  events: {
    SessionStart: 12000,
    UserPromptSubmit: 6000,
    PreToolUse: 4000,
    PostToolUse: 4000,
    Stop: 6000,
  },
};

/**
 * Where the launcher looks for `hooks/budget.json`, resolved from the launcher's own
 * location: `<package-root>/hooks/budget.json` (the launcher lives three levels down at
 * `global/guards/run.mjs`). Exported so tests can pin the contract — a wrong level here
 * silently falls back to the built-ins and a user's edited budget would never apply.
 * @param {string} [fromUrl] module URL to resolve from (defaults to this launcher)
 * @returns {string}
 */
export function defaultBudgetPath(fromUrl = import.meta.url) {
  return join(dirname(dirname(dirname(fileURLToPath(fromUrl)))), "hooks", "budget.json");
}

/**
 * Load the hook token budget: `hooks/budget.json` next to this launcher, with the
 * HOOK_TOKEN_BUDGET env var (a JSON object shaped like `events`, or a bare integer
 * default) overriding it. An unreadable config or override never disables the budget —
 * the built-in defaults apply. Pure — path probing and env are injectable.
 * @param {{env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean, read?: (p: string, enc: string) => string, budgetPath?: string}} [opts]
 * @returns {{default_bytes: number, events: Record<string, number>}}
 */
export function loadBudget({
  env = process.env,
  exists = existsSync,
  read = readFileSync,
  budgetPath,
} = {}) {
  const path = budgetPath ?? defaultBudgetPath();
  let cfg = null;
  try {
    if (exists(path)) cfg = JSON.parse(read(path, "utf8"));
  } catch {
    cfg = null;
  }
  const events = { ...DEFAULT_HOOK_BUDGET.events, ...(cfg?.events ?? {}) };
  let def =
    cfg && Number.isFinite(+cfg.default_bytes)
      ? +cfg.default_bytes
      : DEFAULT_HOOK_BUDGET.default_bytes;
  const over = env.HOOK_TOKEN_BUDGET;
  if (over !== undefined && over !== "") {
    try {
      const parsed = JSON.parse(over);
      if (typeof parsed === "number" && Number.isFinite(parsed)) def = parsed;
      else if (parsed && typeof parsed === "object") Object.assign(events, parsed);
    } catch {
      /* an invalid override never disables the budget */
    }
  }
  return { default_bytes: def, events };
}

/**
 * Truncate UTF-8 text to at most `cap` bytes, never splitting a character, and append the
 * overflow note. The note names the byte overage so the truncation is never silent.
 * @param {string} text
 * @param {number} cap
 * @returns {{text: string, truncated: boolean, over: number}}
 */
export function truncateToBudget(text, cap) {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= cap) return { text, truncated: false, over: 0 };
  const over = total - cap;
  const bytes = Buffer.from(text, "utf8").subarray(0, cap);
  // Drop a trailing partial UTF-8 sequence: walk back over continuation bytes, then check
  // the lead byte — if the full sequence does not fit, the cut split a character.
  let end = bytes.length;
  let cont = 0;
  while (end - 1 - cont >= 0 && (bytes[end - 1 - cont] & 0xc0) === 0x80) cont++;
  const lead = bytes[end - 1 - cont];
  const want = lead === undefined ? 0 : lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  if (cont + 1 < want) end = end - 1 - cont;
  return {
    text: `${bytes.subarray(0, end).toString("utf8")}\n[truncated: ${over} bytes over budget]`,
    truncated: true,
    over,
  };
}

/**
 * Run a guard with inherited stdio and return the exit code to report: `bash <script> …args`, or
 * `node <twin.mjs> …args` for a guard with a Node twin. `--fail-closed` before the script (or
 * GUARD_POLICY) turns every launcher-level failure into a block. `--event <Name>` names the
 * Claude Code hook event for the token budget (stripped before the guard runs). `deps` are
 * test seams.
 * @param {string[]} argv `[--fail-closed] [--event <Name>] guardScript ...guardArgs`
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
  // The hook event rides along as `--event <Name>`, inserted by the hook manifests between
  // the launcher and the guard — the launcher never sniffs stdin for it (reading stdin here
  // can block forever on an inherited-but-idle pipe). A missing flag falls back to the
  // default budget. The flag is stripped before the guard runs: the guard never sees it.
  let eventName = null;
  const evIdx = args.indexOf("--event");
  if (evIdx >= 0) {
    eventName = typeof args[evIdx + 1] === "string" && args[evIdx + 1] ? args[evIdx + 1] : null;
    args.splice(evIdx, 2);
  }
  const [script, ...rest] = args;
  if (!script) {
    process.stderr.write(
      `${self}: usage: node ${self} [--fail-closed] [--event <Name>] <guard.sh> [args…]\n`,
    );
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
  // stdin stays inherited exactly as before (the guard reads the hook JSON itself); only
  // stdout is captured, so the token budget can cap what gets injected into context.
  const r = spawn(cmd, cmdArgs, {
    stdio: ["inherit", "pipe", "inherit"],
    env,
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (r.error).code;
    return failed(code === "ENOENT" && cmd !== process.execPath ? NO_BASH_HINT : r.error.message);
  }
  // A signal-killed guard has no status: a visible non-blocking error (1) or, fail-closed, a block.
  if (r.status === null) return failed(`the guard was killed by ${r.signal ?? "a signal"}`);
  // Token budget: stdout is what gets injected into context, so cap it per the hook event.
  // Exit 2 is a BLOCK verdict — security-critical, never truncated.
  let out = typeof r.stdout === "string" ? r.stdout : "";
  if (r.status !== 2 && out) {
    const budget = loadBudget({ env });
    const cap = (eventName && budget.events[eventName]) || budget.default_bytes;
    out = truncateToBudget(out, cap).text;
  }
  if (out) process.stdout.write(out);
  if (failClosed && r.status !== 0 && r.status !== 2) return failed(`the guard exited ${r.status}`);
  return r.status;
}

// Run only as the hook entrypoint (`node run.mjs …`). Importing it (doctor, tests) must not spawn
// anything — and the check is by basename, so a `~/.forge` symlink install cannot fool it.
const invokedAs = process.argv[1] ? basename(process.argv[1]).toLowerCase() : "";
if (invokedAs === basename(fileURLToPath(import.meta.url)).toLowerCase()) {
  process.exitCode = runGuard(process.argv.slice(2));
}
