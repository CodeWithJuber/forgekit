// forge spec-lock — cheap spec-as-contract drift detection. It does NOT rebuild a
// spec framework (OpenSpec / Spec Kit do that); it snapshots which code symbols each
// spec CLAIMS (via the atlas index) and later flags a spec that still claims a symbol
// the code no longer defines — i.e. the code moved on and the spec didn't.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build as buildAtlas, has } from "./atlas.js";
import { hashContent } from "./emit/_shared.js";

const SPEC_DIRS = ["specs", "openspec/changes", "openspec/specs", ".kiro/steering"];

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, files);
    else if (entry.name.endsWith(".md")) files.push(p);
  }
}

function specFiles(root) {
  const files = [];
  for (const d of SPEC_DIRS) {
    const dir = join(root, d);
    if (existsSync(dir)) walk(dir, files);
  }
  return files;
}

/** Pure: code-identifier tokens a spec references — `backtick` tokens, 3+ chars. */
export function referencedSymbols(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/`([A-Za-z_$][\w$]{2,})`/g)) out.add(m[1]);
  return [...out];
}

/** Record, per spec, the symbols it references that currently EXIST in the code. */
export function snapshot(root = process.cwd()) {
  const atlas = buildAtlas({ root });
  const specs = {};
  for (const f of specFiles(root)) {
    const text = readFileSync(f, "utf8");
    const claimed = referencedSymbols(text).filter((s) => has(atlas, s));
    specs[relative(root, f)] = { hash: hashContent(text), claimed };
  }
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "spec-lock.json"), JSON.stringify(specs, null, 2));
  return { specs, count: Object.keys(specs).length };
}

/** Flag specs that still claim a symbol the code no longer defines (drift). */
export function check(root = process.cwd()) {
  const lockPath = join(root, ".forge", "spec-lock.json");
  if (!existsSync(lockPath))
    return { ok: true, drift: [], note: "no lock — run `forge spec lock`" };
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const atlas = buildAtlas({ root });
  const drift = [];
  for (const [spec, entry] of Object.entries(lock)) {
    for (const sym of entry.claimed || []) {
      if (!has(atlas, sym)) drift.push({ spec, symbol: sym });
    }
  }
  return { ok: drift.length === 0, drift };
}
