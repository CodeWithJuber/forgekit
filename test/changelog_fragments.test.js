import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  foldFragments,
  fragmentErrors,
  readFragments,
  splitSections,
} from "../src/changelog_fragments.js";
import { docsCheck } from "../src/docs_check.js";
import { roughCount } from "../src/docs_render.js";

test("splitSections and foldFragments keep Keep a Changelog order and every entry", () => {
  const { sections } = splitSections("### fixed\n\n- a\n\n### Added\n- b\n");
  assert.deepEqual([...sections.keys()], ["Fixed", "Added"], "headings are case-insensitive");
  const body = foldFragments("### Fixed\n\n- existing fix", [
    { file: "changelog.d/x.md", text: "### Security\n\n- s\n" },
    { file: "changelog.d/y.md", text: "### Fixed\n\n- new fix\n\n### Added\n\n- new feature\n" },
  ]);
  assert.equal(
    body,
    "### Added\n\n- new feature\n\n### Fixed\n\n- existing fix\n- new fix\n\n### Security\n\n- s",
  );
  assert.equal(foldFragments("", []), "");
});

test("fragmentErrors names a missing or unknown section and stray text", () => {
  const errs = fragmentErrors([
    { file: "changelog.d/ok.md", text: "### Added\n\n- fine\n" },
    { file: "changelog.d/none.md", text: "- no heading\n" },
    { file: "changelog.d/odd.md", text: "### Improved\n\n- not a section\n" },
  ]);
  assert.deepEqual(
    [...new Set(errs.map((e) => e.file))],
    ["changelog.d/none.md", "changelog.d/odd.md"],
  );
  assert.match(errs.map((e) => e.detail).join("\n"), /unknown section "Improved"/);
});

test("readFragments: null without the directory; README.md is not a fragment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-frag-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(readFragments(root), null);
  mkdirSync(join(root, "changelog.d"));
  writeFileSync(join(root, "changelog.d", "README.md"), "# how\n");
  writeFileSync(join(root, "changelog.d", "b.md"), "### Fixed\n\n- b\n");
  writeFileSync(join(root, "changelog.d", "a.md"), "### Added\n\n- a\n");
  assert.deepEqual(
    readFragments(root)?.map((f) => f.file),
    ["changelog.d/a.md", "changelog.d/b.md"],
  );
});

test("docs check: with changelog.d/, entries under [Unreleased] and bad fragments are errors", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-frag-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (/** @type {string[]} */ ...a) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
  git("init", "-q");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  const changelog = (/** @type {string} */ unreleased) =>
    `# Changelog\n\n## [Unreleased]\n${unreleased}\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- first\n`;
  mkdirSync(join(root, "changelog.d"));
  writeFileSync(join(root, "changelog.d", "a.md"), "### Added\n\n- pending\n");
  writeFileSync(join(root, "CHANGELOG.md"), changelog(""));
  const errors = () =>
    docsCheck({ root })
      .issues.filter((i) => i.check === "changelog")
      .map((i) => i.detail);
  assert.deepEqual(errors(), []);
  writeFileSync(join(root, "CHANGELOG.md"), changelog("\n### Fixed\n\n- written by hand\n"));
  assert.match(errors().join("\n"), /collects them in changelog\.d\//);
  writeFileSync(join(root, "CHANGELOG.md"), changelog(""));
  writeFileSync(join(root, "changelog.d", "bad.md"), "- no section\n");
  assert.match(errors().join("\n"), /changelog\.d\/bad\.md: no entry/);
});

test("roughCount: exact below 20, tens with a plus above", () => {
  assert.deepEqual([1, 19, 20, 29, 249, 511].map(roughCount), [
    "1",
    "19",
    "20+",
    "20+",
    "240+",
    "510+",
  ]);
});
