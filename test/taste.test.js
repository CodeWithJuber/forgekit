import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, list } from "../src/taste.js";

const dir = () => mkdtempSync(join(tmpdir(), "forge-taste-"));

test("list returns the full style menu", () => {
  const styles = list();
  for (const s of ["minimalist", "brutalist", "editorial", "playful", "corporate"]) {
    assert.ok(styles.includes(s), `menu has ${s}`);
  }
});

test("apply writes a managed DESIGN.md for the chosen style", () => {
  const root = dir();
  const res = apply("brutalist", root);
  assert.equal(res.ok, true);
  const md = readFileSync(join(root, "DESIGN.md"), "utf8");
  assert.match(md, /Forge taste: brutalist/);
  assert.match(md, /Brutalist/);
});

test("apply is idempotent, then refuses to clobber an unmanaged DESIGN.md", () => {
  const root = dir();
  apply("minimalist", root);
  assert.equal(apply("minimalist", root).action, "unchanged");
  writeFileSync(join(root, "DESIGN.md"), "# my own design\n");
  assert.equal(apply("minimalist", root).ok, false);
});

test("apply rejects an unknown style", () => {
  assert.equal(apply("nope", dir()).ok, false);
});
