import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ambiguityMarkers,
  clarifyBlock,
  informationGap,
  preflightRepo,
  referencedEntities,
} from "../src/preflight.js";

test("referencedEntities pulls backtick symbols, file paths, and bare camelCase", () => {
  const r = referencedEntities(
    "refactor `validateToken` and update `src/auth.ts`, call computeTax",
  );
  assert.ok(r.symbols.includes("validateToken"));
  assert.ok(r.symbols.includes("computeTax"));
  assert.ok(r.files.includes("src/auth.ts"));
});

test("referencedEntities ignores plain English (no false identifiers)", () => {
  const r = referencedEntities("add a dark mode toggle to the settings page");
  assert.deepEqual(r.symbols, []);
  assert.deepEqual(r.files, []);
});

test("ambiguityMarkers catches vague wording", () => {
  const m = ambiguityMarkers("handle errors somehow and add several validations, etc.");
  assert.ok(m.includes("somehow") || m.includes("handle errors"));
  assert.ok(m.includes("several"));
  assert.ok(m.includes("etc"));
});

test("informationGap: all references resolve → gap 0 (silent)", () => {
  const has = (n) => n === "computeTax";
  const r = informationGap("refactor `computeTax`", { hasSymbol: has });
  assert.equal(r.gap, 0);
  assert.equal(clarifyBlock(r), "", "no clarify block when everything is grounded");
});

test("informationGap: an unresolved symbol drives the gap up and always clarifies", () => {
  const r = informationGap("wire `DatabasePool` into the handler", {
    hasSymbol: () => false,
  });
  assert.ok(r.gap > 0.9);
  assert.deepEqual(r.unresolved.symbols, ["DatabasePool"]);
  const block = clarifyBlock(r);
  assert.match(block, /DatabasePool/);
  assert.match(block, /not found/);
});

test("clarifyBlock stays silent for a fully-grounded task even with mild wording", () => {
  // one resolved symbol, no ambiguity → gap 0
  const r = informationGap("update `computeTax` to round half-up", {
    hasSymbol: () => true,
  });
  assert.equal(clarifyBlock(r), "");
});

test("preflightRepo grounds against a real repo (missing file/symbol → clarify)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-preflight-"));
  writeFileSync(join(root, "tax.js"), "export function computeTax(x){ return x }\n");
  // computeTax exists; `ledgerSync` and src/missing.ts do not
  const r = preflightRepo(root, "call `computeTax` then `ledgerSync` in `src/missing.ts`");
  assert.ok(r.entities.symbols.includes("computeTax"));
  assert.ok(r.unresolved.symbols.includes("ledgerSync"));
  assert.ok(r.unresolved.files.includes("src/missing.ts"));
  assert.ok(!r.unresolved.symbols.includes("computeTax"), "resolved symbol is not flagged");
});
