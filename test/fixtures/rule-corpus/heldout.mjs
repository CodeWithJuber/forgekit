// HELD-OUT set: written after the tuning set passed. Known packages for this set: react, express,
// jest, zod, request. First measurement: 18 of 20 right and no sentence compiled that must not
// be. One miss was a trailing clause ("; it is deprecated"), fixed; the other ("Avoid zod in
// src/core") was labelled no-text by mistake and also missed; the label is corrected here.
export const HELDOUT = [
  ["Do not import request; it is deprecated", "no-import:request"],
  ["never require 'left-pad'", "no-import:left-pad"],
  ["Use vitest instead of jest", "no-import:jest"],
  ["We use bun, not yarn.", "no-file:yarn.lock"],
  ["No debugger statements", "no-text:debugger statements"],
  ["Don't leave TODO comments in src/", "no-text:TODO markers:src"],
  ['Never hardcode "http://127.0.0.1"', "no-text:http://127.0.0.1"],
  ["Please avoid @ts-ignore", "no-text:@ts-ignore"],
  ["Never use print() in app", "no-text:print():app"],
  ["express is not allowed in packages/web", "no-import:express:packages/web"],
  ["Don't install the moment library", "no-import:moment"],
  ["Avoid zod in src/core", "no-import:zod:src/core"],
  // must NOT compile
  ["Never use global state", null],
  ["Prefer small pull requests over big ones", null],
  ["Use early returns rather than nested ifs", null],
  ["Don't use real network calls in unit tests", null],
  ["Never push directly to main", null],
  ["Avoid premature optimization", null],
  ["Use TypeScript strict mode", null],
  ["No breaking changes without a major version", null],
];
