// Portable hook launcher (global/guards/run.mjs) — the Windows "hooks fail: bash not on PATH" fix.
//
// Exec-form hooks are spawned directly (no shell), so `command: "bash"` needs bash on PATH — which
// a default Git for Windows install does NOT provide (git.exe lives in Git\cmd, bash.exe in Git\bin
// and Git\usr\bin). Every hook now spawns `node run.mjs <guard.sh> …`. These tests pin:
//   1. the bash resolution order on every OS, via injected env + filesystem (pure);
//   2. real end-to-end runs — stdin/stdout/exit-code passthrough, an exit-2 BLOCK preserved, paths
//      WITH SPACES on Windows and POSIX, the Windows default-install PATH shape, and the
//      "no bash anywhere" failure mode (exit 1 + an actionable line for an advisory guard; the
//      fail-closed protect-paths runs on its Node twin and BLOCKS whenever it cannot decide);
//   3. that the launcher and both hook manifests ship in the npm archive.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GUARD_POLICY, resolveBash, runGuard } from "../global/guards/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guards = join(root, "global", "guards");
const launcher = join(guards, "run.mjs");
const win = process.platform === "win32";

/** Run the launcher exactly as a hook does: `node run.mjs <guard> [args…]`, hook JSON on stdin. */
function launch(args, { input = "", env = process.env, launcherPath = launcher } = {}) {
  const r = spawnSync(process.execPath, [launcherPath, ...args], { input, encoding: "utf8", env });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", error: r.error };
}

/** A copy of process.env with the given keys replaced (case-insensitively — Windows env). */
function envWith(over) {
  const drop = new Set(Object.keys(over).map((k) => k.toLowerCase()));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!drop.has(k.toLowerCase())) env[k] = v;
  return Object.assign(env, over);
}

const writeEnv = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/.env" } });
const writeSrc = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/src/a.js" } });

/** A fake Windows filesystem: `exists()` over a set of paths, compared case-insensitively. */
const fakeFs = (...present) => {
  const norm = (p) => String(p).toLowerCase().replaceAll("/", "\\");
  const set = new Set(present.map(norm));
  return (p) => set.has(norm(p));
};
const winEnv = (over = {}) => ({
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  USERPROFILE: "C:\\Users\\u",
  PATH: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
  ...over,
});

// ------------------------------------------------------------------ resolution order (pure)

test("resolveBash (win32): default Git for Windows install — git on PATH, bash NOT — finds Git\\bin\\bash.exe", () => {
  const exists = fakeFs(
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  );
  const env = winEnv({
    PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs",
    ProgramFiles: "D:\\nowhere", // PATH-derived resolution must not depend on the standard dirs
  });
  const r = resolveBash({ env, platform: "win32", exists });
  assert.equal(r.path, "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(r.via, "git-for-windows");
});

test("resolveBash (win32): an install exposing only Git\\usr\\bin\\bash.exe, or Git\\mingw64\\bin on PATH, still resolves", () => {
  const usrOnly = fakeFs("C:\\Git\\cmd\\git.exe", "C:\\Git\\usr\\bin\\bash.exe");
  assert.equal(
    resolveBash({
      env: winEnv({ PATH: "C:\\Git\\cmd", ProgramFiles: "D:\\nowhere" }),
      platform: "win32",
      exists: usrOnly,
    }).path,
    "C:\\Git\\usr\\bin\\bash.exe",
  );
  const mingw = fakeFs("C:\\Git\\mingw64\\bin\\git.exe", "C:\\Git\\bin\\bash.exe");
  assert.equal(
    resolveBash({
      env: winEnv({ PATH: "C:\\Git\\mingw64\\bin", ProgramFiles: "D:\\nowhere" }),
      platform: "win32",
      exists: mingw,
    }).path,
    "C:\\Git\\bin\\bash.exe",
  );
});

test("resolveBash (win32): a portable Git whose bin dir is on PATH is found via PATH", () => {
  const exists = fakeFs("D:\\tools\\PortableGit\\bin\\bash.exe");
  const env = winEnv({
    PATH: "C:\\Windows\\System32;D:\\tools\\PortableGit\\bin",
    ProgramFiles: "D:\\nowhere",
  });
  assert.deepEqual(resolveBash({ env, platform: "win32", exists }), {
    path: "D:\\tools\\PortableGit\\bin\\bash.exe",
    via: "PATH",
  });
});

test("resolveBash (win32): the WSL launcher in System32 is never mistaken for Git Bash", () => {
  const onlyWsl = fakeFs("C:\\Windows\\System32\\bash.exe");
  assert.deepEqual(resolveBash({ env: winEnv(), platform: "win32", exists: onlyWsl }), {
    path: null,
    via: "none",
  });
  // …even when it comes FIRST on PATH and the real Git Bash sits in the standard install dir.
  const both = fakeFs("C:\\Windows\\System32\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(
    resolveBash({ env: winEnv(), platform: "win32", exists: both }).path,
    "C:\\Program Files\\Git\\bin\\bash.exe",
  );
});

test("resolveBash (win32): per-user (LOCALAPPDATA) and scoop installs are found without any PATH help", () => {
  const user = fakeFs("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
  assert.equal(
    resolveBash({ env: winEnv(), platform: "win32", exists: user }).path,
    "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
  );
  const scoop = fakeFs("C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe");
  assert.equal(
    resolveBash({ env: winEnv(), platform: "win32", exists: scoop }).path,
    "C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe",
  );
});

test("resolveBash: FORGE_BASH, then CLAUDE_CODE_GIT_BASH_PATH, override everything on every OS — only when the file exists", () => {
  const exists = fakeFs(
    "E:\\msys64\\usr\\bin\\bash.exe",
    "F:\\cc\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  );
  const env = winEnv({
    FORGE_BASH: "E:\\msys64\\usr\\bin\\bash.exe",
    CLAUDE_CODE_GIT_BASH_PATH: "F:\\cc\\bash.exe",
  });
  assert.deepEqual(resolveBash({ env, platform: "win32", exists }), {
    path: "E:\\msys64\\usr\\bin\\bash.exe",
    via: "FORGE_BASH",
  });
  assert.deepEqual(
    resolveBash({ env: { ...env, FORGE_BASH: "E:\\nope\\bash.exe" }, platform: "win32", exists }),
    { path: "F:\\cc\\bash.exe", via: "CLAUDE_CODE_GIT_BASH_PATH" },
  );
  // Dangling overrides are ignored, not fatal: fall through to the standard install.
  assert.equal(
    resolveBash({
      env: { ...env, FORGE_BASH: "E:\\nope", CLAUDE_CODE_GIT_BASH_PATH: "F:\\nope" },
      platform: "win32",
      exists,
    }).path,
    "C:\\Program Files\\Git\\bin\\bash.exe",
  );
  // POSIX honors the override too (a bash that is not on PATH).
  const posixExists = (p) => p === "/opt/local/bin/bash";
  assert.deepEqual(
    resolveBash({
      env: { FORGE_BASH: "/opt/local/bin/bash" },
      platform: "linux",
      exists: posixExists,
    }),
    { path: "/opt/local/bin/bash", via: "FORGE_BASH" },
  );
});

test("resolveBash (POSIX): unchanged behaviour — `bash` from PATH, no filesystem probing", () => {
  let probed = 0;
  const exists = () => {
    probed++;
    return false;
  };
  for (const platform of ["linux", "darwin", "freebsd"])
    assert.deepEqual(resolveBash({ env: { PATH: "/usr/bin:/bin" }, platform, exists }), {
      path: "bash",
      via: "PATH",
    });
  assert.equal(probed, 0);
});

// ------------------------------------------------------------------ end to end (real bash)

test("launcher: a guard BLOCK propagates unchanged — exit 2 and the reason on stderr", () => {
  const r = launch([join(guards, "protect-paths.sh")], { input: writeEnv });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /env file/i);
});

test("launcher: a benign call is allowed — exit 0", () => {
  const r = launch([join(guards, "protect-paths.sh")], { input: writeSrc });
  assert.equal(r.code, 0, r.err);
});

test("launcher: stdout passes through — SessionStart recall context reaches Claude", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-launcher-home-"));
  try {
    mkdirSync(join(home, "recall"), { recursive: true });
    writeFileSync(join(home, "recall", "MEMORY.md"), "- SENTINEL-7f3a: launcher stdout works\n");
    const r = launch([join(guards, "recall-load.sh")], { env: envWith({ FORGE_HOME: home }) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Durable memory/);
    assert.match(r.out, /SENTINEL-7f3a/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launcher: guard args are forwarded (cortex.sh <mode> keeps exiting 0)", () => {
  const r = launch([join(guards, "cortex.sh"), "prompt"], {
    input: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(r.code, 0, r.err);
});

test("launcher + guards under a path WITH SPACES (as ${CLAUDE_PLUGIN_ROOT} may be): block exit 2, benign 0", () => {
  const base = mkdtempSync(join(tmpdir(), "forge launcher space-"));
  try {
    const g = join(base, "gu ards");
    cpSync(guards, g, { recursive: true });
    const spacedLauncher = join(g, "run.mjs");
    const spacedGuard = join(g, "protect-paths.sh");
    // Native spelling (backslashes on Windows) — exactly what the plugin-root substitution yields.
    let r = launch([spacedGuard], { input: writeEnv, launcherPath: spacedLauncher });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /env file/i);
    r = launch([spacedGuard], { input: writeSrc, launcherPath: spacedLauncher });
    assert.equal(r.code, 0, r.err);
    // Forward-slash spelling (POSIX, or a hand-edited settings.json on Windows).
    r = launch([spacedGuard.replaceAll("\\", "/")], {
      input: writeEnv,
      launcherPath: spacedLauncher,
    });
    assert.equal(r.code, 2, r.err);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("launcher (Windows): default-install PATH — Git\\cmd present, Git\\bin absent — bare `bash` is ENOENT, the launcher still runs the guard", {
  skip: !win && "Windows PATH layout",
}, () => {
  // Walk up from the resolved bash to the Git install root and use its `cmd` dir — the ONLY Git
  // dir a default install puts on PATH.
  let gitRoot = resolveBash().path ? dirname(resolveBash().path) : "";
  while (gitRoot && !existsSync(join(gitRoot, "cmd", "git.exe")) && dirname(gitRoot) !== gitRoot)
    gitRoot = dirname(gitRoot);
  if (!gitRoot || !existsSync(join(gitRoot, "cmd", "git.exe"))) return; // no Git for Windows here
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const sys32 = join(sysRoot, "System32");
  const dirs = [join(gitRoot, "cmd"), dirname(process.execPath)];
  if (!existsSync(join(sys32, "bash.exe"))) dirs.unshift(sys32); // keep System32 unless WSL's bash sits there
  const env = envWith({
    PATH: dirs.join(";"),
    FORGE_BASH: undefined,
    CLAUDE_CODE_GIT_BASH_PATH: undefined,
  });
  // The regression: what every hook did before — spawn `bash` directly (PATH lookup, no shell).
  const old = spawnSync("bash", [join(guards, "protect-paths.sh")], {
    input: writeEnv,
    encoding: "utf8",
    env,
  });
  assert.equal(
    old.error?.code,
    "ENOENT",
    "the bare-bash exec form should fail under a default-install PATH",
  );
  // The fix: same PATH, same guard, through the launcher — resolved from the git on PATH.
  assert.equal(resolveBash({ env }).via, "git-for-windows");
  const r = launch([join(guards, "protect-paths.sh")], { input: writeEnv, env });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /env file/i);
});

/** An env with NO bash reachable by any route resolveBash knows (PATH, overrides, install dirs). */
function noBashEnv(empty) {
  return envWith({
    PATH: empty,
    ProgramFiles: empty,
    ProgramW6432: empty,
    "ProgramFiles(x86)": empty,
    LOCALAPPDATA: empty,
    USERPROFILE: empty,
    FORGE_BASH: undefined,
    CLAUDE_CODE_GIT_BASH_PATH: undefined,
  });
}

test("launcher: with NO bash anywhere an advisory guard fails visibly (exit 1 + actionable hint) and never fabricates a block", () => {
  const empty = mkdtempSync(join(tmpdir(), "forge-nobash-"));
  try {
    const r = launch([join(guards, "cortex.sh"), "prompt"], {
      input: JSON.stringify({ prompt: "hi" }),
      env: noBashEnv(empty),
    });
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.match(r.err, /no bash found/);
    assert.match(r.err, /FORGE_BASH/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// The review: with no bash on PATH, protect-paths exited 1 — a NON-blocking hook error — so the
// security guard was silently off. It now runs on its Node twin (no bash at all), and any failure
// to reach a verdict blocks.
test("launcher: protect-paths needs no bash — it runs on its Node twin (block 2, benign 0)", () => {
  const empty = mkdtempSync(join(tmpdir(), "forge-nobash-"));
  try {
    const env = noBashEnv(empty);
    let r = launch([join(guards, "protect-paths.sh")], { input: writeEnv, env });
    assert.equal(r.code, 2, `${r.out}\n${r.err}`);
    assert.match(r.err, /env file/);
    r = launch([join(guards, "protect-paths.sh")], { input: writeSrc, env });
    assert.equal(r.code, 0, r.err);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("launcher: a fail-closed guard with no twin and NO bash BLOCKS (exit 2), never exit 1", () => {
  const base = mkdtempSync(join(tmpdir(), "forge-failclosed-"));
  try {
    const g = join(base, "guards");
    cpSync(guards, g, { recursive: true });
    rmSync(join(g, "protect-paths.mjs")); // no twin → the bash path, and there is no bash
    const env = noBashEnv(join(base, "empty"));
    let r = launch([join(g, "protect-paths.sh")], { input: writeSrc, env });
    assert.equal(r.code, 2, `${r.out}\n${r.err}`);
    assert.match(r.err, /BLOCKED by protect-paths\.sh \(fail-closed\)/);
    assert.match(r.err, /no bash found/);
    // `--fail-closed` opts any guard in.
    r = launch(["--fail-closed", join(g, "cortex.sh"), "prompt"], { input: "{}", env });
    assert.equal(r.code, 2, `${r.out}\n${r.err}`);
    assert.match(r.err, /BLOCKED by cortex\.sh \(fail-closed\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runGuard: a signal, a spawn error or an odd exit blocks when fail-closed, stays exit 1 otherwise", () => {
  const noTwin = () => false;
  const bashHere = () => ({ path: "bash", via: "PATH" });
  /** Silence the launcher's own stderr line while calling it in-process. */
  const quiet = (fn) => {
    const write = process.stderr.write;
    process.stderr.write = () => true;
    try {
      return fn();
    } finally {
      process.stderr.write = write;
    }
  };
  const run = (argv, result, locateBash = bashHere) =>
    quiet(() => runGuard(argv, process.env, { spawn: () => result, locateBash, exists: noTwin }));
  const killed = { status: null, signal: "SIGKILL" };
  const crashed = { status: 1, signal: null };
  const spawnErr = { error: Object.assign(new Error("EPERM"), { code: "EPERM" }), status: null };
  // An advisory guard: unchanged — a visible, non-blocking 1 (its own exit passes through).
  assert.equal(run(["/g/cortex.sh"], killed), 1);
  assert.equal(run(["/g/cortex.sh"], crashed), 1);
  assert.equal(run(["/g/cortex.sh"], spawnErr), 1);
  // protect-paths (GUARD_POLICY) and any `--fail-closed` guard: every failure is a block.
  for (const argv of [["/g/protect-paths.sh"], ["--fail-closed", "/g/cortex.sh"]]) {
    assert.equal(run(argv, killed), 2, `${argv} killed`);
    assert.equal(run(argv, crashed), 2, `${argv} exit 1`);
    assert.equal(run(argv, spawnErr), 2, `${argv} spawn error`);
    assert.equal(run(argv, { status: 0, signal: null }), 0, `${argv} allow`);
    assert.equal(run(argv, { status: 2, signal: null }), 2, `${argv} deny`);
    assert.equal(
      run(argv, crashed, () => ({ path: null, via: "none" })),
      2,
      `${argv} no bash`,
    );
  }
});

test("GUARD_POLICY: protect-paths runs on a Node twin that ships beside it, and fails closed", () => {
  assert.deepEqual(GUARD_POLICY["protect-paths.sh"], {
    node: "protect-paths.mjs",
    failClosed: true,
  });
  assert.ok(existsSync(join(guards, "protect-paths.mjs")));
});

test("launcher: no guard argument is a usage error (exit 1), not a block", () => {
  const r = launch([]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage/);
});

// ------------------------------------------------------------------ package / archive

test("package: the launcher, the guards and both hook manifests ship in the npm archive", () => {
  const r = spawnSync(
    win ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf8",
      shell: win,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")))[0].files.map((f) => f.path);
  for (const want of [
    "global/guards/run.mjs",
    "global/guards/protect-paths.sh",
    "global/guards/_guardlib.sh",
    "global/settings.template.json",
    "hooks/hooks.json",
  ])
    assert.ok(files.includes(want), `${want} missing from the package (${files.length} files)`);
});

// B6: the Store app-execution alias `…\Microsoft\WindowsApps\bash.exe` is the SAME WSL
// launcher as System32's — it cannot run a `C:\…` guard path, so every guard exited 127,
// which Claude Code reads as a non-blocking hook error: the guards failed OPEN.
test("resolveBash never picks the WindowsApps WSL alias (B6)", () => {
  const env = {
    PATH: [
      "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps",
      "C:\\Program Files\\Git\\cmd",
    ].join(";"),
    SystemRoot: "C:\\Windows",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  };
  const aliasOnly = (p) => /WindowsApps\\bash\.exe$/i.test(p);
  assert.deepEqual(
    resolveBash({ env, platform: "win32", exists: aliasOnly }),
    { path: null, via: "none" },
    "no usable bash is honest; the alias is never returned",
  );
  const withGit = (p) =>
    aliasOnly(p) || /Git\\(bin|usr\\bin)\\bash\.exe$/i.test(p) || /Git\\cmd\\git\.exe$/i.test(p);
  const r = resolveBash({ env, platform: "win32", exists: withGit });
  assert.equal(r.via, "git-for-windows");
  assert.match(r.path, /Git\\bin\\bash\.exe$/);
});
