import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, referencedSymbols, snapshot } from "../src/speclock.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-spec-"));

test("referencedSymbols pulls backtick code tokens", () => {
  const syms = referencedSymbols("The `computeTax` function and `Ledger` class.");
  assert.ok(syms.includes("computeTax"));
  assert.ok(syms.includes("Ledger"));
});

test("spec-lock: no drift right after snapshot, drift when a claimed symbol is deleted", () => {
  const root = fixture();
  writeFileSync(join(root, "a.js"), "export function computeTax(x){ return x }\n");
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs", "tax.md"), "# Tax\nThe `computeTax` function computes tax.\n");

  assert.equal(snapshot(root).count, 1);
  assert.equal(check(root).ok, true, "no drift immediately after snapshot");

  writeFileSync(join(root, "a.js"), "export function other(){ return 1 }\n"); // computeTax removed
  const res = check(root);
  assert.equal(res.ok, false);
  assert.ok(res.drift.some((d) => d.symbol === "computeTax"));
});

test("spec check with no lock passes with a note", () => {
  const r = check(fixture());
  assert.equal(r.ok, true);
  assert.match(r.note, /no lock/);
});
