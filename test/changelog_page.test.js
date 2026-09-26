// The docs site's changelog page is generated from CHANGELOG.md (src/changelog_page.js):
// parsing, headlines, MDX safety, and the repository's own page staying current.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import {
  CHANGELOG_PAGE,
  githubSlug,
  headline,
  longDate,
  mdxInline,
  parseChangelog,
  renderChangelogPage,
  renderChangelogUpdates,
} from "../src/changelog_page.js";

const REPO = "https://github.com/owner/name";

const SAMPLE = `# Changelog

## [Unreleased]

## [2.1.0] - 2026-09-30

### Added

- **A new \`thing <x>\` command.** It does {a} and <b>, for example
  across two lines.

  A second paragraph that is not the headline.
- A plain bullet without a bold lead. It has a second sentence.
  - a nested item that is not a headline

\`\`\`
- a fenced line that is not a bullet
\`\`\`

### Fixed (audit remediation)

- **Lead that introduces a list:**
  - item
- See [the guide](docs/GUIDE.md#section) and [the notes](#210---2026-09-30), or <https://example.com>.

### Added

- **A second Added heading merges into the first.**

## [2.0.0] - 2026-01-02

### Changed

- **Everything, e.g. the API, changed.** Details.

[Unreleased]: https://github.com/owner/name/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/owner/name/compare/v2.0.0...v2.1.0
- a link-reference trailer is not part of any release
`;

test("parseChangelog: releases, merged sections, first paragraphs only", () => {
  const r = parseChangelog(SAMPLE);
  assert.deepEqual(
    r.map((x) => [x.version, x.date]),
    [
      ["Unreleased", null],
      ["2.1.0", "2026-09-30"],
      ["2.0.0", "2026-01-02"],
    ],
  );
  assert.deepEqual(r[0].sections, [], "an empty [Unreleased] has no sections");
  const v210 = r[1];
  assert.deepEqual(
    v210.sections.map((s) => s.label),
    ["Added", "Fixed (audit remediation)"],
  );
  const added = v210.sections[0].bullets;
  assert.equal(added.length, 3, "two Added headings merge; nested and fenced lines are skipped");
  assert.equal(
    added[0],
    "**A new `thing <x>` command.** It does {a} and <b>, for example across two lines.",
  );
  assert.ok(!added.join(" ").includes("second paragraph"));
  assert.ok(!added.join(" ").includes("fenced line"));
  assert.ok(!r[2].sections[0].bullets.join(" ").includes("link-reference trailer"));
});

test("headline: bold lead, else first sentence — code spans and abbreviations respected", () => {
  assert.equal(headline("**Bold lead.** Rest of it."), "**Bold lead.**");
  assert.equal(headline("**Lead that introduces a list:**"), "**Lead that introduces a list**");
  assert.equal(headline("Plain first. Second."), "Plain first.");
  assert.equal(headline("Use `a. b` here. Then more."), "Use `a. b` here.");
  assert.equal(headline("It changed, e.g. the API. Then more."), "It changed, e.g. the API.");
  const long = `Word ${"`code span` ".repeat(60)}end`;
  const cut = headline(long, { max: 100 });
  assert.ok(cut.endsWith(" …") && cut.length <= 102, cut);
  assert.equal((cut.match(/`/g) ?? []).length % 2, 0, "never cuts inside a code span");
});

test("mdxInline: escapes JSX/expression characters outside code, rewrites repo links", () => {
  assert.equal(mdxInline("a <b> {c} `d <e> {f}`", REPO), "a &lt;b&gt; &#123;c&#125; `d <e> {f}`");
  assert.equal(
    mdxInline("[g](docs/GUIDE.md#x) [n](#210) [w](https://w.org) <https://e.com>", REPO),
    `[g](${REPO}/blob/HEAD/docs/GUIDE.md#x) [n](${REPO}/blob/HEAD/CHANGELOG.md#210) [w](https://w.org) [https://e.com](https://e.com)`,
  );
});

test("dates and anchors match what readers and GitHub see", () => {
  assert.equal(longDate("2026-09-24"), "September 24, 2026");
  assert.equal(longDate("not a date"), "not a date");
  assert.equal(githubSlug("[1.4.3] - 2026-09-24"), "143---2026-09-24");
  assert.equal(githubSlug("[Unreleased]"), "unreleased");
});

test("renderChangelogUpdates: one Update per non-empty release, tagged, linked to full notes", () => {
  const out = renderChangelogUpdates(SAMPLE, { repo: REPO });
  const updates = out.match(/^<Update [^\n]*>$/gm) ?? [];
  assert.equal(updates.length, 2, "the empty [Unreleased] is skipped");
  assert.equal(
    updates[0],
    '<Update label="v2.1.0" description="September 30, 2026" tags={["Added","Fixed"]}>',
  );
  assert.match(out, /^- \*\*A new `thing <x>` command\.\*\*$/m);
  assert.match(out, /^- A plain bullet without a bold lead\.$/m);
  assert.match(out, /^\*\*Fixed \(audit remediation\)\*\*$/m);
  assert.ok(out.includes(`(${REPO}/blob/HEAD/CHANGELOG.md#210---2026-09-30)`));
  assert.equal((out.match(/^<\/Update>$/gm) ?? []).length, 2);
});

test("the repository's changelog page is current and MDX-safe", () => {
  const page = readFileSync(join(BRAND.root, CHANGELOG_PAGE), "utf8");
  const begin = page.indexOf("{/* forge:render:changelog:begin");
  const end = page.indexOf("{/* forge:render:changelog:end */}");
  assert.ok(begin !== -1 && end > begin, "the page carries the MDX render markers");
  const block = page.slice(page.indexOf("\n", begin) + 1, end).trimEnd();
  assert.equal(block, renderChangelogPage(BRAND.root), "run `forge docs render`");
  const released = [
    ...readFileSync(join(BRAND.root, "CHANGELOG.md"), "utf8").matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm),
  ];
  const newest = released[0]?.[1];
  assert.ok(block.includes(`label="v${newest}"`), `the newest release (${newest}) is on the page`);
  // Outside code spans, the only JSX is the Update element and its tags expression.
  for (const line of block.split("\n")) {
    const prose = line.replace(/`[^`]*`/g, "");
    if (/^<Update |^<\/Update>$/.test(line)) continue;
    assert.doesNotMatch(prose, /[<{}]/, `unescaped MDX character in: ${line}`);
  }
});
