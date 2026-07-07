// Labeled impact-oracle cases derived from THIS repo's real import graph.
//
// Labeling rule (hand-verified by reading the actual source, then double-checked with
// grep): `expected` = the defining file PLUS every file with a DIRECT reference to the
// target symbol — an `import { X }` with a use, or a call site of `X(`. The defining
// file is always labeled: an edit to the target trivially impacts its own file (same
// convention as the existing fixture in test/eval.test.js and the paper's mutation
// methodology, where the mutated file itself counts). Transitive dependents are
// deliberately NOT labeled: the oracle predicts them (its job — err toward inclusion),
// so they count against precision here, exactly like the paper's mutation-derived
// scoring penalized over-approximation. Every label is grep-checkable by anyone.
//
// These cases are evaluated against an atlas built over a copy of this repo that
// EXCLUDES bench/ — otherwise the harness's own imports of these symbols would
// perturb the measurement it is taking.
//
// Verified references, per case (as of the commit this file lands in):
//
// normalizeSpec (src/reuse.js)
//   - src/reuse.js        defines it; fingerprint() and artifactClaim() call it
//   - test/reuse.test.js  imports { normalizeSpec } and calls it directly
//
// evalImpact (src/eval.js)
//   - src/eval.js         defines it (no other same-file caller)
//   - test/eval.test.js   imports { evalImpact } and calls it — the only referencer
//
// isStale (src/atlas.js)
//   - src/atlas.js        defines it
//   - src/verify.js       imports { isStale } from ./atlas.js and calls it
//   - src/doctor.js       imports { isStale } from ./atlas.js and calls it
//   - test/atlas.test.js  imports { isStale } and calls it
//
// mergeStates (src/ledger.js)
//   - src/ledger.js       defines it
//   - src/ledger_store.js imports { mergeStates } (importState calls it)
//   - test/ledger.test.js imports { mergeStates } and calls it
//
// claimText (src/ledger.js)
//   - src/ledger.js       defines it; sketchOf() calls it (same-file caller)
//   - src/context.js      imports { claimText } and calls it
//   - src/dash.js         imports { claimText } and calls it
//   - src/cli.js          dynamic-imports { claimText } and calls it
//   - test/ledger.test.js imports { claimText } and calls it
//   (test/dash.test.js mentions the name only inside an assertion message — a string,
//    not a reference — so it is NOT labeled as a dependent.)
//
// contentHash (src/util.js) — the deliberately hard case: wide fan-out plus one
// reference the regex atlas is KNOWN to miss (src/atlas.js binds it to an alias,
// `const hash = contentHash;`, with no call parentheses — and the JS import regex
// captures module paths, not named bindings — so no edge exists; that is a real,
// documented false negative, kept in the labels on purpose).
//   - src/util.js         defines it
//   - src/atlas.js        imports { contentHash }, aliases it (const hash = contentHash)
//   - src/cortex_hook.js  imports { contentHash } and calls it
//   - src/diagnose.js     imports { contentHash } and calls it
//   - src/ledger.js       imports { contentHash } and calls it
//   - src/reuse.js        imports { contentHash } and calls it

export const IMPACT_CASES = [
  {
    target: "normalizeSpec",
    expected: ["src/reuse.js", "test/reuse.test.js"],
    editedFile: "src/reuse.js",
  },
  {
    target: "evalImpact",
    expected: ["src/eval.js", "test/eval.test.js"],
    editedFile: "src/eval.js",
  },
  {
    target: "isStale",
    expected: ["src/atlas.js", "src/verify.js", "src/doctor.js", "test/atlas.test.js"],
    editedFile: "src/atlas.js",
  },
  {
    target: "mergeStates",
    expected: ["src/ledger.js", "src/ledger_store.js", "test/ledger.test.js"],
    editedFile: "src/ledger.js",
  },
  {
    target: "claimText",
    expected: [
      "src/ledger.js",
      "src/context.js",
      "src/dash.js",
      "src/cli.js",
      "test/ledger.test.js",
    ],
    editedFile: "src/ledger.js",
  },
  {
    target: "contentHash",
    expected: [
      "src/util.js",
      "src/atlas.js",
      "src/cortex_hook.js",
      "src/diagnose.js",
      "src/ledger.js",
      "src/reuse.js",
    ],
    editedFile: "src/util.js",
  },
];
