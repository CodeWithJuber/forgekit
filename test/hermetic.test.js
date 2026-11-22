// The suite's hermetic contract, pinned. This file fails if test/_setup.js stops running
// (someone drops --import from package.json), stops covering the env surface (someone adds a
// process.env read under a new prefix), or stops sandboxing $HOME.
//
// Why this exists: both historical failures here — test/substrate.test.js:105 and
// test/doctor.test.js — were invisible in CI (clean env, no ~/.forge) and only fired on a
// machine where forge was actually installed and enabled. CI-green/local-red is the exact
// failure mode a hermetic boundary prevents, and only a test can notice the boundary is gone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envVarsRead } from "../src/docs_check.js";

// userInfo().homedir reads the passwd DB and IGNORES $HOME — the only oracle for "the real
// home" that survives its own sandbox.
test("_setup ran: $HOME is a sandbox, not the developer's home", () => {
  assert.notEqual(homedir(), userInfo().homedir, "test/_setup.js did not run — is --import wired?");
});

// Regex false positives from comments, not real reads (src/commit_gate.js, src/consensus.js,
// src/docs_check.js, src/docs_impact.js all document `process.env.X` in prose). TERM is
// deliberately kept: only TERM=dumb is meaningful in src/fmt.js and it forces colour off,
// which already matches a non-TTY test process. PATH supplies the toolchain for integration
// tests that execute git, node and the package manager. Proxy routing stays inherited
// by those tools; networked registry lookups are disabled via FORGE_NO_CATALOG_FETCH.
const NOT_SCRUBBED = new Set(["PATH", "HTTPS_PROXY", "TERM", "TOKEN", "X"]);
// Sandboxed rather than scrubbed: _setup points these at an empty test home (pinned by the
// test above), so a src read of them sees that home, never the developer's. They count as a
// leak again the moment one holds the real home.
const SANDBOXED = new Set(["HOME", "USERPROFILE"]);
// Set (not scrubbed) by _setup: each forces a network-free path, pinned by the test below.
const SET_BY_SETUP = new Set(["FORGE_LLM_HTTP", "FORGE_NO_CATALOG_FETCH"]);

test("every env var src reads is scrubbed (the denylist cannot drift from envVarsRead)", () => {
  const realHome = userInfo().homedir;
  const leaked = [...envVarsRead()].filter(
    // FORGE_LLM_HTTP and FORGE_NO_CATALOG_FETCH are set BY _setup on purpose: they force the
    // keyless HTTP runner and keep the model catalogs off the network.
    (v) =>
      !NOT_SCRUBBED.has(v) &&
      !SET_BY_SETUP.has(v) &&
      !(SANDBOXED.has(v) && process.env[v] !== realHome) &&
      process.env[v] !== undefined,
  );
  assert.deepEqual(leaked, [], `not scrubbed by test/_setup.js: ${leaked.join(", ")}`);
});

test("canary: a hostile env cannot reach a test process", () => {
  const canary =
    "import{homedir,userInfo}from'node:os';" +
    "if(process.env.FORGE_LLM||process.env.ANTHROPIC_API_KEY)throw new Error('env leaked');" +
    "if(homedir()===userInfo().homedir)throw new Error('HOME leaked');";
  const r = spawnSync(
    process.execPath,
    // A file:// URL, not a path: --import resolves module specifiers, and on Windows a
    // plain absolute path (D:\…) parses as the URL scheme "d:" (ERR_UNSUPPORTED_ESM_URL_SCHEME).
    ["--import", new URL("./_setup.js", import.meta.url).href, "--input-type=module", "-e", canary],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: userInfo().homedir,
        USERPROFILE: userInfo().homedir,
        FORGE_LLM: "1",
        ANTHROPIC_API_KEY: ["sk", "ant", "api03", "HOSTILECANARYVALUE"].join("-"),
        FORCE_COLOR: "1",
      },
    },
  );
  assert.equal(r.status, 0, r.stderr);
});

// The sandboxed $HOME only moves ~/.gitconfig. A signing rule also arrives from
// /etc/gitconfig, $GIT_CONFIG_GLOBAL or the caller's own GIT_CONFIG_* pairs, and a signer
// that needs an agent session variable (CLAUDE_*, scrubbed by _setup) then fails every
// fixture `git commit` and `git tag`: 64 failures on a self-hosted runner, none in CI.
test("canary: forced git signing cannot reach a fixture repo", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-hermetic-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // node as the signer: it rejects gpg's flags and exits non-zero on every platform, so any
  // signing attempt fails without a fixture script. gpg.format is pinned because a
  // developer's own `gpg.format=ssh` would route around gpg.program.
  const forced = [
    ["commit.gpgsign", "true"],
    ["tag.gpgsign", "true"],
    ["tag.forceSignAnnotated", "true"],
    ["gpg.format", "openpgp"],
    ["gpg.program", process.execPath],
  ];
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, GIT_CONFIG_COUNT: String(forced.length) };
  forced.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  const canary =
    "import{execFileSync}from'node:child_process';" +
    "const g=(...a)=>execFileSync('git',['-c','user.name=t','-c','user.email=t@example.invalid',...a],{encoding:'utf8',stdio:'pipe'});" +
    "g('init','-q');g('commit','-q','--allow-empty','-m','x');g('tag','-a','v1','-m','x');g('tag','v2');" +
    // The caller's own pairs must survive: _setup appends, it never replaces.
    "if(g('config','--get','gpg.program').trim()!==process.execPath)throw new Error('caller GIT_CONFIG_* pairs were clobbered');";
  const r = spawnSync(
    process.execPath,
    ["--import", new URL("./_setup.js", import.meta.url).href, "--input-type=module", "-e", canary],
    { cwd: dir, encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr);
});
