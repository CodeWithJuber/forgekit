import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aggregate,
  BLOCK_THRESHOLD,
  buildReviewPrompt,
  docsDriftLens,
  impactLens,
  LENSES,
  parseReviewProposal,
  reviewerLens,
  secretsLens,
  speclockLens,
  symbolsLens,
  testsLens,
  verifyDeep,
} from "../src/consensus.js";
import { fakeAnthropic } from "./_fixtures.js";

// ---------------------------------------------------------------------------
// LENSES table — the taxonomy the whole module hangs off.
// ---------------------------------------------------------------------------

test("LENSES: every weight in (0,1), every family named; only tests+secrets are solo", () => {
  for (const [name, l] of Object.entries(LENSES)) {
    assert.ok(l.weight > 0 && l.weight < 1, `${name} weight bounded`);
    assert.ok(typeof l.family === "string" && l.family, `${name} has a family`);
  }
  assert.equal(LENSES.tests.solo, true);
  assert.equal(LENSES.secrets.solo, true);
  for (const name of ["symbols", "impact", "docsdrift", "speclock", "reviewer"])
    assert.ok(!LENSES[name].solo, `${name} must never be trusted solo`);
});

// ---------------------------------------------------------------------------
// aggregate — noisy-OR + cross-family gate (the scoreMistake shape).
// ---------------------------------------------------------------------------

test("aggregate: a single structural lens never blocks, however loud", () => {
  const r = aggregate([{ lens: "symbols", s: 1 }]);
  assert.equal(r.p, LENSES.symbols.weight);
  assert.equal(r.fires, false);
  assert.equal(r.block, false);
});

test("aggregate: many same-family structural signals still can't block (correlated evidence)", () => {
  const r = aggregate([
    { lens: "symbols", s: 1 },
    { lens: "speclock", s: 1 },
    { lens: "docsdrift", s: 1 },
    { lens: "impact", s: 1 },
  ]);
  assert.ok(r.p >= BLOCK_THRESHOLD, "noisy-OR piles up");
  assert.deepEqual(r.families, ["structural"]);
  assert.equal(r.fires, false, "one family — the gate holds");
  assert.equal(r.block, false);
});

test("aggregate: a solo test failure blocks on its own", () => {
  const r = aggregate([{ lens: "tests", s: 1 }]);
  assert.equal(r.fires, true);
  assert.ok(r.p >= BLOCK_THRESHOLD);
  assert.equal(r.block, true);
});

test("aggregate: a leaked secret blocks on its own", () => {
  const r = aggregate([{ lens: "secrets", s: 1 }]);
  assert.equal(r.block, true);
});

test("aggregate: two families cross the gate (reviewer can block only WITH a second family)", () => {
  const alone = aggregate([{ lens: "reviewer", s: 1 }]);
  assert.equal(alone.block, false, "model lens never blocks alone");
  const paired = aggregate([
    { lens: "reviewer", s: 1 },
    { lens: "docsdrift", s: 1 },
  ]);
  assert.equal(paired.fires, true);
  assert.ok(Math.abs(paired.p - 0.51) < 1e-9, "1 − 0.7·0.7");
  assert.equal(paired.block, true);
});

test("aggregate: P(defect) stays bounded < 1 with every lens firing", () => {
  const all = Object.keys(LENSES).map((lens) => ({ lens, s: 1 }));
  const r = aggregate(all);
  assert.ok(r.p < 1);
});

test("aggregate: residual is ∏(1−w) over lenses that RAN — clean lenses count, skipped don't", () => {
  const r = aggregate([
    { lens: "tests", s: 0 },
    { lens: "symbols", s: 0 },
    { lens: "reviewer", ran: false },
  ]);
  assert.equal(r.p, 0);
  assert.equal(r.fires, false);
  assert.ok(Math.abs(r.residual - 0.2 * 0.6) < 1e-9, "0.2·0.6 — reviewer skipped");
  const none = aggregate([{ lens: "tests", ran: false }]);
  assert.equal(none.residual, 1, "nothing ran → no coverage claimed");
});

test("aggregate: clean lenses contribute no family; unknown lens names are ignored", () => {
  const r = aggregate([
    { lens: "tests", s: 0 },
    { lens: "docsdrift", s: 1 },
    { lens: "not-a-lens", s: 1 },
  ]);
  assert.deepEqual(r.families, ["structural"]);
  assert.equal(r.fires, false);
});

// ---------------------------------------------------------------------------
// Deterministic lenses.
// ---------------------------------------------------------------------------

test("testsLens: abstains when no suite ran; fires on fail; clean on pass", () => {
  assert.equal(testsLens({ ran: false }).ran, false);
  assert.equal(testsLens(undefined).ran, false);
  assert.equal(testsLens({ ran: true, passed: false }).s, 1);
  assert.equal(testsLens({ ran: true, passed: true }).s, 0);
});

test("symbolsLens fires only on unknown symbols", () => {
  assert.equal(symbolsLens([]).s, 0);
  const l = symbolsLens(["ghostFn"]);
  assert.equal(l.s, 1);
  assert.deepEqual(l.unknown, ["ghostFn"]);
});

test("docsDriftLens: code without docs fires; code+docs and docs-only stay clean", () => {
  assert.equal(docsDriftLens(["src/x.js"]).s, 1);
  assert.equal(docsDriftLens(["src/x.js", "README.md"]).s, 0);
  assert.equal(docsDriftLens(["README.md"]).s, 0);
  assert.equal(docsDriftLens([]).s, 0);
});

test("secretsLens fires on a secret-shaped token in the added lines", () => {
  assert.equal(secretsLens("const x = 1;").s, 0);
  assert.equal(secretsLens(`key = "${fakeAnthropic()}"`).s, 1);
});

test("impactLens: null atlas abstains; dependents not in the diff fire, graded by count", () => {
  assert.equal(impactLens(null, ["a.js"]).ran, false);
  const atlas = {
    nodes: [
      { id: "mod:a", name: "a.js", file: "a.js" },
      { id: "mod:b", name: "b.js", file: "b.js" },
    ],
    edges: [{ source: "mod:b", target: "mod:a", kind: "imports" }],
    symbols: [],
  };
  const l = impactLens(atlas, ["a.js"]);
  assert.equal(l.ran, true);
  assert.deepEqual(l.dependents, ["b.js"]);
  assert.ok(Math.abs(l.s - 0.2) < 1e-9, "1 dependent / 5 = 0.2");
  // dependent already IN the diff → reviewed → clean
  assert.equal(impactLens(atlas, ["a.js", "b.js"]).s, 0);
});

test("speclockLens abstains honestly when no spec lock exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    assert.equal(speclockLens(dir).ran, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reviewer lens — majority-of-N with an injected runner (never the network).
// ---------------------------------------------------------------------------

// Injected reviewer runner: replays scripted replies in order, repeating the last —
// three "independent" samples without a model or the network anywhere near the test.
const scripted = (outputs) => {
  let i = 0;
  return () => outputs[Math.min(i++, outputs.length - 1)];
};

test("reviewerLens: off unless opted in — deterministic result untouched", () => {
  const r = reviewerLens({
    llm: false,
    run: scripted(['{"verdict":"defect"}']),
  });
  assert.equal(r.ran, false);
  assert.equal(r.verdict, "off");
});

test("reviewerLens: strict majority of usable votes says defect", () => {
  const run = scripted([
    '{"verdict":"defect","reason":"off-by-one"}',
    '{"verdict":"pass"}',
    '{"verdict":"defect","reason":"same"}',
  ]);
  const r = reviewerLens({ llm: true, n: 3, run, added: "x" });
  assert.equal(r.ran, true);
  assert.equal(r.verdict, "defect");
  assert.ok(Math.abs(r.s - 2 / 3) < 1e-9);
});

test("reviewerLens: all-pass panel is clean (s=0)", () => {
  const r = reviewerLens({
    llm: true,
    n: 3,
    run: scripted(['{"verdict":"pass"}']),
  });
  assert.equal(r.verdict, "pass");
  assert.equal(r.s, 0);
});

test("reviewerLens: abstains when fewer than ⌈n/2⌉ replies are usable", () => {
  const run = scripted(["garbage", "not json either", '{"verdict":"defect"}']);
  const r = reviewerLens({ llm: true, n: 3, run });
  assert.equal(r.ran, false);
  assert.equal(r.verdict, "abstain");
});

test("reviewerLens: a tie among usable votes passes (no strict majority)", () => {
  const run = scripted(["garbage", '{"verdict":"defect"}', '{"verdict":"pass"}']);
  const r = reviewerLens({ llm: true, n: 3, run });
  assert.equal(r.ran, true, "2 usable ≥ ⌈3/2⌉");
  assert.equal(r.verdict, "pass");
  assert.equal(r.s, 0);
});

test("parseReviewProposal: only a clear defect/pass verdict is usable", () => {
  assert.equal(parseReviewProposal({ verdict: "maybe" }), null);
  assert.equal(parseReviewProposal({}), null);
  assert.equal(parseReviewProposal({ verdict: "DEFECT", reason: "x" }).verdict, "defect");
  assert.equal(parseReviewProposal({ verdict: " pass " }).verdict, "pass");
});

test("buildReviewPrompt: names the files, caps the diff, demands strict JSON", () => {
  const p = buildReviewPrompt({ files: ["src/a.js"], added: "y".repeat(9000) });
  assert.ok(p.includes("src/a.js"));
  assert.ok(p.includes('{"verdict":"defect|pass"'));
  assert.ok(p.length < 6000, "added lines are truncated");
});

// ---------------------------------------------------------------------------
// verifyDeep — orchestration with an injected core verify (no real test-suite run).
// ---------------------------------------------------------------------------

const fakeCore = (over = {}) => ({
  ok: true,
  provenance: {
    base: "HEAD",
    changedFiles: [],
    tests: {},
    symbolsChecked: 0,
    unknownSymbols: [],
  },
  unknown: [],
  tests: { ran: true, passed: true, runner: "npm test" },
  changedFiles: ["src/x.js", "README.md"],
  added: "const y = 2;",
  ...over,
});

test("verifyDeep: clean diff passes, persists provenance.deep + one verify metrics record", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () => fakeCore(),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.findings, []);
    assert.equal(r.p, 0);
    assert.ok(r.residual > 0 && r.residual < 1, "some lenses ran — coverage is claimed");
    const prov = JSON.parse(readFileSync(join(dir, ".forge", "provenance.json"), "utf8"));
    assert.equal(prov.deep.block, false);
    assert.ok(Array.isArray(prov.deep.lenses) && prov.deep.lenses.length === 7);
    assert.equal(prov.deep.residual, r.residual);
    const metrics = readFileSync(join(dir, ".forge", "metrics.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].stage, "verify");
    assert.equal(metrics[0].outcome, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: a NOT_CONFIGURED core is NOT recorded as an outcome 'pass' (ME-01)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () => fakeCore({ tests: { ran: false, status: "NOT_CONFIGURED" } }),
    });
    assert.equal(r.status, "NOT_CONFIGURED");
    assert.equal(r.ok, false, "an unverified core is never ok");
    const metrics = readFileSync(join(dir, ".forge", "metrics.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.notEqual(metrics[0].outcome, "pass", "unverified must not count as a pass");
    assert.equal(metrics[0].outcome, "not_configured");
    assert.equal(metrics[0].status, "NOT_CONFIGURED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: a failing test suite blocks solo; findings + block land in provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () => fakeCore({ tests: { ran: true, passed: false, runner: "npm test" } }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.block, true);
    assert.ok(r.findings.some((f) => f.includes("tests failed")));
    const prov = JSON.parse(readFileSync(join(dir, ".forge", "provenance.json"), "utf8"));
    assert.equal(prov.deep.block, true);
    const metrics = readFileSync(join(dir, ".forge", "metrics.jsonl"), "utf8");
    assert.ok(metrics.includes('"outcome":"block"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: structural findings alone stay advisory (no block)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () =>
        fakeCore({
          unknown: ["ghostFn"],
          changedFiles: ["src/x.js"] /* no docs → drift too */,
        }),
    });
    assert.equal(r.ok, true, "two structural lenses — one family, the gate holds");
    assert.ok(r.findings.length >= 2);
    assert.equal(r.fires, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: reviewer panel joins via injected runner and can tip a second family", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: true,
      run: scripted(['{"verdict":"defect","reason":"wrong edge"}']),
      verifyImpl: () => fakeCore({ changedFiles: ["src/x.js"] }), // docsdrift fires (structural)
    });
    assert.equal(r.fires, true, "model + structural = two families");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes("reviewer panel")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// RA-01 — deep ok is a conjunction: core tests PASS AND no consensus block.
// ---------------------------------------------------------------------------

test("verifyDeep: NOT_CONFIGURED core is never ok, even with every lens clean (RA-01)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () => fakeCore({ tests: { ran: false, status: "NOT_CONFIGURED" } }),
    });
    assert.equal(r.ok, false, "nothing ran must never be deep-ok");
    assert.equal(r.status, "NOT_CONFIGURED");
    assert.equal(r.block, false, "the lenses did not block — the CORE verdict did");
    const prov = JSON.parse(readFileSync(join(dir, ".forge", "provenance.json"), "utf8"));
    assert.equal(prov.deep.status, "NOT_CONFIGURED", "deep status persisted additively");
    assert.equal(prov.deep.block, false, "existing provenance fields untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: INCOMPLETE core (detected but unexecutable runner) is not ok (RA-01)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () =>
        fakeCore({
          tests: {
            ran: false,
            status: "INCOMPLETE",
            detected: ["go test ./..."],
          },
        }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, "INCOMPLETE");
    assert.deepEqual(r.tests.detected, ["go test ./..."], "the detected runner rides along");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: explicit four-state FAIL core blocks with status FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () => fakeCore({ tests: { ran: true, passed: false, status: "FAIL" } }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, "FAIL");
    assert.equal(r.block, true, "a failing suite still blocks solo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: passing core + clean lenses → ok:true with status PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () => fakeCore(),
    });
    assert.equal(r.ok, true, "ran/passed fallback: a status-less passing core still derives PASS");
    assert.equal(r.status, "PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: passing core + blocking finding → ok:false with status FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () =>
        fakeCore({
          tests: {
            ran: true,
            passed: true,
            status: "PASS",
            runner: "npm test",
          },
          added: `token = "${fakeAnthropic()}"`, // secrets lens blocks solo
        }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, "FAIL", "consensus block on a PASSing core reads as FAIL");
    assert.equal(r.block, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyDeep: a secret in the added lines blocks solo", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-consensus-"));
  try {
    const r = verifyDeep({
      targetRoot: dir,
      llm: false,
      verifyImpl: () => fakeCore({ added: `token = "${fakeAnthropic()}"` }),
    });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes("secret")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
