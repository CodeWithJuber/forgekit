import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveText } from "../scripts/resolve-conflicts.mjs";

const hunk = (
  /** @type {string[]} */ ours,
  /** @type {string[]} */ base,
  /** @type {string[]} */ theirs,
) =>
  [
    "<<<<<<< HEAD",
    ...ours,
    "||||||| base",
    ...base,
    "=======",
    ...theirs,
    ">>>>>>> origin/master",
  ].join("\n");

test("both sides only inserted lines: keep both, the base branch's first", () => {
  const text = ["| a |", hunk(["| mine |"], [], ["| theirs |"]), "| z |"].join("\n");
  const r = resolveText(text);
  assert.deepEqual(r, {
    text: "| a |\n| theirs |\n| mine |\n| z |",
    resolved: 1,
    unresolved: 0,
    rendered: 0,
  });
});

test("an identical line added on both sides is kept once", () => {
  const r = resolveText(hunk(["- same", "- mine"], [], ["- same"]));
  assert.equal(r.text, "- same\n- mine");
});

test("both sides edited the same existing line: left for a person", () => {
  const text = hunk(["Version two, mine."], ["Version one."], ["Version two, theirs."]);
  const r = resolveText(text);
  assert.equal(r.unresolved, 1);
  assert.equal(r.text, text, "markers stay so a person sees both sides");
});

test("inside a forge:render block: take the base branch's side for docs render to rebuild", () => {
  const text = [
    "<!-- forge:render:repo-map:begin -->",
    hunk(
      ['  src["src<br/>250+ files"]'],
      ['  src["src<br/>240+ files"]'],
      ['  src["src<br/>260+ files"]'],
    ),
    "<!-- forge:render:repo-map:end -->",
    "after",
  ].join("\n");
  const r = resolveText(text);
  assert.equal(r.unresolved, 0);
  assert.equal(r.rendered, 1);
  assert.match(r.text, /260\+ files/);
  assert.doesNotMatch(r.text, /<<<<<<<|250\+/);
});

test("end to end: two branches each add a table row at the same spot", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-resolve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (/** @type {string[]} */ ...a) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      cwd: root,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "master");
  git("config", "core.autocrlf", "false"); // byte-exact on Windows runners too
  writeFileSync(join(root, "EVIDENCE.md"), "| A | 1 |\n| Z | 9 |\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "EVIDENCE.md"), "| A | 1 |\n| Mine | 2 |\n| Z | 9 |\n");
  git("commit", "-qam", "mine");
  git("checkout", "-q", "master");
  writeFileSync(join(root, "EVIDENCE.md"), "| A | 1 |\n| Theirs | 3 |\n| Z | 9 |\n");
  git("commit", "-qam", "theirs");
  git("checkout", "-q", "feature");
  assert.throws(() => git("merge", "--no-edit", "master"), "a plain merge conflicts");
  const script = resolve("scripts/resolve-conflicts.mjs");
  execFileSync(process.execPath, [script, "--commit"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  assert.equal(
    readFileSync(join(root, "EVIDENCE.md"), "utf8"),
    "| A | 1 |\n| Theirs | 3 |\n| Mine | 2 |\n| Z | 9 |\n",
  );
  assert.equal(git("status", "--porcelain"), "", "merge committed, tree clean");
});

test("a CRLF checkout (Windows) resolves the same and keeps CRLF", () => {
  const text = ["| a |", hunk(["| mine |"], [], ["| theirs |"]), "| z |", ""].join("\r\n");
  const r = resolveText(text);
  assert.equal(r.unresolved, 0);
  assert.equal(r.text, "| a |\r\n| theirs |\r\n| mine |\r\n| z |\r\n");
});
