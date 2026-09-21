import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  components,
  decompose,
  directedImportGraph,
  importGraph,
  jsImports,
  maskCode,
  pyImports,
  resolveSpec,
} from "../src/scope.js";
import { pyRelFiles, ts1Files, writeRepo } from "./fixtures/impact_repos.mjs";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "forge-scope-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // src/a.js imports src/b.js  (coupled);  src/c.js is standalone (independent)
  writeFileSync(
    join(root, "src/a.js"),
    'import { b } from "./b.js";\nexport const a = () => b();\n',
  );
  writeFileSync(join(root, "src/b.js"), "export const b = () => 1;\n");
  writeFileSync(join(root, "src/c.js"), "export const c = () => 2;\n");
  return root;
}

test("importGraph links a file to what it imports; components separate the islands", () => {
  const g = importGraph(repo());
  assert.ok(g.edges.get("src/a.js").has("src/b.js"), "a→b edge");
  assert.ok(g.edges.get("src/b.js").has("src/a.js"), "undirected");
  const comps = components(g);
  const sizes = comps.map((c) => c.length).sort();
  assert.deepEqual(sizes, [1, 2], "{a,b} coupled + {c} alone");
});

test("decompose: two unrelated files → two clusters (run as separate sessions)", () => {
  const root = repo();
  const d = decompose(root, ["src/a.js", "src/c.js"]);
  assert.equal(d.independentGroups, 2, "a and c are independent");
});

test("decompose: editing a.js surfaces the coupled file you didn't mention (b.js)", () => {
  const root = repo();
  const d = decompose(root, ["src/a.js"]);
  assert.equal(d.clusters.length, 1);
  assert.deepEqual(d.clusters[0].coupled, ["src/b.js"], "the forgot-related-module guard");
});

test("decompose normalizes ./ and absolute paths so coupling still resolves", () => {
  const root = repo();
  // shell-style ./ prefix and an absolute path — both must map to the repo-relative graph key
  assert.deepEqual(decompose(root, ["./src/a.js"]).clusters[0].coupled, ["src/b.js"]);
  const d = decompose(root, [join(root, "src/a.js"), "./src/b.js"]);
  assert.equal(d.independentGroups, 1, "two coupled files are NOT reported as independent");
});

// --- the shared import machinery (also what atlas.js resolves with) -------------------

test("maskCode blanks comments and string/regex contents but keeps offsets and delimiters", () => {
  const src = [
    '// import fake from "./nope.js"',
    "const s = \"import also from './nope.js'\";",
    "const re = /[\"']/g;",
    'import { real } from "./real.js";',
  ].join("\n");
  const code = maskCode(src, ".js");
  assert.equal(code.length, src.length, "offsets are preserved");
  assert.equal(code.split("\n").length, src.split("\n").length, "lines are preserved");
  assert.deepEqual(
    jsImports(code, src).map((i) => i.spec),
    ["./real.js"],
    "a comment and a string are not imports",
  );
  const py = maskCode('# from a import b\nX = "from c import d"\nfrom real import thing\n', ".py");
  assert.deepEqual(
    pyImports(py).map((i) => `${i.module}:${i.names.map((n) => n.imported)}`),
    ["real:thing"],
  );
});

test("jsImports reads every form; pyImports keeps statements apart", () => {
  const src = [
    'import a, { b as c } from "./m.js";',
    'export * from "./star.js";',
    'export { d as e } from "./re.js";',
    'const f = await import("./dyn.js");',
    'const g = require("./req.cjs");',
    'import "./side.js";',
  ].join("\n");
  const found = jsImports(maskCode(src, ".js"), src);
  assert.deepEqual(
    found.map((i) => i.spec),
    ["./m.js", "./star.js", "./re.js", "./dyn.js", "./req.cjs", "./side.js"],
  );
  assert.deepEqual(found[0].names, [
    { imported: "b", local: "c" },
    { imported: "default", local: "a" },
  ]);
  const py = pyImports(
    maskCode("import os\nimport sys\nfrom pkg.core import start\nimport pkg.core as c\n", ".py"),
  );
  assert.deepEqual(
    py.map((i) => i.module),
    ["os", "sys", "pkg.core", "pkg.core"],
    "`\s` in the old regex fused three statements into one module name",
  );
});

test("resolveSpec handles NodeNext .js→.ts, extensionless and index directories", () => {
  const files = new Set(["src/a.ts", "src/b.js", "src/dir/index.js", "src/c.py"]);
  assert.equal(resolveSpec("src/x.ts", "./a.js", files), "src/a.ts");
  assert.equal(resolveSpec("src/x.js", "./b", files), "src/b.js");
  assert.equal(resolveSpec("src/x.js", "./dir", files), "src/dir/index.js");
  assert.equal(resolveSpec("src/x.js", "lodash", files), null, "packages are not local edges");
  assert.equal(resolveSpec("src/x.js", "../../outside.js", files), null);
});

test("the file graph covers Python imports and TypeScript NodeNext specifiers", () => {
  const py = directedImportGraph(writeRepo(pyRelFiles));
  assert.ok(py.edges.get("pkg/a.py").has("pkg/core.py"), "relative from-import");
  assert.ok(py.edges.get("pkg/sub/e.py").has("pkg/core.py"), "two-level relative import");
  assert.ok(py.edges.get("pkg/d.py").has("pkg/core.py"), "aliased dotted import");
  assert.equal(py.edges.get("pkg/noise.py").size, 0, "a commented import is not an edge");
  const ts = directedImportGraph(writeRepo(ts1Files));
  assert.ok(ts.edges.get("src/y.ts").has("src/x.ts"), "./x.js resolves to x.ts");
  assert.ok(ts.edges.get("src/z.ts").has("src/x.ts"), "export * from './x.js'");
});
