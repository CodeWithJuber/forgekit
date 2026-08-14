import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyUpdateTo, updateStatus } from "../src/update.js";

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

// A repo with two commits and a release tag on the first — the pin/downgrade shape.
// No remote at all: `git fetch --tags` inside applyUpdateTo must fail fast and be
// swallowed (offline-safe), with the tag resolved locally.
function taggedRepo() {
  const work = mkdtempSync(join(tmpdir(), "forge-upd-tag-"));
  const g = (...a) => execFileSync("git", a, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "t@t.invalid");
  g("config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "1\n");
  g("add", "-A");
  g("-c", "commit.gpgsign=false", "commit", "-qm", "one");
  g("tag", "v0.2.0");
  g("tag", "0.3.0"); // a bare (un-prefixed) tag must resolve too
  writeFileSync(join(work, "a.txt"), "2\n");
  g("add", "-A");
  g("-c", "commit.gpgsign=false", "commit", "-qm", "two");
  const rev = (ref) => g("rev-parse", ref).toString().trim();
  return { work, g, rev };
}

test("applyUpdateTo: pins a git checkout to the release tag (detached)", () => {
  const { work, rev } = taggedRepo();
  const r = applyUpdateTo("0.2.0", { root: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.tag, "v0.2.0");
  assert.equal(r.changed, true);
  assert.equal(rev("HEAD"), rev("v0.2.0"));
  assert.match(r.note || "", /detached at v0\.2\.0/);
});

test("applyUpdateTo: accepts a leading v and is idempotent (changed:false)", () => {
  const { work } = taggedRepo();
  assert.equal(applyUpdateTo("v0.2.0", { root: work }).ok, true);
  const again = applyUpdateTo("v0.2.0", { root: work });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test("applyUpdateTo: resolves a bare (un-prefixed) tag", () => {
  const { work, rev } = taggedRepo();
  const r = applyUpdateTo("0.3.0", { root: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.tag, "0.3.0");
  assert.equal(rev("HEAD"), rev("0.3.0"));
});

test("applyUpdateTo: unknown version is an honest miss, never a throw", () => {
  const { work, rev } = taggedRepo();
  const before = rev("HEAD");
  const r = applyUpdateTo("9.9.9", { root: work });
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /no release tag v9\.9\.9/);
  assert.equal(rev("HEAD"), before, "a miss must not move HEAD");
});

test("applyUpdateTo: missing / flag-shaped version fails before touching git", () => {
  for (const bad of [undefined, "", "  ", "--json"]) {
    const r = applyUpdateTo(/** @type {string} */ (bad), {
      root: "/nonexistent-root",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason || "", /missing version/);
  }
});

test("applyUpdateTo: non-git install gets the exact npm pin instruction", () => {
  const bare = mkdtempSync(join(tmpdir(), "forge-upd-"));
  writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "@scope/kit" }));
  const r = applyUpdateTo("0.17.0", { root: bare });
  assert.equal(r.ok, false);
  assert.equal(r.mode, "npm-or-copy");
  assert.equal(r.instruction, "npm install -g @scope/kit@0.17.0");
});

test("applyUpdateTo: dirty tree → honest checkout failure, no throw", () => {
  const { work, rev } = taggedRepo();
  const before = rev("HEAD");
  writeFileSync(join(work, "a.txt"), "uncommitted\n"); // conflicts with the tag's a.txt
  const r = applyUpdateTo("0.2.0", { root: work });
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /checkout failed/);
  assert.equal(rev("HEAD"), before);
});

test("CLI: forge update --to with no version reports usage via --json", () => {
  const bare = mkdtempSync(join(tmpdir(), "forge-upd-"));
  const r = execFileSync("node", [CLI, "update", "--to", "--json"], {
    cwd: bare,
    encoding: "utf8",
  });
  const parsed = JSON.parse(r);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /missing version/);
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
