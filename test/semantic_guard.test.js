import assert from "node:assert/strict";
import { test } from "node:test";
import {
  criticalFeatures,
  describeConflicts,
  layoutFeatures,
  sameSemantics,
  semanticConflicts,
  statementKey,
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
  // symbols in document order, an operator with its operands; prose punctuation is not one
  assert.deepEqual(f.symbols, ["src / api", "api / users", ".", "listUsers >= 25"]);
  assert.deepEqual(criticalFeatures(""), {
    operators: [],
    numbers: [],
    literals: [],
    identifiers: [],
    paths: [],
    polarity: [],
    layout: [],
    symbols: [],
    format: [],
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

// Review 2026-09-27: the new layout and statement-key scans must stay linear on hostile text —
// a `[…]+$` regex over a long punctuation run took over a minute on 200k characters.
test("layoutFeatures and statementKey are linear on long punctuation runs", () => {
  const run = ".".repeat(200000);
  const t0 = performance.now();
  assert.ok(layoutFeatures(`x ${run}a  b`).length > 0);
  assert.equal(statementKey(`a${run}b${run}`), `a${run}b${run}`, "a run of dots is not a period");
  assert.ok(semanticConflicts(`x ${run}a  b`, `x ${run}a b`).length > 0);
  assert.ok(performance.now() - t0 < 2000, "linear, not quadratic");
});

test("the literal scanner, symbols and spelling are linear on hostile input", () => {
  const n = 100000;
  const t0 = performance.now();
  for (const hostile of [
    "“".repeat(n), // unmatched typographic openers
    "'a ".repeat(n), // ASCII openers with no closer on the line
    Array.from({ length: 400 }, (_, k) => "`".repeat(k + 1)).join(" x "), // unmatched runs
    "+".repeat(n), // one long symbol run
    `x${"\u200b".repeat(n)}y`, // format characters in one token
    "a".repeat(n), // one long word
  ])
    semanticConflicts(hostile, `${hostile} z`);
  assert.ok(performance.now() - t0 < 4000, "linear, not quadratic");
});

// Review N01 round 2: every pair the adversarial review served as "near" — each must conflict.
const ROUND2 = [
  ['return "a  b"', 'return "a b"', "literals"],
  ["Split the log fields on “ ”", "Split the log fields on “\t”", "literals"],
  ["Keep the header “Last Name  First Name”", "Keep the header “Last Name First Name”", "literals"],
  ["Keep «a  b» as is", "Keep «a b» as is", "literals"],
  [
    "Don't reformat the CSV header 'Last Name  First Name'",
    "Don't reformat the CSV header 'Last Name First Name'",
    "literals",
  ],
  ["wrap it in ``a  b``", "wrap it in ``a b``", "literals"],
  ["x + 1", "x - 1", "symbols"],
  ["i += 1", "i -= 1", "symbols"],
  ["a * b", "a / b", "symbols"],
  ["a & b", "a | b", "symbols"],
  ["i++", "i--", "symbols"],
  ["compute a - b now", "compute b - a now", "symbols"],
  ["cd ..", "cd .", "symbols"],
  ["go test ./...", "go test ./", "symbols"],
  ["in seed scripts call create!", "in seed scripts call create", "symbols"],
  ["retry 3 then 5 times", "retry 5 then 3 times", "numbers"],
  ["if x:\n    a()\n    b()", "if x:\n    a()\nb()", "layout"],
  ["Reset the cache:\nrm -rf .cache\nnpm ci", "Reset the cache: rm -rf .cache npm ci", "layout"],
  ["build: deps\n\tgo build ./cmd/server", "build: deps\n    go build ./cmd/server", "layout"],
  ["return\n{a: 1}", "return {a: 1}", "layout"],
  ["a\r\nb", "a\nb", "layout"],
  ["Name    Age", "Name Age", "layout"],
  ["line one  \nline two", "line one\nline two", "layout"],
  ["use the function named parse", "use the function named Parse", "spelling"],
  ["call the h\u0430ndler", "call the handler", "spelling"],
  ["call ｐａｒｓｅ now", "call parse now", "spelling"],
  ["call pa\u200brse now", "call parse now", "format"],
  ["call parse\u200d now", "call parse now", "format"],
];

test("N01 round 2: literals, symbols, order, layout and spelling all separate a near pair", () => {
  for (const [a, b, kind] of ROUND2) {
    const conflicts = semanticConflicts(a, b);
    assert.ok(
      conflicts.some((c) => c.kind === kind),
      `${JSON.stringify(a)} / ${JSON.stringify(b)}: ${describeConflicts(conflicts) || "no conflict"}`,
    );
    assert.deepEqual(semanticConflicts(a, a), [], "a text never conflicts with itself");
  }
});

test("N01 round 2: an order-only difference is named as one", () => {
  const [c] = semanticConflicts("move 1 then 2", "move 2 then 1");
  assert.equal(c.kind, "numbers");
  assert.equal(c.order, true);
  assert.match(describeConflicts([c]), /numbers \(order\): 1 2 ≠ 2 1/);
});

test("N02 round 2: the statement key folds only edge whitespace and one sentence period", () => {
  for (const [a, b] of [
    ["Run tests.", "Run tests"],
    ["  Pin node to 20.  ", "Pin node to 20"],
  ])
    assert.equal(statementKey(a), statementKey(b), `${a} / ${b}`);
  for (const [a, b] of [
    ["go test ./...", "go test ./"],
    ["call save!", "call save"],
    ["cd ..", "cd ."],
    ["git add .", "git add .."],
    ["start with ;", "start with !"],
    ["use #!", "use #"],
    ["use foo().", "use foo()"],
    ["a  b", "a b"],
    ["a\tb", "a b"],
    ["a\nb", "a b"],
    ["Run it", "run it"],
  ])
    assert.notEqual(statementKey(a), statementKey(b), `${a} / ${b}`);
});
