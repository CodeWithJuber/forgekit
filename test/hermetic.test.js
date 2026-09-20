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
import { homedir, userInfo } from "node:os";
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
// which already matches a non-TTY test process.
const NOT_SCRUBBED = new Set(["TERM", "TOKEN", "X"]);

test("every env var src reads is scrubbed (the denylist cannot drift from envVarsRead)", () => {
  const leaked = [...envVarsRead()].filter(
    // FORGE_LLM_HTTP is set BY _setup on purpose: it forces the keyless HTTP runner.
    (v) => !NOT_SCRUBBED.has(v) && v !== "FORGE_LLM_HTTP" && process.env[v] !== undefined,
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
    ["--import", new URL("./_setup.js", import.meta.url).href, "-e", canary],
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
