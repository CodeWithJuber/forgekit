import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

test("lean skill has valid frontmatter and the Lean Path", () => {
  const md = read("global/tools/lean/SKILL.md");
  assert.equal(frontmatter(md)?.name, "lean");
  assert.match(md, /Lean Path/);
});

test("recall skill has valid frontmatter", () => {
  assert.equal(frontmatter(read("global/tools/recall/SKILL.md"))?.name, "recall");
});

test("every crew agent declares name + description", () => {
  for (const agent of ["scout.md", "verifier.md", "frontend-verifier.md"]) {
    const fm = frontmatter(read(`global/crew/${agent}`));
    assert.ok(fm?.name, `${agent} has name`);
    assert.ok(fm?.description, `${agent} has description`);
  }
});

test("verifier crew is diff/review scoped", () => {
  assert.match(read("global/crew/verifier.md").toLowerCase(), /diff|review/);
});
