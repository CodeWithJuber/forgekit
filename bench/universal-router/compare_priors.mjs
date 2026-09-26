#!/usr/bin/env node
// Compare two router prior files (the data/router_prior.json format) value by value.
//
//   node bench/universal-router/compare_priors.mjs <expected.json> <actual.json>
//        [--ignore <dotted.path>]... [--strict]
//
// The question it answers: does <actual> reproduce every value of <expected>? Each leaf of
// <expected> must exist in <actual> with an identical value: numbers with ===, which after JSON
// parsing is bit-for-bit equality of the doubles, and strings, booleans and nulls likewise.
// provenance.fittedAt is always skipped; each --ignore adds a dotted path (a prefix skips its
// whole subtree), and the report lists every path it skipped.
//
// Leaves that exist only in <actual> are reported as `added`, grouped by field. Newer code can
// write fields the expected file predates (build metadata in provenance.build, diagnostics in
// cost such as cost.alphaSE), and an addition does not change any expected value, so additions
// are not a mismatch unless --strict is given.
//
// Output: a JSON report on stdout (leaf counts; per field, meaning the path without array
// indices such as mirt.L, the number of differing values and the maximum absolute difference;
// examples; missing and added paths) and a one-line summary on stderr. Exit code 0 when every
// compared value is identical (and, with --strict, nothing was added), 1 otherwise, 2 on a
// usage error.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const files = [];
const ignore = ["provenance.fittedAt"];
let strict = false;
let badFlag = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ignore" && args[i + 1]) ignore.push(args[++i]);
  else if (args[i] === "--strict") strict = true;
  else if (args[i].startsWith("--")) badFlag = true;
  else files.push(args[i]);
}
if (badFlag || files.length !== 2) {
  console.error(
    "usage: compare_priors.mjs <expected.json> <actual.json> [--ignore <dotted.path>]... [--strict]",
  );
  process.exit(2);
}
// An unreadable file is a usage error (2), never a mismatch (1).
const load = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`compare_priors: cannot read ${f}: ${e.message}`);
    process.exit(2);
  }
};
const [expected, actual] = files.map(load);

/**
 * Leaves of a JSON value: key = JSON of the full path, with its display path and its field
 * (the path without array indices). An empty object or array is a leaf of its own.
 * @returns {Map<string, {path: string, field: string, value: unknown}>}
 */
function leaves(value, path = [], field = [], acc = new Map()) {
  if (value !== null && typeof value === "object") {
    const isArray = Array.isArray(value);
    const keys = isArray ? value.map((_, i) => i) : Object.keys(value);
    if (!keys.length)
      acc.set(JSON.stringify(path), { path: path.join("."), field: field.join("."), value });
    for (const k of keys) leaves(value[k], [...path, k], isArray ? field : [...field, k], acc);
  } else acc.set(JSON.stringify(path), { path: path.join("."), field: field.join("."), value });
  return acc;
}

const skipped = (p) => ignore.some((g) => p === g || p.startsWith(`${g}.`));
const same = (x, y) =>
  x === y ||
  (typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y));

const A = leaves(expected);
const B = leaves(actual);
const fields = new Map();
const missing = [];
const added = [];
const ignoredPaths = [];
let compared = 0;
let identical = 0;
for (const [key, a] of A) {
  if (skipped(a.path)) {
    ignoredPaths.push(a.path);
    continue;
  }
  const b = B.get(key);
  if (!b) {
    missing.push(a.path);
    continue;
  }
  compared++;
  if (!fields.has(a.field))
    fields.set(a.field, { values: 0, differing: 0, maxAbsDiff: 0, nonNumeric: 0, examples: [] });
  const f = fields.get(a.field);
  f.values++;
  if (same(a.value, b.value)) {
    identical++;
    continue;
  }
  f.differing++;
  if (typeof a.value === "number" && typeof b.value === "number")
    f.maxAbsDiff = Math.max(f.maxAbsDiff, Math.abs(a.value - b.value));
  else f.nonNumeric++;
  if (f.examples.length < 5) f.examples.push({ path: a.path, expected: a.value, actual: b.value });
}
const addedByField = new Map();
for (const [key, b] of B) {
  if (A.has(key)) continue;
  if (skipped(b.path)) ignoredPaths.push(b.path);
  else {
    added.push(b.path);
    addedByField.set(b.field, (addedByField.get(b.field) ?? 0) + 1);
  }
}

const differing = compared - identical;
const exactMatch = differing === 0 && !missing.length;
const pass = exactMatch && !(strict && added.length);
const report = {
  expected: files[0],
  actual: files[1],
  exactMatch,
  strict,
  pass,
  ignored: { patterns: ignore, paths: [...new Set(ignoredPaths)] },
  leaves: { compared, identical, differing, missing: missing.length, added: added.length },
  fields: Object.fromEntries(
    [...fields].map(([name, f]) => [
      name,
      {
        values: f.values,
        differing: f.differing,
        maxAbsDiff: f.differing > f.nonNumeric ? f.maxAbsDiff : f.differing ? null : 0,
        ...(f.nonNumeric ? { nonNumericDiffering: f.nonNumeric } : {}),
        ...(f.examples.length ? { examples: f.examples } : {}),
      },
    ]),
  ),
  missing,
  added: { byField: Object.fromEntries(addedByField), paths: added },
};
console.log(JSON.stringify(report, null, 2));

const parts = exactMatch
  ? [`exact match: ${identical}/${compared} values of ${files[0]} identical`]
  : [
      `MISMATCH: ${differing}/${compared} values differ`,
      ...(missing.length ? [`${missing.length} paths missing from ${files[1]}`] : []),
      ...[...fields]
        .filter(([, f]) => f.differing)
        .map(([name, f]) =>
          f.differing > f.nonNumeric
            ? `${name} ${f.differing}/${f.values}, max |diff| ${f.maxAbsDiff.toPrecision(3)}`
            : `${name} ${f.differing}/${f.values} (text)`,
        ),
    ];
if (added.length) {
  // Group additions by their first two path segments: "cost.alphaSE 11, provenance.build 10".
  const groups = new Map();
  for (const [field, count] of addedByField) {
    const g = field.split(".").slice(0, 2).join(".");
    groups.set(g, (groups.get(g) ?? 0) + count);
  }
  const list = [...groups].map(([g, c]) => `${g} ${c}`).join(", ");
  parts.push(`${added.length} values only in ${files[1]}${strict ? " (--strict)" : ""}: ${list}`);
}
console.error(`${parts.join("; ")} (skipped: ${ignore.join(", ")})`);
process.exit(pass ? 0 : 1);
