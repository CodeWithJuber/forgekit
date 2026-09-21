// Regression tests for the impact-graph review findings A1, A3–A6 and ATLAS-Q
// (docs/…/forgekit-deep-review: "Research vs implementation: impact graph"). Every
// fixture and its ground truth lives in test/fixtures/impact_repos.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, impact, isStale, load, query } from "../src/atlas.js";
import {
  collFiles,
  JS1_IMPORTERS,
  js1Files,
  PY_REL_IMPORTERS,
  phantomFiles,
  pyFlatFiles,
  pyRelFiles,
  pySrcFiles,
  transFiles,
  ts1Files,
  writeRepo,
} from "./fixtures/impact_repos.mjs";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const others = (r, target) => r.impactedFiles.filter((f) => f !== target);

test("A1: every JS import form resolves — src/util.js finds all 10 importers, no false positives", () => {
  const atlas = build({ root: writeRepo(js1Files) });
  const r = impact(atlas, "src/util.js");
  for (const f of JS1_IMPORTERS) assert.ok(r.impactedFiles.includes(f), `missed ${f}`);
  // page.js imports the widgets/ directory (index.js) → a real transitive dependent.
  assert.ok(r.impactedFiles.includes("src/page.js"), "index.js directory import");
  for (const trap of ["src/noise.js", "src/other/consumer.js", "src/other/util.js"])
    assert.ok(!r.impactedFiles.includes(trap), `false positive ${trap}`);
  assert.deepEqual(others(r, "src/util.js").sort(), [...JS1_IMPORTERS, "src/page.js"].sort());
});

test("A1: a directory import resolves to <dir>/index.js", () => {
  const atlas = build({ root: writeRepo(js1Files) });
  const r = impact(atlas, "src/widgets/index.js", { relations: ["reverse"] });
  assert.deepEqual(others(r, "src/widgets/index.js"), ["src/page.js"]);
  const edge = atlas.edges.find((e) => e.kind === "imports" && e.source === "module:src.page");
  assert.ok(edge && !edge.unresolved, "`./widgets` resolved to widgets/index.js");
});

test("A1: TypeScript NodeNext — `./x.js` in source resolves to x.ts on disk", () => {
  const atlas = build({ root: writeRepo(ts1Files) });
  assert.deepEqual(others(impact(atlas, "src/x.ts"), "src/x.ts"), ["src/y.ts", "src/z.ts"]);
});

test("A1: an import never resolves by its last path segment (no spurious `mjs`-style edges)", () => {
  const root = writeRepo({
    "src/doctor.js": "export function check() {\n  const mjs = 1;\n  return mjs;\n}\n",
    "src/pages.js":
      'import { render } from "../scripts/build-pages.mjs";\nexport const p = () => render();\n',
  });
  const atlas = build({ root });
  assert.deepEqual(others(impact(atlas, "src/doctor.js"), "src/doctor.js"), []);
  const edge = atlas.edges.find((e) => e.kind === "imports" && e.source === "module:src.pages");
  assert.ok(edge?.unresolved, "a missing local file stays unresolved");
});

test("A3: the same package gives the same answer in a flat and a src layout", () => {
  const flat = impact(build({ root: writeRepo(pyFlatFiles) }), "mypkg/core.py");
  const src = impact(build({ root: writeRepo(pySrcFiles) }), "src/mypkg/core.py");
  assert.deepEqual(others(flat, "mypkg/core.py"), ["mypkg/cli.py"]);
  assert.deepEqual(others(src, "src/mypkg/core.py"), ["src/mypkg/cli.py"]);
});

test("A4: Python relative, parenthesised, aliased and stacked imports — 7 of 7 importers", () => {
  const atlas = build({ root: writeRepo(pyRelFiles) });
  const r = impact(atlas, "pkg/core.py");
  assert.deepEqual(others(r, "pkg/core.py").sort(), [...PY_REL_IMPORTERS].sort());
  assert.ok(!r.impactedFiles.includes("pkg/noise.py"), "commented/string imports are not imports");
  // `import os\nimport sys\nfrom pkg.core import start` must not fuse into one bogus module.
  assert.ok(
    !atlas.edges.some((e) => e.kind === "imports" && /\n/.test(String(e.target))),
    "no import target spans lines",
  );
});

test("A5: no bare-name fallback for imports and no cross-language links", () => {
  const root = writeRepo({
    "src/eval.js": "export const oracle = { run() {} };\nexport function helper() {}\n",
    "research/proto/cli.py":
      "from impact_oracle.oracle import ImpactOracle\n\n\ndef main():\n    return helper()\n",
  });
  const atlas = build({ root });
  const byId = new Map(atlas.nodes.map((n) => [n.id, n]));
  for (const e of atlas.edges) {
    if (e.unresolved || e.kind === "contains" || e.kind === "references") continue;
    const a = byId.get(e.source)?.file ?? "";
    const b = byId.get(e.target)?.file ?? "";
    assert.equal(a.endsWith(".py"), b.endsWith(".py"), `cross-language edge ${a} → ${b}`);
  }
  assert.deepEqual(others(impact(atlas, "src/eval.js"), "src/eval.js"), []);
});

test("A6: a comment or string naming a class defines nothing and cannot erase a real edge", () => {
  const atlas = build({ root: writeRepo(phantomFiles) });
  assert.ok(
    !atlas.symbols.some((s) => s.file === "src/notes.js" && s.name === "Parser"),
    "no phantom Parser symbol from a comment/string",
  );
  assert.ok(impact(atlas, "src/parser.js").impactedFiles.includes("src/main.js"));
  assert.ok(impact(atlas, "makeParser").impactedFiles.includes("src/main.js"));
});

test("A6: a call belongs to its enclosing function, not the nearest local const (transitivity)", () => {
  const atlas = build({ root: writeRepo(transFiles) });
  const r = impact(atlas, "leaf");
  assert.ok(r.impactedFiles.includes("src/mid.js"));
  assert.ok(r.impactedFiles.includes("src/top.js"), JSON.stringify(r.impactedFiles));
  const call = atlas.edges.find((e) => e.kind === "calls" && e.line === 3);
  assert.match(String(call?.source), /:mid:/, "leaf() at line 3 is owned by mid()");
});

test("A6: two definitions of one name — importers resolve to their own file; ambiguity is counted", () => {
  const root = writeRepo({
    ...collFiles,
    // calls render() without importing it: genuinely ambiguous → counted, not silently lost
    "src/loose.js": "export function loose(x) {\n  return render(x);\n}\n",
  });
  const atlas = build({ root });
  const r = impact(atlas, "src/ui/render.js");
  assert.deepEqual(others(r, "src/ui/render.js"), ["src/ui/view.js"]);
  assert.ok(r.ambiguousRefs >= 1, `ambiguous references reported (${r.ambiguousRefs})`);
  assert.ok(atlas.stats.names.ambiguous >= 1);
});

test("A6: a method definition is not a call to a same-named function elsewhere", () => {
  const root = writeRepo({
    "src/hook.js": 'export function emit(event, text) {\n  return event + ":" + text;\n}\n',
    "src/emit/claude.js":
      'export const claude = {\n  name: "claude",\n  emit(ctx) {\n    return ctx;\n  },\n};\n',
    "src/caller.js": 'import { emit } from "./hook.js";\nexport const go = () => emit("a", "b");\n',
  });
  const atlas = build({ root });
  const r = impact(atlas, "emit");
  assert.ok(r.impactedFiles.includes("src/caller.js"), "the real caller is found");
  assert.ok(
    !r.impactedFiles.includes("src/emit/claude.js"),
    `an \`emit(ctx) {\` method is a definition, not a call: ${JSON.stringify(r.impactedFiles)}`,
  );
});

test("A6: the file cap counts only source files and a capped graph says so", () => {
  const files = { "a.js": "export const a = 1;\n", "b.js": "export const b = 2;\n" };
  for (let i = 0; i < 6; i++) files[`doc${i}.md`] = `# doc ${i}\n`;
  for (let i = 0; i < 6; i++) files[`c${i}.json`] = "{}\n";
  const root = writeRepo(files);
  const roomy = build({ root, cap: 2 });
  assert.equal(roomy.capped, false, "docs/configs do not count against the source cap");
  assert.equal(roomy.sourceFiles, 2);
  const tight = build({ root, cap: 1 });
  assert.equal(tight.capped, true);
  assert.ok(tight.skippedFiles >= 1);
  assert.equal(impact(tight, "a.js").capped, true, "impact() surfaces the cap");
});

test("A6: extraction is linear — a 16k-line JS file plus a 16k-line Python file build fast", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-big-"));
  let js = "";
  let py = "";
  for (let i = 0; i < 4000; i++) {
    js += `export function f${i}(x) {\n  const v = f${i ? i - 1 : 1}(x);\n  return v + 1;\n}\n`;
    py += `def g${i}(x):\n    v = g${i ? i - 1 : 1}(x)\n    return v\n\n`;
  }
  writeFileSync(join(root, "big.js"), js);
  writeFileSync(join(root, "big.py"), py);
  const t = Date.now();
  const atlas = build({ root });
  const ms = Date.now() - t;
  // The O(n²) extractor took ~5 s here (19.6 s for the review's 16k-line file).
  assert.ok(ms < 2500, `build took ${ms}ms`);
  assert.ok(
    atlas.edges.some((e) => e.kind === "calls" && e.resolved),
    "calls still resolve at scale",
  );
});

test("an atlas from an older extractor is stale (rebuilt, never trusted)", () => {
  const root = writeRepo(js1Files);
  const atlas = build({ root });
  assert.equal(isStale(root, atlas), false);
  const old = { ...load(root), version: 2 };
  writeFileSync(join(root, ".forge", "atlas.json"), JSON.stringify(old));
  assert.equal(isStale(root, load(root)), true);
});

test("ATLAS-Q: query ranks the exact definition above path-only matches", () => {
  const root = writeRepo({
    "scripts/build-pages.mjs":
      "export function renderPage() {}\nexport function writeIndex() {}\nexport function copyAssets() {}\n",
    "src/zz.js": "export function rebuildCache() {}\nexport function build() {}\n",
  });
  const hits = query(build({ root }), "build");
  assert.equal(hits[0].name, "build", JSON.stringify(hits.map((h) => h.name)));
  assert.equal(hits[0].file, "src/zz.js");
  const names = hits.map((h) => h.name);
  assert.ok(names.indexOf("rebuildCache") < names.indexOf("renderPage"), "name match before path");
  assert.ok(names.includes("copyAssets"), "path-only matches are still returned, last");
});

test("CLI: forge impact lists the real importers (no more 'found · impacted files: 0')", () => {
  const root = writeRepo(js1Files);
  const out = spawnSync(process.execPath, [CLI, "impact", "src/util.js", "--basic"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /✓ found/);
  assert.match(out.stdout, /impacted files: 11\b/);
  assert.match(out.stdout, /src\/d05_export_rename\.js/);
  const json = JSON.parse(
    spawnSync(process.execPath, [CLI, "impact", "src/util.js", "--basic", "--json"], {
      cwd: root,
      encoding: "utf8",
    }).stdout,
  );
  assert.equal(json.capped, false);
  assert.equal(typeof json.unresolvedImports, "number");
  assert.ok(readFileSync(join(root, ".forge", "atlas.json"), "utf8").length > 0);
});
