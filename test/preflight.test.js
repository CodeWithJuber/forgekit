import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ambiguityMarkers,
  assessTask,
  assessTaskLLM,
  clarifyBlock,
  completenessFeatures,
  completenessScore,
  informationGap,
  preflightRepo,
  reconcileAssumption,
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

// --- deep review D7: the scanners read addresses, fences and prose as code ---

test("D7: a code fence never pairs with inline backticks — its words are not identifiers", () => {
  const text =
    "Credentials leak from the `DelayedDelivery` consumer:\n\n```\nSetting up delayed delivery for broker `amqp://user:pw@host:5672` ...\n```\n\nUse `maybe_sanitize_url()` for this.";
  const { symbols, files } = referencedEntities(text);
  assert.ok(symbols.includes("DelayedDelivery") && symbols.includes("maybe_sanitize_url"));
  for (const w of ["Setting", "up", "delayed", "for", "broker"])
    assert.ok(!symbols.includes(w), `fence prose "${w}" is not an identifier`);
  assert.deepEqual(files, []);
  // RST/markdown ``double`` spans don't pair their inner backticks across the prose between.
  const rst = referencedEntities(
    "Add ``closes #XYZW`` to the description and/or commits (``XYZW``)",
  );
  assert.deepEqual(rst.files, [], "prose between two double-backtick spans is not code");
});

test("D7: URLs, links, images and N/A are not files; real paths still are", () => {
  const r = referencedEntities(
    "See https://example.com/issue/12, [the docs](https://docs.example.org/a/b.html) and " +
      "![shot](https://img.example.com/a.png); github.com/org/repo; N/A for docs; and/or; " +
      "input/output. <details><summary>env</summary></details> " +
      "Touch `src/api/`, src/api/user.js and ./scripts/run.",
  );
  assert.deepEqual(r.files.sort(), ["./scripts/run", "src/api/", "src/api/user.js"]);
});

test("D7: concreteness anchors ignore URLs, image links, contractions and versions", () => {
  const cases = [
    "Make it work somehow, don't break it, it's the login thing",
    "Fix the bug. ![screenshot](https://user-images.example.com/a.png) Something is wrong with it (again) since v2.3: it's broken.",
    "Improve the auth stuff. Version 2: see https://example.com/x",
  ];
  for (const text of cases)
    assert.equal(completenessFeatures(text).concreteness, 0, `no concrete anchor in: ${text}`);
  assert.equal(assessTask(cases[0]).hardUnderspecified, true, "vague + no anchor → hard ask");
  // ...while real anchors still fire.
  assert.ok(completenessFeatures("set `retries: 3` in config.yaml").concreteness >= 2);
  assert.ok(completenessFeatures("rename it to 'prod', e.g. for the deploy").concreteness >= 2);
});

test("D7: a named code identifier is a concrete anchor", () => {
  const rename = assessTask("Rename getUser to fetchUser everywhere");
  assert.equal(rename.hardUnderspecified, false, "two named identifiers are not 'no anchor'");
  assert.ok(completenessFeatures("Rename getUser to fetchUser everywhere").concreteness >= 1);
  const withPath = assessTask("Rename getUser to fetchUser in src/api/user.js");
  assert.equal(withPath.shouldAsk, false, "identifier + path clears the gate");
});

test("D7: the success-criteria cue needs the word test, not 'latest'", () => {
  const r = assessTask("Improve startup by upgrading to the latest release");
  assert.ok(
    r.missing.some((m) => m.key === "success_criteria"),
    "'latest' does not say how success is verified",
  );
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

// --- M2 completeness is a logistic estimator (smooth, bounded, calibrated), not a step scorer ---

test("completenessScore: logistic output is strictly bounded in (0,1) at feature extremes", () => {
  const floor = completenessScore({
    words: 1,
    concreteness: 0,
    specifics: 0,
    vagueness: 12,
    length: -1,
  });
  const ceil = completenessScore({
    words: 400,
    concreteness: 8,
    specifics: 8,
    vagueness: 0,
    length: 1,
  });
  assert.ok(floor > 0 && floor < 0.02, "a wall of vagueness floors near 0 without a hard clamp");
  assert.ok(ceil > 0.99 && ceil < 1, "a dense concrete spec saturates near 1 but never reaches it");
});

test("completenessScore: each concrete anchor raises completeness monotonically (no step jumps)", () => {
  let prev = -1;
  for (let c = 0; c <= 5; c++) {
    const s = completenessScore({
      words: 15,
      concreteness: c,
      specifics: 0,
      vagueness: 0,
      length: 0,
    });
    assert.ok(s > prev, `concreteness ${c} must exceed ${c - 1}`);
    prev = s;
  }
});

test("completenessScore: vagueness pulls down, specifics pull up (signed, attributable)", () => {
  const base = {
    words: 15,
    concreteness: 1,
    specifics: 0,
    vagueness: 0,
    length: 0,
  };
  assert.ok(completenessScore({ ...base, vagueness: 2 }) < completenessScore(base));
  assert.ok(completenessScore({ ...base, specifics: 2 }) > completenessScore(base));
});

test("assessTask: completeness is continuous in length — no discontinuity at the old 22/30-word steps", () => {
  // The old scorer jumped +0.1/+0.2 crossing 22/30 words; the tanh length term must be smooth,
  // so completeness for 29 vs 30 words (same other features) differs only marginally.
  const mk = (n) => `Implement parseThing to convert input to output ${"x ".repeat(n).trim()}`;
  const a = assessTask(mk(20)).completeness;
  const b = assessTask(mk(21)).completeness;
  assert.ok(Math.abs(a - b) < 0.03, `adjacent word counts must not jump (${a} vs ${b})`);
});

test("assessTask: reproduces the paper's calibrated anchor examples", () => {
  const vague = assessTask("make the auth better");
  const clear = assessTask(
    "Change verifyToken in src/auth.js to require length > 20; update tests",
  );
  assert.ok(vague.completeness < 0.3 && vague.shouldAsk, "bare ask stays under-specified");
  assert.ok(clear.completeness >= 0.6 && !clear.shouldAsk, "a concrete task clears the gate");
  // features are inspectable
  assert.equal(completenessFeatures("make the auth better").concreteness, 0);
});

// The docs quoted the verifyToken example at ≈ 0.63 while the code gave 0.878: the prior was
// set when the task had one concrete anchor, and a named identifier became a second one. Pin
// what the code computes and that the docs' example output says the same.
test("assessTask: the documented examples score what the docs say (0.23 and 0.88)", () => {
  const task = "Change verifyToken in src/auth.js to require length > 20; update tests";
  const clear = assessTask(task);
  assert.equal(clear.completeness.toFixed(2), "0.88");
  assert.equal(clear.risk, "low");
  assert.equal(assessTask("make the auth better").completeness.toFixed(2), "0.23");
  const f = completenessFeatures(task);
  assert.equal(f.concreteness, 2, "the filename plus the named identifier");
  assert.equal(
    completenessScore({ ...f, concreteness: 1 }).toFixed(2),
    "0.63",
    "one anchor — the value the prior was hand-set against",
  );
  const line = `assumption: ${clear.risk} risk · completeness ${clear.completeness.toFixed(2)}`;
  for (const doc of ["docs/GUIDE.md", "docs/cognitive-substrate/README.md"]) {
    const text = readFileSync(fileURLToPath(new URL(`../${doc}`, import.meta.url)), "utf8");
    assert.ok(text.includes(line), `${doc} shows "${line}"`);
  }
});

test("assessTaskLLM: parses a completeness reading, rejects junk", () => {
  const p = assessTaskLLM("do a thing", {
    run: () => '{"completeness":0.3,"missing":["target_scope"],"questions":["Which file?"]}',
  });
  assert.equal(p.completeness, 0.3);
  assert.deepEqual(p.missing, ["target_scope"]);
  assert.equal(assessTaskLLM("x", { run: () => "not json" }), null);
  assert.equal(assessTaskLLM("x", { run: () => '{"completeness":"nope"}' }), null);
});

test("reconcileAssumption: verdicts are compared, never the two scales blended", () => {
  const det = assessTask("Fix the bug."); // under-specified, no anchor, shouldAsk
  // Model claims fully specified — the no-anchor floor keeps the ask, and the reported
  // completeness stays the rubric's own; the proposer's reading rides along in provenance.
  const r = reconcileAssumption(det, { completeness: 1, missing: [], questions: [] });
  assert.equal(r.shouldAsk, true);
  assert.equal(r.completeness, det.completeness);
  assert.equal(r.provenance.proposalCompleteness, 1);
  assert.equal(r.provenance.path, "llm-overruled");
  assert.equal(r.provenance.overruledBy, "no-anchor");
});

test("reconcileAssumption: never clears a deterministic / hard-underspecified ask", () => {
  const det = assessTask("Fix it."); // hardUnderspecified
  assert.equal(det.shouldAsk, true);
  const r = reconcileAssumption(det, {
    completeness: 0.95,
    missing: [],
    questions: [],
  });
  assert.equal(r.shouldAsk, true, "the gate only tightens; the model cannot open it");
});

test("reconcileAssumption: extra questions survive only if grounded or on a flagged dimension", () => {
  const det = assessTask("optimize the pipeline"); // flags success_criteria/constraints dims
  const r = reconcileAssumption(
    det,
    {
      completeness: det.completeness,
      missing: det.missing.map((m) => m.key), // maps to a flagged dimension → kept
      questions: ["What is the acceptance benchmark?"],
    },
    { grounded: () => false },
  );
  assert.ok(
    r.questions.some((q) => /benchmark/.test(q)) || det.questions.length === 0,
    "a question on a flagged dimension is kept",
  );
  // An ungrounded question tied to no flagged dimension is dropped.
  const r2 = reconcileAssumption(
    det,
    {
      completeness: det.completeness,
      missing: [],
      questions: ["Unrelated musing?"],
    },
    { grounded: () => false },
  );
  assert.ok(!r2.questions.includes("Unrelated musing?"), "ungrounded extra question dropped");
});

test("reconcileAssumption: null proposal is a pure passthrough (deterministic path)", () => {
  const det = assessTask("Change verifyToken in src/auth.js to require length > 20; update tests");
  const r = reconcileAssumption(det, null);
  assert.equal(r.provenance.path, "deterministic");
  assert.equal(r.completeness, det.completeness);
  assert.equal(r.shouldAsk, det.shouldAsk);
});

test("preflightRepo (llm on): fail-safe — a throwing runner keeps the deterministic reading", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  const task = "Fix the bug.";
  const base = preflightRepo(root, task);
  const withLlm = preflightRepo(root, task, {
    llm: true,
    run: () => {
      throw new Error("no cli");
    },
  });
  assert.equal(withLlm.assumption.shouldAsk, base.assumption.shouldAsk);
  assert.equal(withLlm.assumption.provenance.path, "deterministic");
});

// --- Bidirectional M2 reconcile: clearing a false ask, guarded by hard floors ---
const detStub = (over = {}) => ({
  completeness: 0.5,
  risk: "medium",
  shouldAsk: true,
  hardUnderspecified: false,
  missing: [],
  questions: ["What exactly should this produce?"],
  reasons: [],
  ...over,
});

test("bidirectional: a verified raise clears a borderline false ask", () => {
  const det = detStub({ completeness: 0.5, shouldAsk: true });
  const r = reconcileAssumption(
    det,
    { completeness: 0.85, missing: [], questions: [] },
    { bidirectional: true, hasUnresolved: false },
  );
  assert.equal(r.shouldAsk, false, "bounded raise crosses the threshold → gate clears");
  assert.equal(r.provenance.path, "llm-cleared");
});

test("bidirectional: a hard-underspecified task is NEVER cleared", () => {
  const det = detStub({
    completeness: 0.5,
    shouldAsk: true,
    hardUnderspecified: true,
  });
  const r = reconcileAssumption(det, { completeness: 1, missing: [], questions: [] }, {});
  assert.equal(r.shouldAsk, true, "no concrete anchor → the model can't wave it through");
});

test("bidirectional: an unresolved-entity task is NEVER cleared (repo grounding floor)", () => {
  const det = detStub({ completeness: 0.55, shouldAsk: true });
  const r = reconcileAssumption(
    det,
    { completeness: 0.95, missing: [], questions: [] },
    { hasUnresolved: true },
  );
  assert.equal(r.shouldAsk, true, "names symbols/files the repo lacks → still asks");
});

test("bidirectional: an unconfident reading can't lift a vague task over the line", () => {
  const det = detStub({ completeness: 0.2, shouldAsk: true });
  const r = reconcileAssumption(det, { completeness: 0.7, missing: [], questions: [] });
  assert.equal(r.shouldAsk, true, "p(proceed) 0.7 < minConfidence 0.8 → the rubric's ask stands");
  assert.equal(r.provenance.overruledBy, "confidence");
  const opened = reconcileAssumption(
    det,
    { completeness: 0.7, missing: [], questions: [] },
    { minConfidence: 0.6 },
  );
  assert.equal(opened.shouldAsk, false, "the threshold is configurable");
});

test("bidirectional: the model can still TIGHTEN a rubric-proceed task into an ask", () => {
  const det = detStub({ completeness: 0.7, shouldAsk: false, questions: [] });
  const r = reconcileAssumption(det, { completeness: 0.1, missing: [], questions: [] });
  assert.equal(r.shouldAsk, true, "a confident 'unspecified' reading → now asks");
  assert.equal(r.provenance.path, "llm-tightened");
});

// --- deep review D6: repo grounding floors CLEARING only; it never forces an ask ---

test("D6: unresolved entities never force an ask the rubric and the model both cleared", () => {
  const det = detStub({ completeness: 0.9, shouldAsk: false, questions: [] });
  const complete = { completeness: 0.99, missing: [], questions: [] };
  for (const bidirectional of [true, false]) {
    const r = reconcileAssumption(det, complete, { hasUnresolved: true, bidirectional });
    assert.equal(r.shouldAsk, false, `bidirectional:${bidirectional} — no ask out of thin air`);
    assert.equal(r.provenance.path, "llm-agreed");
  }
  // ...while it still blocks CLEARING a rubric ask, in both modes.
  const asking = detStub({ completeness: 0.5, shouldAsk: true });
  for (const bidirectional of [true, false]) {
    const r = reconcileAssumption(asking, complete, { hasUnresolved: true, bidirectional });
    assert.equal(r.shouldAsk, true);
  }
});

test("D6 (integration): a grounded rename with a background URL is not asked when the model agrees", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-d6-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "util.js"), "export function clamp01(x) { return x; }\n");
  writeFileSync(join(root, "test", "util.test.js"), "// tests\n");
  // `clampUnit` is the rename TARGET — unresolved by definition; the URL and the "N/A"
  // placeholder are prose, and neither is a file the repo is missing.
  const tasks = [
    "Rename the helper `clamp01` in src/util.js to `clampUnit`, update every caller; tests in " +
      "test/util.test.js must pass unchanged (N/A for docs).",
    "Rename the helper `clamp01` in src/util.js to `clampUnit` and update every caller; the " +
      "existing tests must pass unchanged. Background: https://example.com/issue/12",
  ];
  for (const task of tasks) {
    const off = preflightRepo(root, task, { llm: false });
    assert.deepEqual(off.unresolved.files, [], `no phantom unresolved file in: ${task}`);
    assert.deepEqual(off.unresolved.symbols, ["clampUnit"], "only the rename target is unknown");
    assert.equal(off.assumption.shouldAsk, false, "precondition: the rubric proceeds");
    const on = preflightRepo(root, task, {
      llm: true,
      run: () => '{"completeness":0.99,"missing":[],"questions":[]}',
    });
    assert.equal(on.assumption.shouldAsk, false, "a unanimous proceed is not turned into an ask");
    assert.notEqual(on.assumption.provenance.path, "llm-tightened");
  }
});

// --- deep review D8: the proposer is judged on its own scale, not clipped to det±band ---

test("D8: a saturated rubric no longer pins a confident proposer to det − band", () => {
  const det = detStub({ completeness: 0.98, shouldAsk: false, questions: [] });
  const tight = reconcileAssumption(det, { completeness: 0.05, missing: [], questions: [] });
  assert.equal(
    tight.shouldAsk,
    true,
    "a confident 'unspecified' reading tightens a saturated rubric",
  );
  assert.equal(tight.completeness, 0.98, "and the rubric's number is not dragged onto its scale");
  const median = reconcileAssumption(det, { completeness: 0.29, missing: [], questions: [] });
  assert.equal(median.completeness, 0.98, "no clip to det − 0.25");
  assert.equal(median.provenance.proposalCompleteness, 0.29);
  assert.equal(median.shouldAsk, false, "p(ask) 0.71 is below the confidence gate");
  const low = detStub({ completeness: 0.1, shouldAsk: true });
  const cleared = reconcileAssumption(low, { completeness: 0.95, missing: [], questions: [] });
  assert.equal(cleared.shouldAsk, false, "a confident reading can clear below det 0.35 too");
});

test("bidirectional:false — the model can never clear a deterministic ask", () => {
  const det = detStub({ completeness: 0.5, shouldAsk: true });
  const r = reconcileAssumption(
    det,
    { completeness: 0.95, missing: [], questions: [] },
    { bidirectional: false, hasUnresolved: false },
  );
  assert.equal(r.shouldAsk, true, "raise-only/tighten-only mode keeps the rubric's ask");
});

test("preflightRepo (bidirectional, integration): unresolved symbol floor blocks a clear", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  // Task names `ghostSymbol`, which the (empty) repo doesn't define → the grounding floor holds
  // even though the model votes fully specified.
  const r = preflightRepo(root, "refactor `ghostSymbol` to be faster", {
    llm: true,
    run: () => '{"completeness":0.95,"missing":[],"questions":[]}',
  });
  assert.equal(r.assumption.shouldAsk, true, "unresolved entity keeps the gate closed");
});
