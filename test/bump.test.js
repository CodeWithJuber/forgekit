import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyBump,
  bumpRoadmapNow,
  changelogBody,
  collectVersions,
  computeNext,
  extractUnreleased,
  inferKindFromChangelog,
  inferKindFromCommits,
  isReleasableCommit,
  parseVersion,
  releasableCommits,
  rotateChangelog,
  setJsonVersionText,
  setUnreleasedBody,
  synthesizeChangelog,
} from "../scripts/bump.mjs";

// ---------------------------------------------------------------------------
// version math
// ---------------------------------------------------------------------------

test("parseVersion parses X.Y.Z and rejects garbage", () => {
  assert.deepEqual(parseVersion("0.4.0"), { major: 0, minor: 4, patch: 0 });
  assert.deepEqual(parseVersion("12.34.56"), {
    major: 12,
    minor: 34,
    patch: 56,
  });
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
// unattended auto-release: worthiness + synthesized notes
// ---------------------------------------------------------------------------

test("releasableCommits drops merge and release-bookkeeping commits", () => {
  const commits = [
    { subject: "feat: real" },
    { subject: "Merge pull request #9 from x" },
    { subject: "chore(release): v1.2.3" },
    { subject: "fix: another" },
  ];
  assert.deepEqual(
    releasableCommits(commits).map((c) => c.subject),
    ["feat: real", "fix: another"],
  );
  assert.deepEqual(releasableCommits(null), []);
});

test("isReleasableCommit: feat/fix/perf/breaking yes; docs/chore/test/refactor no", () => {
  for (const s of ["feat: x", "fix(scope): y", "perf: z", "feat!: drop", "refactor(core)!: rename"])
    assert.equal(isReleasableCommit({ subject: s }), true, s);
  for (const s of ["docs: x", "chore(deps): y", "test: z", "refactor: r", "style: s", "ci: c"])
    assert.equal(isReleasableCommit({ subject: s }), false, s);
  assert.equal(
    isReleasableCommit({
      subject: "chore: migrate",
      body: "BREAKING CHANGE: config moved",
    }),
    true,
    "body BREAKING CHANGE counts",
  );
});

test("synthesizeChangelog groups user-facing commits into Keep-a-Changelog sections", () => {
  const body = synthesizeChangelog([
    { subject: "feat: add stack detection" },
    { subject: "fix(cli): quiet crash" },
    { subject: "perf: faster impact" },
    { subject: "docs: tidy readme" }, // excluded — not user-facing
    { subject: "chore(release): v0.1.0" }, // excluded — noise
    { subject: "not a conventional subject" }, // excluded — non-conventional
  ]);
  assert.match(body, /### Added\n\n- add stack detection/);
  assert.match(body, /### Fixed\n\n- quiet crash/);
  assert.match(body, /### Changed\n\n- faster impact/);
  assert.doesNotMatch(body, /tidy readme/);
  assert.doesNotMatch(body, /conventional subject/);
  // deterministic section order: Added before Changed before Fixed
  assert.ok(body.indexOf("### Added") < body.indexOf("### Changed"));
  assert.ok(body.indexOf("### Changed") < body.indexOf("### Fixed"));
});

test("synthesizeChangelog flags breaking changes and dedupes", () => {
  const body = synthesizeChangelog([
    { subject: "feat!: drop node 18" },
    { subject: "feat: same thing" },
    { subject: "feat: same thing" }, // dup
  ]);
  assert.match(body, /- \*\*BREAKING\*\* drop node 18/);
  assert.equal(body.match(/- same thing/g).length, 1, "duplicate collapsed");
});

test("synthesizeChangelog is empty when nothing is user-facing", () => {
  assert.equal(synthesizeChangelog([{ subject: "docs: x" }, { subject: "chore: y" }]), "");
  assert.equal(synthesizeChangelog([]), "");
});

test("changelogBody never returns empty for a worthy release (breaking change in a non-conventional subject)", () => {
  // A squash-merge title GitHub capitalizes, with BREAKING CHANGE in the body: worthy, but
  // synthesizeChangelog can't parse the subject. changelogBody must still yield a real body,
  // or the auto-release would crash rotateChangelog and fail CI on a legit breaking change.
  const commits = [
    {
      subject: "Fix login redirect (#42)",
      body: "BREAKING CHANGE: renamed cookie",
    },
  ];
  assert.equal(synthesizeChangelog(commits), "", "synthesize alone can't handle it");
  assert.ok(isReleasableCommit(commits[0]), "but it IS release-worthy (breaking body)");
  const body = changelogBody(commits);
  assert.ok(body.trim().length > 0, "changelogBody is never empty for a worthy release");
  assert.match(body, /### Changed\n\n- Fix login redirect \(#42\)/);
  // and it rotates cleanly instead of throwing the empty-[Unreleased] error
  const cl = `# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-01-01\n\n- old\n`;
  assert.doesNotThrow(() =>
    rotateChangelog(setUnreleasedBody(cl, body), "0.5.0", "0.4.0", "2026-07-11"),
  );
});

test("changelogBody prefers the synthesized conventional sections when available", () => {
  const body = changelogBody([{ subject: "feat: add x" }, { subject: "fix: y" }]);
  assert.match(body, /### Added\n\n- add x/);
  assert.match(body, /### Fixed\n\n- y/);
});

test("setUnreleasedBody fills an empty [Unreleased] and rotateChangelog then accepts it", () => {
  const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-01-01\n\n- old\n";
  const filled = setUnreleasedBody(empty, "### Added\n\n- a new thing");
  assert.match(filled, /## \[Unreleased\]\n\n### Added\n\n- a new thing/);
  assert.match(filled, /## \[0\.4\.0\] - 2026-01-01/);
  // the previously-empty body now rotates without the "empty" guard firing
  const rotated = rotateChangelog(filled, "0.5.0", "0.4.0", "2026-07-11");
  assert.match(rotated, /## \[0\.5\.0\] - 2026-07-11\n\n### Added\n\n- a new thing/);
});

// ---------------------------------------------------------------------------
// ROADMAP "Now" marker
// ---------------------------------------------------------------------------

test("bumpRoadmapNow updates only the Now marker's version", () => {
  const roadmap =
    "# Roadmap\n\n## Now (`master`, v0.12.0)\n\nSome text.\n\n" +
    "## Shipped — Substrate v2 (v0.5.0)\n\nOlder text mentioning v0.5.0 again.\n";
  const out = bumpRoadmapNow(roadmap, "0.12.1");
  assert.match(out, /## Now \(`master`, v0\.12\.1\)/);
  // untouched: version mentions outside the "## Now" line survive verbatim
  assert.match(out, /## Shipped — Substrate v2 \(v0\.5\.0\)/);
  assert.match(out, /Older text mentioning v0\.5\.0 again\./);
});

test("bumpRoadmapNow is a no-op when there's no Now heading", () => {
  const roadmap = "# Roadmap\n\nNo heading here.\n";
  assert.equal(bumpRoadmapNow(roadmap, "1.0.0"), roadmap);
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
    packages: {
      "": { name: "fixture", version: "0.4.0", engines: { node: ">=20" } },
    },
  };
  w("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  w(".claude-plugin/plugin.json", '{\n  "name": "fixture",\n  "version": "0.4.0"\n}\n');
  w(".codex-plugin/plugin.json", '{\n  "name": "fixture",\n  "version": "0.4.0"\n}\n');
  w("CITATION.cff", 'cff-version: 1.2.0\nversion: 0.4.0\ndate-released: "2026-07-06"\n');
  w("landing/index.html", '<div class="mono">forgekit v0.4.0 · MIT</div>\n');
  w("ROADMAP.md", "# Roadmap\n\n## Now (`master`, v0.4.0)\n\nSome text.\n");
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
        "ROADMAP.md",
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
    assert.match(read("ROADMAP.md"), /## Now \(`master`, v0\.5\.0\)/);
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
