import assert from "node:assert/strict";
import { test } from "node:test";
import {
  criticalFeatures,
  describeConflicts,
  sameSemantics,
  semanticConflicts,
  trimEdges,
} from "../src/semantic_guard.js";

// The review's four exact-key collisions (F04) and its opposite-rule pair (F16): similar text,
// different behaviour — every one must be a conflict.
const CONFLICTING = [
  ["accept ages >= 18", "accept ages <= 18", "operators"],
  ['return "ADMIN"', 'return "admin"', "literals"],
  ["set enabled = true", "set enabled != true", "operators"],
  ["call getURL", "call getUrl", "identifiers"],
  [
    "Enable authentication for every admin route before serving a page",
    "Disable authentication for every admin route before serving a page",
    "polarity",
  ],
  ["retry 3 times on timeout", "retry 5 times on timeout", "numbers"],
  ["read src/a.js first", "read src/b.js first", "paths"],
  ["always run the linter", "never run the linter", "polarity"],
  ["do cache the response", "don't cache the response", "polarity"],
];

test("semantic guard: behaviour-changing pairs conflict, and the conflict is named", () => {
  for (const [a, b, kind] of CONFLICTING) {
    const conflicts = semanticConflicts(a, b);
    assert.ok(
      conflicts.some((c) => c.kind === kind),
      `${a} / ${b}: ${JSON.stringify(conflicts)}`,
    );
    assert.equal(sameSemantics(a, b), false);
    assert.ok(describeConflicts(conflicts).includes(kind));
  }
});

test("semantic guard: rewording that keeps every critical token is the same instruction", () => {
  for (const [a, b] of [
    ["Use pnpm, not npm", "use pnpm not npm"],
    ["Always run the tests before committing.", "Always run the tests before committing"],
    ["Add pagination to listUsers", "add pagination to listUsers"],
    ["timeout after 30s", "timeout after 30 s"],
  ])
    assert.equal(
      sameSemantics(a, b),
      true,
      `${a} / ${b}: ${describeConflicts(semanticConflicts(a, b))}`,
    );
});

test("semantic guard: features are extracted per class; literals are not re-scanned", () => {
  const f = criticalFeatures('fix src/api/users.ts: listUsers >= 25 items, not "ADMIN >= 1"');
  assert.deepEqual(f.operators, [">="], "the >= inside the literal is not an operator");
  assert.deepEqual(f.literals, ['"ADMIN >= 1"']);
  assert.deepEqual(f.numbers, ["25"]);
  assert.deepEqual(f.identifiers, ["listUsers"]);
  assert.deepEqual(f.paths, ["src/api/users.ts"]);
  assert.deepEqual(f.polarity, ["not"]);
  assert.deepEqual(criticalFeatures(""), {
    operators: [],
    numbers: [],
    literals: [],
    identifiers: [],
    paths: [],
    polarity: [],
  });
});

test("trimEdges equals the edge-punctuation regex it replaced, in linear time", () => {
  const OLD = /^[^\p{L}\p{N}_$./\\]+|[^\p{L}\p{N}_$/\\]+$/gu; // quadratic on long runs
  const alphabet = [
    "a",
    "Z",
    "7",
    "_",
    "$",
    ".",
    "/",
    "\\",
    "!",
    "?",
    ",",
    "(",
    ")",
    "é",
    "ß",
    "😀",
    "-",
    '"',
  ];
  let seed = 20260926;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 2000; trial++) {
    const n = Math.floor(rand() * 9);
    let tok = "";
    for (let i = 0; i < n; i++) tok += alphabet[Math.floor(rand() * alphabet.length)];
    assert.equal(trimEdges(tok), tok.replace(OLD, ""), JSON.stringify(tok));
  }
  // A long punctuation run inside one token: the old regex took quadratic time here.
  const hostile = `a${"!".repeat(200000)}a`;
  const t0 = performance.now();
  assert.equal(trimEdges(hostile), hostile);
  assert.ok(performance.now() - t0 < 1000, "linear, not quadratic");
});
