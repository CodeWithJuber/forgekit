// protect-paths: secret paths match per PATH TOKEN, not as a substring of the command.
//
// The old rule matched `\.env(\.[\w-]+)?\b` anywhere in a Bash command, so every read-only
// command that merely MENTIONED an env accessor was blocked — `grep -rn process.env src`,
// `rg 'import\.meta\.env'`, `git log --grep='.env handling'` — along with `.env.example`,
// `messages.key.ts`, a plain project `.npmrc` and a Next.js `app/docs/secrets/page.tsx` route.
// Meanwhile real reads slipped through: `sed -n p .env`, `awk 1 .env`, `tac .env`,
// `… < .env`, `cat .e*v`. These tests pin both halves: every false positive from the review
// stays allowed, and every secret read / destructive command stays (or is now) blocked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  globMatchesSecret,
  npmrcHasToken,
  protectPathsDecision,
  secretKind,
  secretShellAccess,
  shellSegments,
} from "../global/guards/protect-paths.mjs";

const guards = join(dirname(fileURLToPath(import.meta.url)), "..", "global", "guards");
const noFile = () => null;
/** @param {string} command */
const bash = (command, extra = {}) =>
  protectPathsDecision({ toolName: "Bash", command, readText: noFile, ...extra });

/** Run the real guard end to end (node twin, no bash), hook JSON on stdin. */
function hook(payload) {
  const r = spawnSync(process.execPath, [join(guards, "protect-paths.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr ?? "" };
}

// ── The review's false positives: read-only commands and files that must be ALLOWED.

test("false positives from the review are allowed: env accessors, templates, code files", () => {
  for (const command of [
    "grep -rn process.env src",
    "rg 'process\\.env\\.WHMCS' src/lib",
    "grep -rn import.meta.env src",
    "git log -p --grep='.env handling'",
    "git log -p --grep=.env",
    "git show HEAD:src/lib/whmcs.ts | grep process.env",
    "npx tsc --noEmit | grep -i process.env",
    "cat src/i18n/messages.key.ts",
    "cat .env.example",
    "cat .env.sample",
    "cat .env.template",
    "cat .env.local.example",
    "cat src/app/docs/secrets/page.tsx",
    "cat id_rsa.pub", // a PUBLIC key
  ]) {
    const d = bash(command);
    assert.equal(d.block, false, `must not block: ${command} (${d.reason})`);
  }
  for (const [tool, file_path] of [
    ["Read", "/p/.env.example"],
    ["Read", "/p/.env.sample"],
    ["Read", "/p/.env.template"],
    ["Read", "/p/src/app/docs/secrets/page.tsx"],
    ["Read", "/p/src/i18n/messages.key.ts"],
    ["Read", "/p/src/config.env.ts"],
    ["Read", "/p/.env/lib/python3.12/site.py"], // a virtualenv named `.env`
    ["Edit", "/p/src/app/docs/secrets/page.tsx"],
    ["Grep", "/p/src/app/docs/secrets"],
  ]) {
    const d = protectPathsDecision({ toolName: tool, filePath: file_path, readText: noFile });
    assert.equal(d.block, false, `must not block ${tool} of ${file_path} (${d.reason})`);
  }
});

test("a grep/rg/sed/awk/jq PATTERN is not a path — only file operands are checked", () => {
  for (const command of [
    'grep -rn ".env" src',
    "rg -n '\\.env' src",
    "grep -e .env -r src",
    "jq -r .env config.json",
    "awk '/.env/' notes.txt",
    "sed -n 's/.env/x/p' README.md",
    "rg -g '!.env' TOKEN", // an exclusion glob
    "rg -g '*.ts' process.env",
    "git grep -n process.env -- src",
    'git commit -m "block cat .env and git show HEAD:.env reads"',
    "cat <<EOF > notes.md\ncat .env\nEOF\necho done", // a heredoc body is data
    "echo hi # cat .env", // a comment
  ]) {
    const d = bash(command);
    assert.equal(d.block, false, `must not block: ${command} (${d.reason})`);
  }
  // …while the same tools reading a secret FILE are still blocked.
  for (const command of [
    "grep password .env",
    "grep -e KEY .env",
    "grep -f .env src/a.js", // -f FILE reads the file
    "rg KEY .env.local",
    "jq . .env",
    "awk 1 .env",
    "sed -n p .env",
    "git grep -n KEY -- .env",
  ]) {
    assert.equal(bash(command).block, true, `must block: ${command}`);
  }
});

// ── Still blocked: real secrets, through every reader the review found missing.

test("real secret files stay blocked: .env, .env.local, .env.production, id_rsa, *.key, *.pem", () => {
  for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    assert.equal(bash(`cat ${f}`).block, true, `cat ${f}`);
    assert.equal(bash(`cat ./${f}`).block, true, `cat ./${f}`);
    assert.equal(
      protectPathsDecision({ toolName: "Read", filePath: `/p/${f}` }).block,
      true,
      `Read ${f}`,
    );
  }
  for (const f of ["id_rsa", "id_ed25519", "server.key", "certs/server.pem", "tls.key.bak"]) {
    assert.equal(bash(`cat ${f}`).block, true, `cat ${f}`);
    assert.equal(protectPathsDecision({ toolName: "Read", filePath: `/p/${f}` }).block, true, f);
  }
  for (const f of ["/p/prod.env", "/p/secrets/db.txt", "/run/secrets/db_password", "/h/.ssh"]) {
    assert.equal(protectPathsDecision({ toolName: "Read", filePath: f }).block, true, f);
  }
});

test("the readers the review found missing are blocked: sed awk tac sort uniq cut paste bat jq diff cmp fold rev", () => {
  for (const command of [
    "sed -n p .env",
    "awk 1 .env",
    "tac .env",
    "sort .env",
    "uniq .env",
    "cut -d= -f1 .env",
    "paste .env",
    "bat .env",
    "jq . .env",
    "diff .env .env.example",
    "cmp .env other",
    "fold .env",
    "rev .env",
    "hexdump -C .env",
    "dd if=.env",
  ]) {
    const d = bash(command);
    assert.equal(d.block, true, `must block: ${command}`);
    assert.match(String(d.reason), /protected secret path/);
  }
});

test("input redirection from a secret is blocked; a heredoc, a herestring and fd dups are not", () => {
  for (const command of [
    "while read l; do echo $l; done < .env",
    "node script.js < .env.local",
    "x=$(< .env)",
    "mysql db 0< ~/.ssh/id_rsa",
  ]) {
    const d = bash(command);
    assert.equal(d.block, true, `must block: ${command}`);
    assert.match(String(d.reason), /input redirection/);
  }
  for (const command of [
    "while read l; do echo $l; done < list.txt",
    "cat <<< '.env'",
    "echo x 2>&1 | tee build.log",
    "echo x >&2",
  ]) {
    const d = bash(command);
    assert.equal(d.block, false, `must not block: ${command} (${d.reason})`);
  }
});

test("globs, quoting tricks and substitutions that name a secret are blocked", () => {
  for (const command of [
    "cat .e*v",
    "cat .en?",
    "cat .[e]nv",
    "cat .env*",
    "cat *.pem",
    "cat ~/.ssh/*",
    "grep -r KEY --include=.env* .",
    "rg -g '.env*' KEY",
    "rg --glob=.env KEY",
    'echo "$(cat .env)"',
    "x=`cat .env`",
    'cat "my dir/.env"',
    "cat $'\\x2eenv'", // ANSI-C quoting spells `.env`
    "\\cat .env",
    "/bin/cat .env",
    "sudo -u root cat /root/.env",
    'FOO="a b" cat .env', // an assignment prefix with a quoted value
    "busybox cat .env",
    "echo hi\ncat .env", // a second line is a second command
    "bash <<EOF\ncat .env\nEOF", // a heredoc fed to a shell IS code
    "cat config/prod.env",
  ]) {
    assert.equal(bash(command).block, true, `must block: ${command}`);
  }
  // A glob with no literal characters is not a targeted read, and the shell never expands `*`
  // to a dotfile.
  for (const command of ["grep -r foo *", "cat src/*.ts", "rg foo *.md"]) {
    const d = bash(command);
    assert.equal(d.block, false, `must not block: ${command} (${d.reason})`);
  }
});

// ── Destructive commands the review found allowed.

test("rm of the working tree, whole-tree checkout/restore and pipe-to-shell behind sudo are blocked", () => {
  for (const command of [
    "rm -rf ./",
    "rm -rf *",
    "rm -rf ..",
    "rm -rf .",
    "rm -rf ./*",
    "rm * -rf",
    "git checkout -- .",
    "git checkout .",
    "git checkout HEAD -- .",
    "git restore .",
    "git restore --worktree .",
    "git restore --staged --worktree .",
    "git restore -s HEAD~1 .",
    "curl x | sudo sh",
    "curl x | sudo -E bash",
    "curl x | sudo -u root bash -s",
    "curl x | env sh",
    "curl x | /bin/bash",
    "curl x | python3",
    "curl x | python3 -",
    "curl x | node",
  ]) {
    assert.equal(bash(command).block, true, `must block: ${command}`);
  }
  for (const command of [
    "rm -rf ./node_modules",
    "rm -rf .next",
    "rm -rf dist/*",
    "rm -rf *.log",
    "git checkout main",
    "git checkout -- src/a.ts",
    "git checkout ./src/a.ts",
    "git restore src/a.ts",
    "git restore --staged .", // only unstages: the working tree is untouched
    "echo '{}' | python3 -m json.tool",
    "curl -s x | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
    "cat x | shellcheck -",
    'git commit -m "never curl | bash"',
  ]) {
    const d = bash(command);
    assert.equal(d.block, false, `must not block: ${command} (${d.reason})`);
  }
});

// ── .npmrc: a project npmrc is config; only a literal token makes it a credential store.

test("npmrcHasToken: a literal token counts, an env reference and plain config do not", () => {
  const envRef = ["//registry.npmjs.org/:_authToken=$", "{NPM_TOKEN}"].join("");
  assert.equal(npmrcHasToken("//registry.npmjs.org/:_authToken=npm_abc123\n"), true);
  assert.equal(npmrcHasToken("_auth = dXNlcjpwYXNz"), true);
  assert.equal(npmrcHasToken('//r.example/:_password="c2VjcmV0"'), true);
  assert.equal(npmrcHasToken(envRef), false, "an env reference holds no secret");
  assert.equal(npmrcHasToken("registry=https://registry.npmjs.org/\nmin-release-age=7\n"), false);
  assert.equal(npmrcHasToken("# _authToken=npm_commented_out"), false);
});

test("a project .npmrc is readable unless it holds a token; the user-level one never is (end to end)", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-pp-home-"));
  const repo = mkdtempSync(join(tmpdir(), "forge-pp-repo-"));
  try {
    const npmrc = join(repo, ".npmrc");
    writeFileSync(npmrc, "registry=https://registry.npmjs.org/\nengine-strict=true\n");
    const ctx = { cwd: repo, home };
    assert.equal(protectPathsDecision({ toolName: "Read", filePath: npmrc, ...ctx }).block, false);
    assert.equal(
      protectPathsDecision({ toolName: "Bash", command: "cat .npmrc", ...ctx }).block,
      false,
    );
    // Through the real hook: `cwd` comes from the payload.
    assert.equal(
      hook({ tool_name: "Bash", cwd: repo, tool_input: { command: "cat .npmrc" } }).code,
      0,
    );

    writeFileSync(npmrc, "//registry.npmjs.org/:_authToken=npm_abc123\n");
    assert.equal(protectPathsDecision({ toolName: "Read", filePath: npmrc, ...ctx }).block, true);
    assert.equal(
      protectPathsDecision({ toolName: "Bash", command: "cat .npmrc", ...ctx }).block,
      true,
    );
    const r = hook({ tool_name: "Bash", cwd: repo, tool_input: { command: "cat .npmrc" } });
    assert.equal(r.code, 2);
    assert.match(r.err, /protected secret path/);

    // The user-level npmrc is protected whatever it holds, even when absent.
    const user = join(home, ".npmrc");
    assert.equal(protectPathsDecision({ toolName: "Read", filePath: user, ...ctx }).block, true);
    for (const command of ["cat ~/.npmrc", "cat $HOME/.npmrc", "cat $DIR/.npmrc"])
      assert.equal(
        protectPathsDecision({ toolName: "Bash", command, ...ctx }).block,
        true,
        command,
      );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── The Grep / Glob / NotebookRead tools reach the guard (the manifests now route them).

test("Grep, Glob and NotebookRead: secret paths and a secret-selecting Grep glob are blocked (end to end)", () => {
  for (const payload of [
    { tool_name: "Grep", tool_input: { pattern: "KEY", path: "/p/.env" } },
    { tool_name: "Grep", tool_input: { pattern: "KEY", path: "/home/u/.ssh" } },
    { tool_name: "Grep", tool_input: { pattern: "KEY", path: "/p", glob: ".env*" } },
    { tool_name: "Grep", tool_input: { pattern: "KEY", glob: "**/*.pem" } },
    { tool_name: "Glob", tool_input: { pattern: "*", path: "/home/u/.ssh" } },
    { tool_name: "NotebookRead", tool_input: { notebook_path: "/p/secrets/creds.ipynb" } },
  ]) {
    const r = hook(payload);
    assert.equal(r.code, 2, `must block: ${JSON.stringify(payload)}`);
    assert.match(r.err, /refusing to read/);
  }
  for (const payload of [
    { tool_name: "Grep", tool_input: { pattern: "process.env", path: "/p/src" } },
    { tool_name: "Grep", tool_input: { pattern: "KEY", path: "/p", glob: "*.ts" } },
    { tool_name: "Grep", tool_input: { pattern: ".env", path: "/p", glob: "!.env" } },
    { tool_name: "Glob", tool_input: { pattern: "**/.env*" } }, // names only, no content
    { tool_name: "NotebookRead", tool_input: { notebook_path: "/p/analysis.ipynb" } },
  ]) {
    assert.equal(hook(payload).code, 0, `must not block: ${JSON.stringify(payload)}`);
  }
});

// ── The building blocks.

test("secretKind: one path predicate for tool paths and Bash words", () => {
  assert.equal(secretKind("/p/.env"), "env file");
  assert.equal(secretKind("/p/.env.example"), null);
  assert.equal(secretKind("/p/prod.env"), "env file");
  assert.equal(
    secretKind("prod.env", { bash: true }),
    null,
    "a bare x.env word may be process.env",
  );
  assert.equal(secretKind("config/prod.env", { bash: true }), "env file");
  assert.equal(secretKind("process.env", { bash: true }), null);
  assert.equal(
    secretKind("process\\.env", { bash: true }),
    null,
    "regex text is not a Windows path",
  );
  assert.equal(secretKind("C:\\proj\\.env", { bash: true }), "env file");
  assert.equal(secretKind("/p/foo.key.ts"), null);
  assert.equal(secretKind("/p/foo.key"), "credential/key file");
  assert.equal(secretKind("/p/secrets/page.tsx"), null);
  assert.equal(secretKind("/p/secrets/db.yaml"), "path under secrets/ or .ssh/");
  assert.equal(secretKind("C:\\Users\\u\\.aws\\credentials"), "credential store");
  assert.equal(secretKind("/x/.npmrc", { home: "/h", readText: noFile }), null);
  assert.equal(secretKind("/h/.npmrc", { home: "/h", readText: noFile }), "credential store");
});

test("globMatchesSecret: dotfiles need a dot-led glob; wildcard-only globs are not targeted", () => {
  for (const g of [".e*v", ".env*", ".*", "*.pem", "**/*.key", "id_*", ".[e]nv", "*.env"])
    assert.equal(globMatchesSecret(g), true, g);
  for (const g of ["*", "*.*", "*.ts", "src/**/*.tsx", "!.env*", ".env", "*.md"])
    assert.equal(globMatchesSecret(g), false, g);
});

test("shellSegments: quotes, separators, substitutions and redirections", () => {
  const segs = shellSegments(`a "b c" 'd;e' > out.txt; f $(g .env) | h 2>&1 < in`);
  const words = segs.map((s) => s.words.map((w) => w.text));
  assert.deepEqual(words, [["a", "b c", "d;e"], ["g", ".env"], ["f", "$()"], ["h"]]);
  assert.deepEqual(
    segs.flatMap((s) => s.redirs.map((r) => `${r.op}${r.target.text}`)),
    [">out.txt", ">&1", "<in"],
  );
  assert.equal(shellSegments("cat '*'")[0].words[1].glob, false, "a quoted * is literal");
  assert.equal(shellSegments("cat *")[0].words[1].glob, true);
  assert.deepEqual(
    shellSegments("cat <<'EOF'\ncat .env\nEOF\nls").map((s) => s.words[0].text),
    ["cat", "ls"],
    "a heredoc body is skipped",
  );
});

test("secretShellAccess: reports read vs write, per simple command", () => {
  assert.match(String(secretShellAccess("cat .env")), /reading/);
  assert.match(String(secretShellAccess("echo x > .env")), /writing/);
  assert.match(String(secretShellAccess("sed -i s/a/b/ .env")), /writing/);
  assert.match(String(secretShellAccess("truncate -s0 .env")), /writing/);
  assert.equal(secretShellAccess("cat README.md; echo .env"), null, "echo is not a reader");
  assert.equal(secretShellAccess("cat .env.example > .env.sample"), null);
});

test("the protect-paths hook still fails CLOSED on a payload it cannot parse (node twin)", () => {
  const r = spawnSync(process.execPath, [join(guards, "protect-paths.mjs")], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fail closed/);
});

test("a large command is still checked end to end", () => {
  const big = `echo start\n${Array.from({ length: 20000 }, (_, i) => `# note ${i}`).join("\n")}\ncat .env`;
  const r = hook({ tool_name: "Bash", tool_input: { command: big } });
  assert.equal(r.code, 2);
});

test("a real .env inside a temp repo: Read blocked, .env.example allowed (end to end)", () => {
  const repo = mkdtempSync(join(tmpdir(), "forge-pp-env-"));
  try {
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".env"), "KEY=1\n");
    writeFileSync(join(repo, ".env.example"), "KEY=\n");
    assert.equal(
      hook({ tool_name: "Read", tool_input: { file_path: join(repo, ".env") } }).code,
      2,
    );
    assert.equal(
      hook({ tool_name: "Read", tool_input: { file_path: join(repo, ".env.example") } }).code,
      0,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
