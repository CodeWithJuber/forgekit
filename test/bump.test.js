import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyBump,
  collectVersions,
  computeNext,
  extractUnreleased,
  inferKindFromChangelog,
  inferKindFromCommits,
  parseVersion,
  rotateChangelog,
  setJsonVersionText,
} from "../scripts/bump.mjs";

// ---------------------------------------------------------------------------
// version math
// ---------------------------------------------------------------------------

test("parseVersion parses X.Y.Z and rejects garbage", () => {
  assert.deepEqual(parseVersion("0.4.0"), { major: 0, minor: 4, patch: 0 });
  assert.deepEqual(parseVersion("12.34.56"), { major: 12, minor: 34, patch: 56 });
  assert.throws(() => parseVersion("1.2"), /unsupported version format/);
  assert.throws(() => parseVersion("1.2.3-beta.1"), /unsupported version format/);
  assert.throws(() => parseVersion("v1.2.3"), /unsupported version format/);
});

test("computeNext bumps patch/minor/major with correct resets", () => {
  assert.equal(computeNext("0.4.0", "patch"), "0.4.1");
  assert.equal(computeNext("0.4.9", "minor"), "0.5.0");
  assert.equal(computeNext("0.4.9", "major"), "1.0.0");
  assert.equal(computeNext("1.2.3", "minor"), "1.3.0");
  assert.equal(computeNext("1.2.3", "major"), "2.0.0");
});

test("computeNext rejects unknown kinds", () => {
  assert.throws(() => computeNext("1.0.0", "auto"), /unknown bump kind/);
  assert.throws(() => computeNext("1.0.0", ""), /unknown bump kind/);
});

// ---------------------------------------------------------------------------
// auto heuristic: conventional commits
// ---------------------------------------------------------------------------

test("inferKindFromCommits: feat -> minor, fix/docs/chore -> patch", () => {
  assert.equal(inferKindFromCommits([{ subject: "fix: a" }, { subject: "docs: b" }]), "patch");
  assert.equal(inferKindFromCommits([{ subject: "chore(deps): bump x" }]), "patch");
  assert.equal(inferKindFromCommits([{ subject: "fix: a" }, { subject: "feat: b" }]), "minor");
  assert.equal(inferKindFromCommits([{ subject: "feat(cli): add flag" }]), "minor");
});

test("inferKindFromCommits: BREAKING wins over everything", () => {
  assert.equal(inferKindFromCommits([{ subject: "feat!: drop node 18" }]), "major");
  assert.equal(inferKindFromCommits([{ subject: "refactor(core)!: rename" }]), "major");
  assert.equal(
    inferKindFromCommits([{ subject: "feat: x", body: "BREAKING CHANGE: config renamed" }]),
    "major",
  );
});

test("inferKindFromCommits: non-conventional commits default to patch, none -> null", () => {
  assert.equal(inferKindFromCommits([{ subject: "Merge pull request #30" }]), "patch");
  assert.equal(inferKindFromCommits([]), null);
  assert.equal(inferKindFromCommits(null), null);
});

// ---------------------------------------------------------------------------
// auto heuristic: CHANGELOG fallback
// ---------------------------------------------------------------------------

test("inferKindFromChangelog: BREAKING -> major, Added -> minor, other -> patch, empty -> null", () => {
  assert.equal(inferKindFromChangelog("### Changed\n\n- BREAKING: renamed the config"), "major");
  assert.equal(inferKindFromChangelog("### Added\n\n- new command"), "minor");
  assert.equal(inferKindFromChangelog("### Fixed\n\n- a bug"), "patch");
  assert.equal(inferKindFromChangelog("\n\n"), null);
  assert.equal(inferKindFromChangelog(""), null);
});

// ---------------------------------------------------------------------------
// CHANGELOG rotation
// ---------------------------------------------------------------------------

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- shiny new thing

## [0.4.0] - 2026-07-06

### Added

- old thing

[Unreleased]: https://github.com/o/r/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/o/r/compare/v0.3.1...v0.4.0
`;

test("extractUnreleased returns only the [Unreleased] body", () => {
  const body = extractUnreleased(CHANGELOG);
  assert.match(body, /shiny new thing/);
  assert.doesNotMatch(body, /old thing/);
  assert.equal(extractUnreleased("# nope\n"), null);
});

test("rotateChangelog moves [Unreleased] under a dated heading and rewrites links", () => {
  const out = rotateChangelog(CHANGELOG, "0.5.0", "0.4.0", "2026-07-07");
  assert.match(
    out,
    /## \[Unreleased\]\n\n## \[0\.5\.0\] - 2026-07-07\n\n### Added\n\n- shiny new thing/,
  );
  assert.match(out, /\[Unreleased\]: https:\/\/github\.com\/o\/r\/compare\/v0\.5\.0\.\.\.HEAD/);
  assert.match(out, /\[0\.5\.0\]: https:\/\/github\.com\/o\/r\/compare\/v0\.4\.0\.\.\.v0\.5\.0/);
  assert.match(out, /\[0\.4\.0\]: https:\/\/github\.com\/o\/r\/compare\/v0\.3\.1\.\.\.v0\.4\.0/);
  // the old section is untouched
  assert.match(out, /## \[0\.4\.0\] - 2026-07-06/);
});

test("rotateChangelog refuses an already-released version and a missing [Unreleased]", () => {
  assert.throws(() => rotateChangelog(CHANGELOG, "0.4.0", "0.3.1", "2026-07-07"), /already has/);
  assert.throws(
    () => rotateChangelog("# empty\n", "0.5.0", "0.4.0", "2026-07-07"),
    /no ## \[Unreleased\]/,
  );
});

// ---------------------------------------------------------------------------
// JSON text surgery
// ---------------------------------------------------------------------------

test("setJsonVersionText replaces only the first version field and keeps formatting", () => {
  const text =
    '{\n  "name": "x \\u2014 y",\n  "version": "0.4.0",\n  "dep": { "version": "0.4.0" }\n}\n';
  const out = setJsonVersionText(text, "0.4.0", "0.5.0");
  assert.match(out, /"version": "0\.5\.0"/);
  assert.match(out, /"dep": \{ "version": "0\.4\.0" \}/); // second occurrence untouched
  assert.match(out, /\\u2014/); // unicode escape preserved (no JSON round-trip)
  assert.throws(() => setJsonVersionText(text, "9.9.9", "1.0.0"), /no "version"/);
});

// ---------------------------------------------------------------------------
// file mutation against a tmp fixture
// ---------------------------------------------------------------------------

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-fixture-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w("package.json", '{\n  "name": "fixture",\n  "version": "0.4.0"\n}\n');
  const lock = {
    name: "fixture",
    version: "0.4.0",
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "0.4.0", engines: { node: ">=20" } } },
  };
  w("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  w(".claude-plugin/plugin.json", '{\n  "name": "fixture",\n  "version": "0.4.0"\n}\n');
  w(".codex-plugin/plugin.json", '{\n  "name": "fixture",\n  "version": "0.4.0"\n}\n');
  w("CITATION.cff", 'cff-version: 1.2.0\nversion: 0.4.0\ndate-released: "2026-07-06"\n');
  w("landing/index.html", '<div class="mono">forgekit v0.4.0 · MIT</div>\n');
  w("CHANGELOG.md", CHANGELOG);
  return dir;
}

test("applyBump updates every version field in a fixture tree", () => {
  const dir = makeFixture();
  try {
    const changed = applyBump(dir, "0.4.0", "0.5.0", "2026-07-07");
    assert.deepEqual(
      changed.sort(),
      [
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        "CHANGELOG.md",
        "CITATION.cff",
        "landing/index.html",
        "package-lock.json",
        "package.json",
      ].sort(),
    );
    const read = (rel) => fs.readFileSync(path.join(dir, rel), "utf8");
    assert.equal(JSON.parse(read("package.json")).version, "0.5.0");
    const lock = JSON.parse(read("package-lock.json"));
    assert.equal(lock.version, "0.5.0");
    assert.equal(lock.packages[""].version, "0.5.0");
    assert.equal(lock.packages[""].engines.node, ">=20"); // untouched fields survive
    assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).version, "0.5.0");
    assert.equal(JSON.parse(read(".codex-plugin/plugin.json")).version, "0.5.0");
    assert.match(read("CITATION.cff"), /^version: 0\.5\.0$/m);
    assert.match(read("CITATION.cff"), /^date-released: "2026-07-07"$/m);
    assert.match(read("landing/index.html"), /forgekit v0\.5\.0/);
    assert.match(read("CHANGELOG.md"), /## \[0\.5\.0\] - 2026-07-07/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyBump skips files a fixture does not have", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-partial-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), '{\n  "version": "1.0.0"\n}\n');
    const changed = applyBump(dir, "1.0.0", "1.0.1", "2026-07-07");
    assert.deepEqual(changed, ["package.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectVersions reports every field and exposes drift", () => {
  const dir = makeFixture();
  try {
    let found = collectVersions(dir);
    assert.equal(new Set(Object.values(found)).size, 1);
    // introduce drift
    fs.writeFileSync(
      path.join(dir, ".claude-plugin/plugin.json"),
      '{\n  "name": "fixture",\n  "version": "0.4.1"\n}\n',
    );
    found = collectVersions(dir);
    assert.equal(new Set(Object.values(found)).size, 2);
    assert.equal(found[".claude-plugin/plugin.json"], "0.4.1");
    assert.equal(found['package-lock.json (packages."")'], "0.4.0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateChangelog refuses an empty [Unreleased] — a release must describe itself", () => {
  const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-01-01\n\n- old\n";
  assert.throws(
    () => rotateChangelog(empty, "0.5.0", "0.4.0", "2026-07-07"),
    /\[Unreleased\] is empty/,
  );
});
