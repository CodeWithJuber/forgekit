// Labeled impact-oracle cases derived from THIS repo's real import graph.
//
// Labeling rule (derived by grep, then hand-verified by opening every hit): `expected` =
// the defining file PLUS every file with a DIRECT reference to the target symbol — an
// `import { X }` (static, dynamic, or aliased) with a use, or a call site of `X(`. The
// defining file is always labeled: an edit to the target trivially impacts its own file
// (same convention as the existing fixture in test/eval.test.js and the paper's mutation
// methodology, where the mutated file itself counts). Transitive dependents are
// deliberately NOT labeled: the oracle predicts them (its job — err toward inclusion),
// so they count against precision here, exactly like the paper's mutation-derived
// scoring penalized over-approximation.
//
// The labels are GROUND TRUTH, never the graph's own output: each one is reproducible
// with `git grep -n -w -F -e <symbol> -- 'src/*' 'test/*'` and reading each hit. A hit
// that is only a comment or a string (a name inside an assertion message, a doc line)
// is NOT a reference and is not labeled — those are listed below where they occur, so a
// re-check can confirm the omission was deliberate rather than missed.
//
// These cases are evaluated against an atlas built over a copy of this repo that
// EXCLUDES bench/ — otherwise the harness's own imports of these symbols would
// perturb the measurement it is taking.
//
// Verified references, per case (re-derived at the commit this file lands in):
//
// normalizeSpec (src/reuse.js) — 2 files
//   - src/reuse.js        defines it (:70); fingerprint() (:89) and artifactClaim() (:147) call it
//   - test/reuse.test.js  imports { normalizeSpec } (:17) and calls it directly
//   (src/reuse.js:40 also names it in a header comment — same file, already labeled.)
//
// evalImpact (src/eval.js) — 2 files
//   - src/eval.js         defines it (:28) (no other same-file caller)
//   - test/eval.test.js   imports { evalImpact } (:7) and calls it (:34) — the only referencer
//
// isStale (src/atlas.js) — 6 files
//   - src/atlas.js             defines it (:1026)
//   - src/verify.js            imports { isStale } (:11) and calls it (:456)
//   - src/doctor.js            imports { isStale } (:18) and calls it (:249)
//   - src/substrate.js         imports it ALIASED (`isStale as atlasIsStale`, :11) and calls
//                              it twice (:177, :269) — an aliased import is still a reference
//   - test/atlas.test.js       imports { isStale } (:6) and calls it
//   - test/atlas_resolve.test.js imports { isStale } (:11) and calls it (:187, :190)
//
// mergeStates (src/ledger.js) — 4 files
//   - src/ledger.js       defines it (:796)
//   - src/ledger_store.js imports { mergeStates } (:33); importState calls it (:614)
//   - src/ledger_sync.js  imports { mergeStates } (:22) and calls it (:218)
//   - test/ledger.test.js imports { mergeStates } (:14) and calls it
//   (src/ledger_sync.js:3 also names it in the module header — same file, already labeled.)
//
// claimText (src/ledger.js) — 9 files
//   - src/ledger.js       defines it (:610); sketchOf() (:636), termsOf() (:637) and :880 call it
//   - src/context.js      imports { claimText } (:13) and calls it (:185)
//   - src/dash.js         imports { claimText } (:16) and calls it (:58, :389, :400)
//   - src/deja.js         imports { claimText } (:19) and calls it (:179)
//   - src/ledger_store.js imports { claimText } (:26) and calls it (:663)
//   - src/cli.js          dynamic-imports { claimText } (:874, :1644) and calls it
//   - src/cortex_mcp.js   dynamic-imports { claimText } (:91) and calls it (:96, :106)
//   - test/ledger.test.js imports { claimText } (:8) and calls it
//   - src/learn_consolidate.js imports { claimText } (:32) and calls it (:110)
//   (test/dash.test.js:69 mentions the name only inside an assertion message — a string,
//    not a reference — so it is NOT labeled as a dependent.)
//
// contentHash (src/util.js) — 10 files. The widest fan-out in the set, and the case that
// used to carry a documented FALSE NEGATIVE: src/atlas.js binds it to an alias,
// `const hash = contentHash;` at :187, with no call parentheses, and the old import regex
// captured module paths rather than named bindings, so no edge reached atlas.js. That is
// FIXED — a named import now resolves to the exact symbol node
// (`src/atlas.js:17 imports → src/util.js:contentHash:65`), and atlas.js is predicted at
// one hop. The case is kept for its fan-out, not for the miss.
//   - src/util.js         defines it (:65); slug() calls it (:28)
//   - src/atlas.js        imports { contentHash } (:17), aliases it (:187)
//   - src/cortex_hook.js  imports it (:9) and calls it (:98)
//   - src/cost_report.js  imports it (:14); routeRef() calls it (:212)
//   - src/diagnose.js     imports it (:15); failureSignature() calls it (:57)
//   - src/embed.js        imports it (:35) and calls it (:202)
//   - src/ledger.js       imports it (:18) and calls it (:136, :141, :947, :962, :963)
//   - src/ledger_store.js imports it (:43) and calls it (:414, :598)
//   - src/reuse.js        imports it (:15) and calls it (:94, :116, :400)
//   - src/uiinteract.js   imports it (:19) and calls it (:46)
//   (src/ledger_store.js:586 also names it in a doc comment — same file, already labeled.)
//   No test file references contentHash directly.

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
    expected: [
      "src/atlas.js",
      "src/verify.js",
      "src/doctor.js",
      "src/substrate.js",
      "test/atlas.test.js",
      "test/atlas_resolve.test.js",
    ],
    editedFile: "src/atlas.js",
  },
  {
    target: "mergeStates",
    expected: ["src/ledger.js", "src/ledger_store.js", "src/ledger_sync.js", "test/ledger.test.js"],
    editedFile: "src/ledger.js",
  },
  {
    target: "claimText",
    expected: [
      "src/ledger.js",
      "src/context.js",
      "src/dash.js",
      "src/deja.js",
      "src/learn_consolidate.js",
      "src/ledger_store.js",
      "src/cli.js",
      "src/cortex_mcp.js",
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
      "src/cost_report.js",
      "src/diagnose.js",
      "src/embed.js",
      "src/ledger.js",
      "src/ledger_store.js",
      "src/reuse.js",
      "src/uiinteract.js",
    ],
    editedFile: "src/util.js",
  },
];
