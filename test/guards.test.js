import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
    session_id: "t-broad",
    tool_input: { command: "find / -name x" },
  });
  assert.equal(r.code, 0, "must never block");
  assert.match(r.err, /broad|scope/i);
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
