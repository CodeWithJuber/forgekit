import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { updateStatus } from "../src/update.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// A local "remote" + a clone that tracks it, so behind-count is testable without network.
function trackedClone() {
  const remote = mkdtempSync(join(tmpdir(), "forge-upd-remote-"));
  const g = (root, ...a) =>
    execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  g(remote, "init", "-q", "--bare");
  const work = mkdtempSync(join(tmpdir(), "forge-upd-work-"));
  g(work, "init", "-q");
  g(work, "config", "user.email", "t@t.invalid");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "1\n");
  g(work, "add", "-A");
  g(work, "-c", "commit.gpgsign=false", "commit", "-qm", "one");
  g(work, "branch", "-M", "main");
  g(work, "remote", "add", "origin", remote);
  g(work, "push", "-q", "-u", "origin", "main");
  return { remote, work, g };
}

test("updateStatus: a checkout level with upstream reports behind:0", () => {
  const { work } = trackedClone();
  const s = updateStatus({ root: work, fetch: false });
  assert.equal(s.mode, "git");
  assert.equal(s.behind, 0);
});

test("updateStatus: upstream ahead of HEAD → behind>0", () => {
  const { work, g } = trackedClone();
  // Advance the remote by one commit, then rewind the local HEAD: origin/main now leads
  // HEAD by one — exactly the "a newer version is available" state, no network needed.
  writeFileSync(join(work, "a.txt"), "2\n");
  g(work, "add", "-A");
  g(work, "-c", "commit.gpgsign=false", "commit", "-qm", "two");
  g(work, "push", "-q", "origin", "main");
  g(work, "reset", "--hard", "HEAD~1");
  const s = updateStatus({ root: work, fetch: false });
  assert.equal(s.behind, 1, JSON.stringify(s));
});

test("updateStatus: non-git install is safe (unknown, never throws)", () => {
  const bare = mkdtempSync(join(tmpdir(), "forge-upd-"));
  const s = updateStatus({ root: bare, fetch: false });
  assert.equal(s.unknown, true);
  assert.equal(s.behind, 0);
  assert.equal(s.mode, "npm-or-copy");
});

test("CLI: forge update --check --json never sets a failing exit code", () => {
  const bare = mkdtempSync(join(tmpdir(), "forge-upd-"));
  const r = execFileSync("node", [CLI, "update", "--check", "--json"], {
    cwd: bare,
    encoding: "utf8",
  });
  const parsed = JSON.parse(r);
  assert.ok("behind" in parsed && "current" in parsed);
});
