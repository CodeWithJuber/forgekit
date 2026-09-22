import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BEGIN,
  END,
  ensureForgePrivateIgnored,
  ensureGitignoreBlock,
  readGitignoreBlock,
  removeGitignoreBlock,
} from "../src/gitignore.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-gitignore-"));
const giPath = (root) => join(root, ".gitignore");
const read = (root) => readFileSync(giPath(root), "utf8");

test("creates the block in a repo with no .gitignore", () => {
  const root = tmp();
  const r = ensureGitignoreBlock(root, [".cursor/mcp.json", ".zed/settings.json"]);
  assert.equal(r.action, "written");
  const text = read(root);
  assert.match(text, new RegExp(BEGIN));
  assert.match(text, new RegExp(END));
  assert.deepEqual(readGitignoreBlock(root), [".cursor/mcp.json", ".zed/settings.json"]);
});

test("preserves user lines above and below the block", () => {
  const root = tmp();
  writeFileSync(giPath(root), "node_modules\n*.log\n");
  ensureGitignoreBlock(root, [".gemini/settings.json"]);
  const text = read(root);
  assert.match(text, /^node_modules\n\*\.log\n/);
  // user lines are untouched byte-for-byte
  assert.ok(text.startsWith("node_modules\n*.log\n"));
  assert.deepEqual(readGitignoreBlock(root), [".gemini/settings.json"]);
});

test("is idempotent — a second identical call writes nothing", () => {
  const root = tmp();
  const paths = [".codex/config.toml", ".aider.conf.yml"];
  ensureGitignoreBlock(root, paths);
  const first = read(root);
  const r2 = ensureGitignoreBlock(root, paths);
  assert.equal(r2.action, "unchanged");
  assert.equal(read(root), first);
});

test("normalizes order/dupes so re-running with shuffled paths is a no-op", () => {
  const root = tmp();
  ensureGitignoreBlock(root, [".b", ".a", ".b"]);
  const r2 = ensureGitignoreBlock(root, [".a", ".b"]);
  assert.equal(r2.action, "unchanged");
  assert.deepEqual(readGitignoreBlock(root), [".a", ".b"]);
});

test("updates the block in place without duplicating markers", () => {
  const root = tmp();
  writeFileSync(giPath(root), "dist/\n");
  ensureGitignoreBlock(root, [".cursor/mcp.json"]);
  ensureGitignoreBlock(root, [".zed/settings.json", ".gemini/settings.json"]);
  const text = read(root);
  assert.equal((text.match(new RegExp(BEGIN, "g")) || []).length, 1);
  assert.equal((text.match(new RegExp(END, "g")) || []).length, 1);
  assert.ok(text.startsWith("dist/\n"));
  assert.deepEqual(readGitignoreBlock(root), [".gemini/settings.json", ".zed/settings.json"]);
});

test("handles a file with no trailing newline — block starts on its own line", () => {
  const root = tmp();
  writeFileSync(giPath(root), "secret.env"); // no trailing \n
  ensureGitignoreBlock(root, [".cursor/mcp.json"]);
  const text = read(root);
  assert.ok(text.startsWith("secret.env\n"), "user line kept on its own line");
  assert.ok(!text.includes(`secret.env${BEGIN}`), "block never merged onto the user line");
  assert.match(text, new RegExp(`\\n${BEGIN}`));
});

test("removeGitignoreBlock strips ONLY the block, leaving user lines", () => {
  const root = tmp();
  writeFileSync(giPath(root), "node_modules\ncoverage/\n");
  ensureGitignoreBlock(root, [".zed/settings.json"]);
  const r = removeGitignoreBlock(root);
  assert.equal(r.action, "removed");
  const text = read(root);
  assert.equal(text, "node_modules\ncoverage/\n");
  assert.deepEqual(readGitignoreBlock(root), []);
});

test("empty paths removes the block", () => {
  const root = tmp();
  ensureGitignoreBlock(root, [".cursor/mcp.json"]);
  const r = ensureGitignoreBlock(root, []);
  assert.equal(r.action, "removed");
  assert.deepEqual(readGitignoreBlock(root), []);
});

test("removeGitignoreBlock on a missing / block-free file is a no-op", () => {
  const root = tmp();
  assert.equal(removeGitignoreBlock(root).action, "unchanged");
  writeFileSync(giPath(root), "just-user\n");
  assert.equal(removeGitignoreBlock(root).action, "unchanged");
  assert.equal(read(root), "just-user\n");
});

// B5: session hook logs (raw prompts/commands) under .forge/sessions/ must never be
// committable, without touching the user's own root .gitignore.
test("ensureForgePrivateIgnored keeps .forge/sessions out of git (B5)", () => {
  const root = tmp();
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  writeFileSync(join(root, ".forge", "sessions", "s1.jsonl"), "{}\n");
  writeFileSync(join(root, ".forge", "decisions.md"), "# decisions\n");
  assert.equal(ensureForgePrivateIgnored(root).action, "written");
  const ignored = (p) => {
    try {
      execFileSync("git", ["check-ignore", "-q", p], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ignored(".forge/sessions/s1.jsonl"), true, "session logs are ignored");
  assert.equal(ignored(".forge/decisions.md"), false, "committable .forge content is not");
  assert.equal(ensureForgePrivateIgnored(root).action, "unchanged", "idempotent");
  // An existing .forge/.gitignore keeps its lines; only the missing entry is appended.
  const other = tmp();
  mkdirSync(join(other, ".forge"), { recursive: true });
  writeFileSync(join(other, ".forge", ".gitignore"), "cache/");
  ensureForgePrivateIgnored(other);
  assert.equal(readFileSync(join(other, ".forge", ".gitignore"), "utf8"), "cache/\nsessions/\n");
});
