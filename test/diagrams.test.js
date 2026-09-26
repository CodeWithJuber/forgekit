// The Archify diagram pipeline (scripts/diagrams.mjs): the offline receipt check, source
// naming, the gallery page, and the docs-check rules for embeds and hand-written Mermaid.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  ARCHIFY,
  checkDiagrams,
  galleryHtml,
  MANIFEST_PATH,
  parseSourceName,
  syncDocsSiteCopies,
} from "../scripts/diagrams.mjs";
import { BRAND } from "../src/brand.js";
import { docsCheck } from "../src/docs_check.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-diagrams-"));
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const source = '{"meta":{"title":"A flow"}}\n';
  write("docs/diagrams/src/flow.workflow.json", source);
  write("docs/diagrams/flow.svg", "<svg/>");
  write("README.md", "![flow](docs/diagrams/flow.svg)\n");
  const manifest = {
    archify: { ...ARCHIFY, license: "MIT" },
    diagrams: [
      {
        id: "flow",
        type: "workflow",
        title: "A flow",
        usedIn: ["README.md"],
        receipt: { specSha256: sha(source), artifactSha256: "a".repeat(64) },
      },
    ],
  };
  write(MANIFEST_PATH, JSON.stringify(manifest));
  return { root, write, manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("parseSourceName accepts <id>.<type>.json for the five archify types only", () => {
  assert.deepEqual(parseSourceName("docs/diagrams/src/core-loop.workflow.json"), {
    id: "core-loop",
    type: "workflow",
  });
  assert.equal(parseSourceName("x.flowchart.json"), null);
  assert.equal(parseSourceName("Bad Name.workflow.json"), null);
  assert.equal(parseSourceName("notes.md"), null);
});

test("checkDiagrams: consistent fixture passes; edits, strays and broken embeds are named", () => {
  const f = fixture();
  try {
    assert.deepEqual(checkDiagrams(f.root), []);
    f.write("docs/diagrams/src/flow.workflow.json", '{"meta":{"title":"edited"}}\n');
    assert.ok(checkDiagrams(f.root).some((p) => /changed since its last verified render/.test(p)));
    f.write("docs/diagrams/src/stray.sequence.json", "{}");
    assert.ok(checkDiagrams(f.root).some((p) => /stray\.sequence\.json: not registered/.test(p)));
    f.write("README.md", "no diagram here\n");
    assert.ok(
      checkDiagrams(f.root).some((p) => /usedIn names README\.md, which does not embed/.test(p)),
    );
    rmSync(join(f.root, "docs/diagrams/flow.svg"));
    assert.ok(checkDiagrams(f.root).some((p) => /flow\.svg is missing/.test(p)));
  } finally {
    f.cleanup();
  }
});

test("checkDiagrams: receipts from another archify commit are stale", () => {
  const f = fixture();
  try {
    f.write(
      MANIFEST_PATH,
      JSON.stringify({ ...f.manifest, archify: { ...ARCHIFY, commit: "0".repeat(40) } }),
    );
    assert.ok(checkDiagrams(f.root).some((p) => /rendered with archify 0{40}/.test(p)));
  } finally {
    f.cleanup();
  }
});

test("checkDiagrams: the docs site's SVG copies must match, and sync repairs them", () => {
  const f = fixture();
  try {
    f.write("mintlify/page.mdx", '<img src="/images/diagrams/flow.svg" alt="" />\n');
    f.manifest.diagrams[0].usedIn.push("mintlify/page.mdx");
    f.write(MANIFEST_PATH, JSON.stringify(f.manifest));
    assert.ok(
      checkDiagrams(f.root).some((p) =>
        /images\/diagrams\/flow\.svg is not a byte-identical/.test(p),
      ),
    );
    f.write("mintlify/images/diagrams/flow.svg", "<svg>stale</svg>");
    f.write("mintlify/images/diagrams/old.svg", "<svg/>");
    const problems = checkDiagrams(f.root);
    assert.ok(problems.some((p) => /flow\.svg is not a byte-identical/.test(p)));
    assert.ok(problems.some((p) => /old\.svg: no docs-site page embeds it/.test(p)));
    syncDocsSiteCopies(f.root, f.manifest);
    assert.deepEqual(checkDiagrams(f.root), []);
    assert.equal(readFileSync(join(f.root, "mintlify/images/diagrams/flow.svg"), "utf8"), "<svg/>");
  } finally {
    f.cleanup();
  }
});

test("galleryHtml lists every diagram, escaped, with its SVG preview and interactive page", () => {
  const html = galleryHtml(
    { diagrams: [{ id: "flow", type: "workflow", title: "A <flow> & more" }] },
    { site: "https://example.test/site", repo: "https://example.test/owner/repo" },
  );
  assert.match(html, /<a href="flow\.html"><img src="flow\.svg"/);
  assert.ok(html.includes("A &lt;flow&gt; &amp; more"));
  assert.ok(html.includes('href="https://example.test/site/status/"'));
  assert.ok(html.includes('href="https://example.test/owner/repo/tree/HEAD/docs/diagrams"'));
});

test("docs check: with a manifest, embeds must be registered and hand-written Mermaid is refused", () => {
  const f = fixture();
  try {
    f.write(
      "docs/page.md",
      "![x](diagrams/unknown.svg)\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
    );
    const r = docsCheck({ root: f.root });
    const details = r.issues.filter((i) => i.check === "diagrams").map((i) => i.detail);
    assert.ok(
      details.some((d) => /embeds diagram "unknown"/.test(d)),
      details.join("\n"),
    );
    assert.ok(
      details.some((d) => /hand-written mermaid diagram/.test(d)),
      details.join("\n"),
    );
    // A machine-owned block (inside forge:render markers) is still allowed.
    f.write(
      "docs/page.md",
      "<!-- forge:render:repo-map:begin (generated) -->\n```mermaid\nflowchart LR\n  A --> B\n```\n<!-- forge:render:repo-map:end -->\n",
    );
    const again = docsCheck({ root: f.root }).issues.filter(
      (i) => i.check === "diagrams" && /hand-written/.test(i.detail),
    );
    assert.deepEqual(again, []);
  } finally {
    f.cleanup();
  }
});

test("the repository's diagrams match their receipts and are embedded where the manifest says", () => {
  assert.deepEqual(checkDiagrams(BRAND.root), []);
  const manifest = JSON.parse(readFileSync(join(BRAND.root, MANIFEST_PATH), "utf8"));
  assert.ok(manifest.diagrams.length >= 13);
  for (const d of manifest.diagrams)
    assert.ok(d.usedIn.length >= 1, `${d.id} is embedded somewhere`);
});
