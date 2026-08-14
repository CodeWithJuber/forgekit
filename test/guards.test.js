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
