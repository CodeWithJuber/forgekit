import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/atlas.js";
import { symbolCandidates } from "../src/reuse_symbols.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-symbols-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("ranks real cross-language declarations and returns reopenable locations", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "a.py"), "def parse_HTTP_headers():\n    pass\n");
  writeFileSync(join(root, "b.js"), "export function parseHTTPHeaders() {}\n");
  writeFileSync(join(root, "c.rs"), "fn billing_quota() {}\n");
  build({ root });
  const result = symbolCandidates(root, "Please implement parseHTTPHeaders");
  assert.deepEqual(result, [
    { file: "b.js", line: 1, name: "parseHTTPHeaders" },
    { file: "a.py", line: 1, name: "parse_HTTP_headers" },
  ]);
  assert.deepEqual(symbolCandidates(root, "please implement a new method"), []);
  assert.deepEqual(symbolCandidates(root, "memory compaction"), []);
});

test("changed, removed, escaped and symlinked files are skipped", (t) => {
  const root = fixture(t);
  const other = fixture(t);
  for (const file of ["changed.js", "removed.js", "link.js", "valid.js"]) {
    writeFileSync(join(root, file), "export function retryTransfer() {}\n");
  }
  build({ root });
  const indexPath = join(root, ".forge", "atlas.json");
  const graph = JSON.parse(readFileSync(indexPath, "utf8"));
  graph.symbols.unshift({ ...graph.symbols[0], file: "../escaped.js" });
  writeFileSync(indexPath, JSON.stringify(graph));
  writeFileSync(join(root, "changed.js"), "// moved\nexport function retryTransfer() {}\n");
  rmSync(join(root, "removed.js"));
  rmSync(join(root, "link.js"));
  writeFileSync(join(other, "external.js"), "export function retryTransfer() {}\n");
  symlinkSync(join(other, "external.js"), join(root, "link.js"));
  assert.deepEqual(symbolCandidates(root, "retry transfer"), [
    { file: "valid.js", line: 1, name: "retryTransfer" },
  ]);
});

test("hook does not rebuild missing, corrupt, oversized or symlinked caches", (t) => {
  const root = fixture(t);
  assert.deepEqual(symbolCandidates(root, "retry transfer"), []);
  assert.equal(existsSync(join(root, ".forge")), false);
  mkdirSync(join(root, ".forge"));
  const indexPath = join(root, ".forge", "atlas.json");
  writeFileSync(indexPath, "{");
  assert.deepEqual(symbolCandidates(root, "retry transfer"), []);
  truncateSync(indexPath, 16 * 1024 * 1024);
  assert.deepEqual(symbolCandidates(root, "retry transfer"), []);
  const other = fixture(t);
  writeFileSync(join(other, "a.js"), "function retryTransfer() {}\n");
  build({ root: other });
  rmSync(indexPath);
  symlinkSync(join(other, ".forge", "atlas.json"), indexPath);
  assert.deepEqual(symbolCandidates(root, "retry transfer"), []);
});

test("caps results and orders ties reproducibly", (t) => {
  const root = fixture(t);
  for (const file of ["d.js", "c.js", "b.js", "a.js"]) {
    writeFileSync(join(root, file), "export function transferRetry() {}\n");
  }
  build({ root });
  assert.deepEqual(
    symbolCandidates(root, "transfer retry").map((item) => item.file),
    ["a.js", "b.js", "c.js"],
  );
});
