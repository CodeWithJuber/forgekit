import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMMANDS } from "../src/commands.js";
import {
  buildReferenceIndex,
  changedEntities,
  docSurfaces,
  docsImpact,
  EXTRACTORS,
  extractEntities,
} from "../src/docs_impact.js";
import { TOOLS } from "../src/mcp_tools.js";

// A real git repo — docs impact reads git diffs, so the pipeline can't be exercised
// against a bare directory. Writes `files`, commits them as the baseline, and returns
// helpers to mutate + inspect.
function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-impact-"));
  const g = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (rel, content) => {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  g("add", "-A");
  g("commit", "-qm", "baseline");
  return { root, g, write };
}

// A directory (no git) for pure reference-index unit tests where we pass surfaces explicitly.
function scratch(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-idx-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

// --- Stage 1: entity extraction ------------------------------------------------------

test("extractEntities: the registry yields the typed entity set from canonical sources", () => {
  const { root } = repo({
    "package.json": JSON.stringify({
      name: "widget",
      version: "3.1.0",
      keywords: ["forge-test"],
    }),
    "src/app.js": "const m = process.env.FORGE_TEST_KNOB;\nexport function runWidget() {}\n",
  });
  const ents = extractEntities(root);
  const by = (type) => ents.filter((e) => e.type === type).map((e) => e.name);

  // Root-parametrized types read the TARGET repo.
  assert.ok(by("env").includes("FORGE_TEST_KNOB"), "env var from process.env scan");
  assert.ok(by("symbol").includes("runWidget"), "exported symbol");
  assert.ok(by("version").includes("3.1.0"), "version from the repo's package.json");
  assert.ok(by("pkg-field").includes("widget"), "package name");

  // Registry-backed types come from forge's own COMMANDS / TOOLS (self-check semantics).
  assert.ok(by("command").includes(Object.keys(COMMANDS)[0]), "a command name");
  assert.ok(by("mcp-tool").includes(TOOLS[0].name), "an MCP tool name");
});

test("extractEntities: single-character names are dropped (no `process.env.X` prose noise)", () => {
  const root = scratch({ "src/a.js": "const x = process.env.X;\n" });
  const ents = extractEntities(root);
  assert.ok(!ents.some((e) => e.name.length < 2));
});

test("EXTRACTORS is data-driven — a new entity type is one record, no call-site edits", () => {
  // Every extractor exposes the same shape, so the pipeline never special-cases a type.
  for (const ex of EXTRACTORS) {
    assert.equal(typeof ex.type, "string");
    assert.equal(typeof ex.extract, "function");
    assert.equal(typeof ex.ref, "function");
    assert.equal(typeof ex.isSource, "function");
  }
});

// --- Stage 2: reference index (word boundaries + code fences) -------------------------

test("buildReferenceIndex: word-boundary aware — a longer token is not a match", () => {
  const root = scratch({
    "README.md": [
      "# t",
      "Run `forge docs` to check. But forge docsxyz is unrelated.",
      "Set FORGE_ABC now; FORGE_ABCDEF is a different var.",
    ].join("\n"),
  });
  const entities = [
    { type: "command", name: "docs", weight: 0.9 },
    { type: "env", name: "FORGE_ABC", weight: 0.9 },
  ];
  const { index } = buildReferenceIndex(root, entities, ["README.md"]);
  assert.equal(index.get("command docs")?.length, 1, "matches `forge docs`, not `forge docsxyz`");
  assert.equal(index.get("env FORGE_ABC")?.length, 1, "matches FORGE_ABC, not FORGE_ABCDEF");
});

test("buildReferenceIndex: code-fence aware — a word-shaped symbol only counts in code", () => {
  const root = scratch({
    "README.md": [
      "# t",
      "The word build appears in plain prose here.", // prose → must NOT count
      "Call `build` to compile.", // inline code → counts
      "```js",
      "build();", // fenced code → counts
      "```",
    ].join("\n"),
  });
  const entities = [{ type: "symbol", name: "build", weight: 0.6, codeOnly: true }];
  const { index } = buildReferenceIndex(root, entities, ["README.md"]);
  const hits = index.get("symbol build") ?? [];
  assert.equal(hits.length, 2, "only the inline-code and fenced occurrences");
  assert.ok(hits.every((h) => h.context !== "prose"));
});

test("buildReferenceIndex: records section, line, and a confidence bonus inside code", () => {
  const root = scratch({
    "README.md": ["## Setup", "Set FORGE_ABC in your shell.", "Or `FORGE_ABC` inline."].join("\n"),
  });
  const { index } = buildReferenceIndex(
    root,
    [{ type: "env", name: "FORGE_ABC", weight: 0.9 }],
    ["README.md"],
  );
  const hits = index.get("env FORGE_ABC");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].section, "Setup");
  assert.equal(hits[0].line, 2);
  const code = hits.find((h) => h.context === "code");
  const prose = hits.find((h) => h.context === "prose");
  assert.ok(code.confidence > prose.confidence, "inline-code hit is more confident");
});

// --- docSurfaces discovery -----------------------------------------------------------

test("docSurfaces: discovers markdown but exempts CHANGELOG (append-only history)", () => {
  const { root } = repo({
    "README.md": "# r\n",
    "docs/GUIDE.md": "# g\n",
    "CHANGELOG.md": "# c\n",
    "package.json": JSON.stringify({ name: "w", version: "1.0.0" }),
  });
  const surfaces = docSurfaces(root);
  assert.ok(surfaces.includes("README.md"));
  assert.ok(surfaces.includes("docs/GUIDE.md"));
  assert.ok(surfaces.includes("package.json"));
  assert.ok(!surfaces.includes("CHANGELOG.md"), "history is exempt");
});

// --- Stage 3: change detection + impact query ----------------------------------------

test("impact: a removed env var flags the README that documents it", () => {
  const { root, write } = repo({
    "package.json": JSON.stringify({ name: "w", version: "1.0.0" }),
    "src/app.js": "const m = process.env.FORGE_TEST_KNOB;\nexport function go() {}\n",
    "README.md": "# w\n\nSet `FORGE_TEST_KNOB` to configure the widget.\n",
  });
  write("src/app.js", "export function go() {}\n"); // remove the env read
  const changed = changedEntities(root, { base: "HEAD" });
  assert.ok(
    changed.some((c) => c.type === "env" && c.name === "FORGE_TEST_KNOB" && c.removed),
    "env var detected as removed",
  );
  const r = docsImpact(root, { base: "HEAD" });
  const env = r.impacted.find((e) => e.type === "env" && e.name === "FORGE_TEST_KNOB");
  assert.ok(env, "env var is in the impacted set");
  assert.ok(env.occurrences.some((o) => o.file === "README.md"));
});

test("impact: a version bump flags docs that hardcode the OLD version", () => {
  const { root, write } = repo({
    "package.json": JSON.stringify({ name: "w", version: "1.0.0" }, null, 2),
    "src/app.js": "export function go() {}\n",
    "README.md": "# w — v1.0.0\n\nUpgrade guide for v1.0.0.\n",
  });
  write("package.json", JSON.stringify({ name: "w", version: "2.0.0" }, null, 2));
  const r = docsImpact(root, { base: "HEAD" });
  const oldV = r.impacted.find((e) => e.type === "version" && e.name === "1.0.0");
  assert.ok(oldV, "the OLD version is a changed (removed) entity");
  assert.ok(
    oldV.occurrences.some((o) => o.file === "README.md"),
    "README's v1.0.0 flagged",
  );
  assert.ok(
    r.impacted.some((e) => e.type === "version" && e.name === "2.0.0"),
    "new version too",
  );
});

test("impact: a renamed command (commands.js diff) flags its old doc mentions", () => {
  // The command extractor discovers table keys in a changed src/commands.js. A key that
  // no longer exists in forge's COMMANDS registry is treated as removed/renamed.
  const { root, write } = repo({
    "package.json": JSON.stringify({ name: "w", version: "1.0.0" }),
    "src/commands.js": "export const COMMANDS = {\n  frobnicate: 'do a thing',\n};\n",
    "README.md": "# w\n\nRun `forge frobnicate` to do the thing.\n",
  });
  write("src/commands.js", "export const COMMANDS = {\n  frobulate: 'do a thing',\n};\n");
  const changed = changedEntities(root, { base: "HEAD" });
  assert.ok(
    changed.some((c) => c.type === "command" && c.name === "frobnicate" && c.removed),
    "the removed command key is detected",
  );
  const r = docsImpact(root, { base: "HEAD" });
  const cmd = r.impacted.find((e) => e.type === "command" && e.name === "frobnicate");
  assert.ok(cmd?.occurrences.some((o) => o.file === "README.md"));
});

test("impact: a diff that changes no documented entity yields nothing to review", () => {
  const { root, write } = repo({
    "package.json": JSON.stringify({ name: "w", version: "1.0.0" }),
    "src/app.js": "export function go() {}\n",
    "README.md": "# w\n\nHello.\n",
  });
  write("notes.txt", "just some scratch prose, no entities\n");
  const r = docsImpact(root, { base: "HEAD" });
  assert.equal(r.impacted.length, 0);
});

test("impact: a changed entity mentioned ONLY in CHANGELOG is not reported (history)", () => {
  const { root, write } = repo({
    "package.json": JSON.stringify({ name: "w", version: "1.0.0" }),
    "src/app.js": "const m = process.env.FORGE_TEST_KNOB;\nexport function go() {}\n",
    "CHANGELOG.md": "# Changelog\n\n## [1.0.0]\n\n- added FORGE_TEST_KNOB\n",
  });
  write("src/app.js", "export function go() {}\n");
  const r = docsImpact(root, { base: "HEAD" });
  assert.ok(
    !r.impacted.some((e) => e.occurrences.some((o) => o.file === "CHANGELOG.md")),
    "CHANGELOG mentions are exempt",
  );
});

test("docsImpact: --staged reads the index, and the report shape is stable", () => {
  const { root, g, write } = repo({
    "package.json": JSON.stringify({ name: "w", version: "1.0.0" }),
    "src/app.js": "const m = process.env.FORGE_TEST_KNOB;\nexport function go() {}\n",
    "README.md": "# w\n\nSet `FORGE_TEST_KNOB`.\n",
  });
  write("src/app.js", "export function go() {}\n");
  g("add", "src/app.js");
  const r = docsImpact(root, { staged: true });
  assert.equal(r.base, "--staged");
  assert.ok("summary" in r && "surfaces" in r && Array.isArray(r.changed));
  assert.ok(r.impacted.some((e) => e.type === "env" && e.name === "FORGE_TEST_KNOB"));
});
