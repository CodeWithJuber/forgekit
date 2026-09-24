import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { protectPathsDecision } from "../global/guards/protect-paths.mjs";

const guards = join(dirname(fileURLToPath(import.meta.url)), "..", "global", "guards");

function runGuard(script, input, opts = {}) {
  // spawnSync captures BOTH stdout and stderr regardless of exit code; guards
  // emit their advisories/blocks on stderr, so execFileSync would miss them.
  const r = spawnSync("bash", [join(guards, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    ...opts,
  });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
}

test("protect-paths blocks a .env write (exit 2)", () => {
  const r = runGuard("protect-paths.sh", {
    tool_name: "Write",
    tool_input: { file_path: "/x/.env" },
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /env file/);
});

test("protect-paths allows a normal source write (exit 0)", () => {
  const r = runGuard("protect-paths.sh", {
    tool_name: "Write",
    tool_input: { file_path: "/x/app.js" },
  });
  assert.equal(r.code, 0);
});

test("protect-paths blocks destructive rm (exit 2)", () => {
  const r = runGuard("protect-paths.sh", {
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
  });
  assert.equal(r.code, 2);
});

test("protect-paths blocks a Bash secret read (cat .env) (exit 2)", () => {
  const r = runGuard("protect-paths.sh", {
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /protected secret path/);
});

test("protect-paths blocks reading a secret from git history (exit 2)", () => {
  const r = runGuard("protect-paths.sh", {
    tool_name: "Bash",
    tool_input: { command: "git show HEAD~1:.env" },
  });
  assert.equal(r.code, 2);
});

test("protect-paths allows a normal Bash read (exit 0)", () => {
  const r = runGuard("protect-paths.sh", {
    tool_name: "Bash",
    tool_input: { command: "cat src/app.js" },
  });
  assert.equal(r.code, 0);
});

test("protect-paths does not false-positive on .keys()/.environment (extension-anchored)", () => {
  for (const command of [
    'grep -n foo src/x.js; node -e "Object.keys(r)"',
    "cat src/environment.js",
    "rg keyword docs/",
  ]) {
    const r = runGuard("protect-paths.sh", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(r.code, 0, `must not block: ${command}`);
  }
});

test("protect-paths does not false-positive on prose mentioning secrets in a quoted arg", () => {
  // A commit message that merely names cat/.env/git show must not be blocked — the reader
  // is anchored to a command boundary, so text inside a quoted arg is safe.
  const r = runGuard("protect-paths.sh", {
    tool_name: "Bash",
    tool_input: {
      command: 'git commit -m "block cat .env and git show HEAD:.env reads"',
    },
  });
  assert.equal(r.code, 0);
});

test("protect-paths blocks content-dumping git subcommands on secret paths (RA-05)", () => {
  for (const command of [
    "git diff -- .env",
    "git diff HEAD~1 .env.production",
    "git stash show -p stash@{0} -- .env",
    "git cat-file -p HEAD:.env",
    "git archive HEAD .env",
    "git grep -h . -- .env",
    "git show HEAD:.env", // regression: already a reader before RA-05
    'git diff -- ".env"',
    "cat './.env'",
  ]) {
    const r = runGuard("protect-paths.sh", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(r.code, 2, `must block: ${command}`);
    assert.match(r.err, /protected secret path/, `deny reason for: ${command}`);
  }
});

test("protect-paths does not false-positive on benign git commands (RA-05)", () => {
  for (const command of [
    "git diff src/verify.js",
    "git log --oneline",
    "git status",
    "git stash list", // no secret token — the permission ask covers stash
    'git commit -m "update .env docs"', // secret token only inside prose, commit is not a reader
  ]) {
    const r = runGuard("protect-paths.sh", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(r.code, 0, `must not block: ${command}`);
  }
});

test("protect-paths blocks shell WRITES to a protected path (HI-06)", () => {
  for (const command of [
    "echo X > .env",
    "printf X >> .env",
    "tee .env",
    "tee -a .env",
    "sed -i s/a/b/ .env",
    "cp payload .env",
    "mv payload .env",
    "install payload .env",
    "dd if=x of=.env",
    ": > .env",
    "> .env",
    'echo X > ".env"',
    "cp key.pem /x/id_rsa",
  ]) {
    const r = runGuard("protect-paths.sh", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(r.code, 2, `must block: ${command}`);
    assert.match(
      r.err,
      /writing to a protected secret path|in-place/,
      `deny reason for: ${command}`,
    );
  }
});

test("protect-paths does not false-positive on benign shell writes (HI-06)", () => {
  for (const command of [
    "echo hi > out.txt",
    "printf hi >> notes.md",
    "tee build.log",
    "cp src/a.js src/b.js",
    "sed -i s/a/b/ src/x.js",
  ]) {
    const r = runGuard("protect-paths.sh", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(r.code, 0, `must not block: ${command}`);
  }
});

test("protect-paths blocks git readers behind wrappers / global options (HI-07)", () => {
  for (const command of [
    "git -C . diff -- .env",
    "git --no-pager diff -- .env",
    "/usr/bin/git diff -- .env",
    "command git diff -- .env",
    "env git diff -- .env",
    "VAR=x git diff -- .env",
    "git blame -- .env",
    "git show-index .env",
    "git -c core.pager=cat show HEAD:.env",
  ]) {
    const r = runGuard("protect-paths.sh", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(r.code, 2, `must block: ${command}`);
    assert.match(r.err, /protected secret path/, `deny reason for: ${command}`);
  }
});

test("protect-paths does not false-positive on benign git after HI-07 hardening", () => {
  for (const command of [
    "git diff -- src/x.js",
    "git --no-pager log --oneline",
    "digit --version",
    'git commit -m "block cat .env and git show HEAD:.env reads"',
  ]) {
    const r = runGuard("protect-paths.sh", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(r.code, 0, `must not block: ${command}`);
  }
});

test("secret-redact redacts a token without jq (Node path)", () => {
  const r = runGuard("secret-redact.sh", {
    tool_name: "Bash",
    tool_response: "token=ghp_0123456789abcdef0123456789abcdef0123",
  });
  assert.equal(r.code, 0, "never blocks");
  assert.doesNotMatch(r.out, /ghp_0123456789abcdef/, "raw token must not survive");
  assert.match(r.out, /updatedToolOutput/, "emits a redaction rewrite");
});

test("cost-budget never blocks and warns on a broad command", () => {
  const r = runGuard("cost-budget.sh", {
    session_id: `t-broad-${Date.now()}`,
    tool_input: { command: "find / -name x" },
  });
  assert.equal(r.code, 0, "must never block");
  assert.match(r.err, /broad|scope/i);
  // B8: stderr on an exit-0 PreToolUse hook reaches nobody, so the nudge also rides on the
  // documented `additionalContext` channel.
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /broad\/expensive command/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "a nudge never decides");
});

test("cost-budget fires from any cwd (subdir/worktree safe)", () => {
  const r = runGuard(
    "cost-budget.sh",
    { session_id: "t-cwd", tool_input: { command: "ls" } },
    { cwd: tmpdir() },
  );
  assert.equal(r.code, 0);
});

test("lean-guard is non-blocking outside a git repo (exit 0)", () => {
  const r = runGuard("lean-guard.sh", {}, { cwd: tmpdir() });
  assert.equal(r.code, 0);
});

// ── The cortex hook SHIM (cortex.sh), driven exactly as Claude Code drives it: `node run.mjs
// cortex.sh <mode>` with the hook JSON on stdin. The entrypoint tests pipe straight into
// node and so could never see a shim bug — and there was one: `stop` runs detached, and a
// background job in a non-interactive shell gets /dev/null as stdin, so the Stop payload was
// lost and the REAL session was never processed in any install (no episodes, no lessons,
// the session log never cleared).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("cortex.sh stop (detached) processes the REAL session from the Stop payload (C1)", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-shim-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const sid = "shim-c1";
  const hook = (mode, payload = {}) =>
    spawnSync("node", [join(guards, "run.mjs"), join(guards, "cortex.sh"), mode], {
      input: JSON.stringify({ cwd: root, session_id: sid, ...payload }),
      encoding: "utf8",
    });
  for (let i = 0; i < 3; i++)
    hook("capture", { tool_name: "Edit", tool_input: { file_path: "src/a.js" } });
  hook("prompt", { prompt: "that's wrong, undo it" });
  const sessions = join(root, ".forge", "sessions");
  const log = join(sessions, `${sid}.jsonl`);
  assert.ok(existsSync(log), "capture/prompt logged the session through the shim");

  const r = hook("stop");
  assert.equal(r.status, 0, "the Stop shim never fails the session");
  // Detached by design — poll for the background run to finish the real session.
  const deadline = Date.now() + 30000;
  while (existsSync(log) && Date.now() < deadline) await sleep(100);
  assert.equal(existsSync(log), false, "the real session's log was consumed and cleared");
  assert.ok(
    existsSync(join(root, ".forge", "lessons", "episodes.jsonl")),
    "episodes were recorded for the real session",
  );
  assert.equal(
    existsSync(join(sessions, "default.jsonl")),
    false,
    "nothing fell back to the shared 'default' session",
  );
});

// ── B6. The rule set is now a pure function in protect-paths.mjs, so the matrix below runs
// without a process per case; the end-to-end cases above pin that the shim still exits 2.
test("protect-paths rules: destructive commands the literal substrings missed (B6)", () => {
  const blocked = [
    "git reset --hard HEAD~1",
    "git -C /repo reset --hard",
    "git clean -fdx",
    "git clean --force",
    "find . -name '*.log' -delete",
    "find /var -type f -exec rm {} ;",
    "chmod -R 777 /srv",
    "dd if=/dev/zero of=/dev/sda",
    "drop table users;",
    "psql -c 'DROP DATABASE prod'",
    "rm -fr /",
    "sudo rm -Rf ~",
    "rm --recursive --force $HOME",
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "sudo git push --force",
    "git -c core.pager=cat push --force",
  ];
  for (const command of blocked) {
    const d = protectPathsDecision({ toolName: "Bash", command });
    assert.equal(d.block, true, `must block: ${command}`);
  }
  const allowed = [
    "git push --force-with-lease origin main",
    "git push --force-if-includes",
    "git push origin main",
    "git clean -n",
    "git reset --soft HEAD~1",
    "truncate -s 0 build.log",
    "chmod 644 src/a.js",
    "chmod -r secret.txt", // remove read bit on ONE file: not recursive
    "find . -name '*.log' -print",
    "rm -rf node_modules",
    "dd if=/dev/zero bs=1M count=1",
    'git commit -m "explain when to push -f and when to reset --hard"', // prose, not a command
    'git log --grep="git clean -fdx"',
  ];
  for (const command of allowed) {
    const d = protectPathsDecision({ toolName: "Bash", command });
    assert.equal(d.block, false, `must not block: ${command} (${d.reason})`);
  }
});

test("protect-paths: an npmrc outside the project is protected even when HOME does not match it", () => {
  // Git Bash on Windows rewrites HOME/USERPROFILE (`/home/u` -> `C:/Program Files/Git/home/u`)
  // before node reads them, so the guard cannot rely on HOME to spot the user-level npmrc.
  const env = {
    ...process.env,
    HOME: "/nonexistent/elsewhere",
    USERPROFILE: "/nonexistent/elsewhere",
  };
  for (const tool_name of ["Write", "Read"]) {
    const r = runGuard(
      "protect-paths.sh",
      { tool_name, tool_input: { file_path: "/home/u/.npmrc" } },
      { env },
    );
    assert.equal(r.code, 2, `must block ${tool_name} of an out-of-project .npmrc`);
  }
});

test("protect-paths: the .env name check stays linear on hostile names (CodeQL js/redos)", async () => {
  const { secretKind } = await import("../global/guards/protect-paths.mjs");
  const started = process.hrtime.bigint();
  assert.equal(secretKind(`.env-${"--".repeat(20000)}!`), null);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200, "must not backtrack");
  assert.equal(secretKind(".env-prod.local"), "env file");
  assert.equal(secretKind(".env.example"), null);
});

test("protect-paths protects the credential stores and Read itself (B6)", () => {
  // `/home/u` is HOME for the guard, so `/home/u/.npmrc` is the USER-level npmrc — where
  // `npm login` writes the token — and stays protected with no file on disk.
  const env = { ...process.env, HOME: "/home/u", USERPROFILE: "/home/u" };
  for (const file_path of [
    "/home/u/.aws/credentials",
    "/home/u/.netrc",
    "/home/u/.npmrc",
    "/home/u/.git-credentials",
    "C:\\Users\\u\\.aws\\credentials", // Windows-native path (backslashes)
    "C:\\proj\\.env",
  ]) {
    for (const tool_name of ["Write", "Read"]) {
      const r = runGuard("protect-paths.sh", { tool_name, tool_input: { file_path } }, { env });
      assert.equal(r.code, 2, `must block ${tool_name} of ${file_path}`);
      assert.match(r.err, tool_name === "Read" ? /refusing to read/ : /refusing to modify/);
    }
  }
  // Bash readers/writers of the same stores are blocked too — a project `.npmrc` when it
  // holds a literal token.
  const token = () => "//registry.npmjs.org/:_authToken=npm_abc123";
  for (const command of ["cat ~/.netrc", "cat .npmrc", "echo x > ~/.git-credentials"]) {
    const d = protectPathsDecision({ toolName: "Bash", command, readText: token });
    assert.equal(d.block, true, command);
  }
  // …and an ordinary source file is still untouched.
  assert.equal(
    runGuard("protect-paths.sh", { tool_name: "Read", tool_input: { file_path: "src/a.js" } }).code,
    0,
  );
});

test("protect-paths parses the payload with a real parser, not a regex (B6)", () => {
  // The old grep fallback (used whenever jq was absent — stock Git for Windows, minimal
  // images) cut the command at the first escaped quote, so everything after it was invisible.
  for (const command of [
    'echo "x"; cat .env',
    'echo "hello world" && cat .env',
    'git diff -- ".env"',
  ]) {
    const r = runGuard("protect-paths.sh", { tool_name: "Bash", tool_input: { command } });
    assert.equal(r.code, 2, `must block: ${command}`);
  }
  // A LARGE command used to lose its deny to SIGPIPE: `printf | grep -q` under pipefail
  // reported failure when grep exited early, so the rule "did not match".
  const big = `cat .env\n${Array.from({ length: 20000 }, (_, i) => `# note ${i}`).join("\n")}`;
  const r = runGuard("protect-paths.sh", { tool_name: "Bash", tool_input: { command: big } });
  assert.equal(r.code, 2, "a 200 KB command still blocks");
});

test("protect-paths fails CLOSED on an unparsable payload (B6)", () => {
  // Exit 1 is a NON-blocking hook error in Claude Code, so an internal failure used to let
  // the tool call through.
  const r = spawnSync("bash", [join(guards, "protect-paths.sh")], {
    input: "not json at all",
    encoding: "utf8",
  });
  assert.equal(r.status, 2, "an unparsable payload blocks");
  assert.match(r.stderr, /fail closed/i);
});

// ── forge_timeout: `timeout` is GNU coreutils and stock macOS has none, so the session
// learner's bare `timeout 90 claude …` never ran the model there. These tests build a PATH
// with no `timeout`/`gtimeout` (symlinks to the tools the scripts need), which reproduces
// stock macOS on any POSIX runner. Windows Git Bash ships `timeout`, and symlinks need
// elevation there, so both tests skip on win32.
const noTimeoutSkip = process.platform === "win32" && "symlinked PATH (Git Bash ships timeout)";

/** @param {string[]} tools */
function pathWithoutTimeout(tools) {
  const bin = mkdtempSync(join(tmpdir(), "forge-notimeout-"));
  for (const t of tools) {
    const real = execFileSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, t));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}

test("forge_timeout without timeout/gtimeout: stdin, exit status and the time limit hold", {
  skip: noTimeoutSkip,
}, () => {
  const bin = pathWithoutTimeout(["bash", "sh", "cat", "sleep", "dirname"]);
  const script = [
    `. "${join(guards, "_guardlib.sh")}"`,
    'if command -v timeout >/dev/null || command -v gtimeout >/dev/null; then echo "HAS-TIMEOUT"; fi',
    "printf 'hello' | forge_timeout 5 cat; echo",
    "forge_timeout 5 sh -c 'exit 3'; echo \"rc=$?\"",
    's=$SECONDS; out="$(forge_timeout 1 sleep 8)"; echo "overrun=$? secs=$((SECONDS - s))"',
  ].join("\n");
  const r = spawnSync(join(bin, "bash"), ["-c", script], {
    env: { PATH: bin, HOME: tmpdir() },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /HAS-TIMEOUT/, "the PATH really has no timeout");
  assert.match(r.stdout, /^hello$/m, "stdin reaches the command (a bare `&` would read /dev/null)");
  assert.match(r.stdout, /rc=3/, "the command's exit status passes through");
  const m = /overrun=(\d+) secs=(\d+)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.notEqual(Number(m[1]), 0, "an overrun is reported as a failure");
  assert.ok(
    Number(m[2]) <= 4,
    `killed at the limit, and $(…) does not wait on the watchdog (${m[2]}s)`,
  );
});

test("session-learner calls the model on a PATH with no timeout (stock macOS)", {
  skip: noTimeoutSkip,
}, async () => {
  const bin = pathWithoutTimeout([
    ...["bash", "cat", "grep", "wc", "tail", "sed", "date", "mkdir", "touch"],
    ...["basename", "dirname", "find", "rmdir", "sleep"],
  ]);
  const home = mkdtempSync(join(tmpdir(), "forge-learner-home-"));
  const calls = join(home, "calls.log");
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\necho called >> "${calls}"\necho "- Rebuild the atlas after renaming a module."\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, '{"type":"user","message":"rename the module"}\n');
  const lockDir = mkdtempSync(join(tmpdir(), "forge-learner-lock-"));
  const r = spawnSync(join(bin, "bash"), [join(guards, "session-learner.sh")], {
    input: JSON.stringify({ transcript_path: transcript, cwd: join(home, "shop") }),
    env: {
      PATH: bin,
      HOME: home,
      TMPDIR: lockDir,
      ENABLE_SESSION_LEARNING: "1",
      SESSION_LEARN_MIN: "1",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  // The model call runs detached, so wait (up to 10s) for the lesson it appends.
  const learned = join(home, ".claude", "skills", "learned");
  const lessons = () => {
    const f = existsSync(learned) && readdirSync(learned).find((n) => /^lessons-.*\.md$/.test(n));
    return f ? readFileSync(join(learned, f), "utf8") : "";
  };
  for (let i = 0; i < 100 && !/Rebuild the atlas/.test(lessons()); i++)
    await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(existsSync(calls), "the model stub was called");
  assert.match(lessons(), /Rebuild the atlas/, "the lesson was appended");
});
