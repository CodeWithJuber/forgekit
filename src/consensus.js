// forge consensus — multi-lens verification (`verify --deep`). Where plain `verify`
// asks one oracle (the project's tests) plus one heuristic (unknown symbols), this
// module runs a LENSES table of independent checks and aggregates them exactly the
// way lessons.js scores mistakes: a noisy-OR defect risk score (heuristic), p = 1 −
// ∏(1 − wᵢsᵢ) — the field is `p` — with a cross-family gate (≥2 evidence families, or a
// solo-trusted lens) so a pile of correlated structural signals can never block on its
// own. `p` is a calibrated heuristic, NOT a proof or a measured defect probability.
//
// Mizan (weighed judgment — a philosophical/ethical framing, not a technical guarantee):
// the verdict ships WITH its evidence. Every lens reports whether it ran and what it saw,
// and the remaining-unchecked-weight bound ∏ⱼ(1 − cⱼ) over the lenses that actually ran
// (the field is `residual`) states how much silent-miss weight remains even on PASS — a
// green light is an evidenced heuristic claim, never a vibe, and never a proof. The reviewer lens (LLM
// majority-of-N) is opt-in, fail-safe, and can never block alone: it is a proposer
// in the adjudicate.js sense, one voice among deterministic checks.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adjudicate, asText, buildRunner, llmEnabled } from "./adjudicate.js";
import { impact, load as loadAtlas } from "./atlas.js";
import { classifyPath } from "./gate.js";
import { record as recordMetric } from "./metrics.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { check as speclockCheck } from "./speclock.js";
import { clamp01 } from "./util.js";
import { verify } from "./verify.js";

/**
 * Lens taxonomy — mirrors lessons.js SIGNALS / ledger.js ORACLES: `weight` = prior
 * that a firing lens reflects a real defect (and the Theorem-D catch probability cⱼ
 * of a lens that ran); `family` powers the cross-family gate; `solo: true` = trusted
 * to block on its own (only the project's own failing tests and a leaked secret
 * qualify). Everything structural — and the model reviewer — needs a second family.
 */
export const LENSES = {
  tests: { weight: 0.8, family: "outcome", solo: true }, // the project's own suite failed
  symbols: { weight: 0.4, family: "structural" }, // calls to symbols defined nowhere
  impact: { weight: 0.35, family: "structural" }, // atlas dependents the diff never touched
  docsdrift: { weight: 0.3, family: "structural" }, // code moved, no doc artifact moved
  secrets: { weight: 0.9, family: "security", solo: true }, // secret-shaped token in added lines
  speclock: { weight: 0.4, family: "structural" }, // a spec still claims a dropped symbol
  reviewer: { weight: 0.3, family: "model" }, // N-sample LLM majority — never solo
};

/** A firing consensus below this P(defect) stays advisory — same bar as lessons.js classify. */
export const BLOCK_THRESHOLD = 0.5;

/**
 * @typedef {{lens: string, ran?: boolean, s?: number}} LensEvent
 *   `ran !== false` means the lens executed; `s` in [0,1] is its signal strength
 *   (0 = clean). Unknown lens names are ignored (a bad event can't corrupt the verdict).
 */

/**
 * Aggregate lens events — byte-for-byte the scoreMistake shape (lessons.js):
 * noisy-OR over firing lenses (bounded in [0,1), so many weak signals can't fake
 * one strong one) + the cross-family gate. `p` is the defect risk score (heuristic).
 * `residual` is the remaining-unchecked-weight bound ∏ⱼ(1 − cⱼ) over every lens that
 * RAN (firing or clean): the share of silent-miss weight a PASS still leaves uncovered.
 * @param {LensEvent[]} events
 * @returns {{p:number, fires:boolean, families:string[], residual:number, block:boolean}}
 *   `p` = defect risk score (heuristic); `residual` = remaining unchecked weight.
 */
export function aggregate(events) {
  const ran = (events ?? []).filter((e) => e && LENSES[e.lens] && e.ran !== false);
  const firing = ran.filter((e) => clamp01(e.s ?? 0) > 0);
  const product = firing.reduce(
    (acc, e) => acc * (1 - LENSES[e.lens].weight * clamp01(e.s ?? 0)),
    1,
  );
  const p = 1 - product;
  const families = [...new Set(firing.map((e) => LENSES[e.lens].family))];
  const soloOk = firing.some((e) => LENSES[e.lens].solo);
  const fires = families.length >= 2 || soloOk;
  const residual = ran.reduce((acc, e) => acc * (1 - LENSES[e.lens].weight), 1);
  return { p, fires, families, residual, block: fires && p >= BLOCK_THRESHOLD };
}

// ---------------------------------------------------------------------------
// Deterministic lenses — each pure/guarded, each returns a LensEvent (+ evidence).
// ---------------------------------------------------------------------------

/** tests — the solo-trusted outcome oracle, read from a `verify()` result. */
export function testsLens(tests) {
  const ranSuite = tests?.ran === true;
  return {
    lens: "tests",
    ran: ranSuite,
    s: ranSuite && tests.passed !== true ? 1 : 0,
    runner: tests?.runner,
  };
}

/** symbols — verify()'s hallucinated-symbol heuristic as a structural lens. */
export function symbolsLens(unknown) {
  const list = Array.isArray(unknown) ? unknown : [];
  return {
    lens: "symbols",
    ran: true,
    s: list.length ? 1 : 0,
    unknown: list.slice(0, 12),
  };
}

/**
 * impact — atlas dependents of the changed code that the diff never touched (the
 * repairReason traversal, gate.js): a wide unreviewed blast radius is evidence, graded
 * by size (1 dependent ≈ 0.2, 5+ saturates), never proof — structural, never solo.
 * @param {object|null} atlas cached atlas (a hook-grade read: null → the lens abstains)
 * @param {string[]} changedFiles
 */
export function impactLens(atlas, changedFiles = []) {
  if (!atlas) return { lens: "impact", ran: false, s: 0, dependents: [] };
  const changed = new Set(changedFiles);
  const dependents = new Set();
  try {
    const code = changedFiles.filter((f) => classifyPath(f) === "code").slice(0, 10);
    for (const f of code)
      for (const d of impact(atlas, f, { maxHops: 2 }).impactedFiles)
        if (!changed.has(d) && classifyPath(d) === "code") dependents.add(d);
  } catch {
    return { lens: "impact", ran: false, s: 0, dependents: [] };
  }
  const list = [...dependents].sort().slice(0, 10);
  return {
    lens: "impact",
    ran: true,
    s: clamp01(dependents.size / 5),
    dependents: list,
  };
}

/** docsdrift — the completion-gate F1 signal (gate.js classifyPath): code class moved,
 *  docs class didn't. Advisory weight — `.forge/state.md` moves are invisible to a diff. */
export function docsDriftLens(changedFiles = []) {
  const code = [];
  let docs = 0;
  for (const f of changedFiles) {
    const c = classifyPath(f);
    if (c === "code") code.push(f);
    else if (c === "docs") docs += 1;
  }
  const drifted = code.length > 0 && docs === 0;
  return {
    lens: "docsdrift",
    ran: true,
    s: drifted ? 1 : 0,
    codeFiles: code.slice(0, 10),
  };
}

/** secrets — solo-trusted security lens over the ADDED diff lines (secrets.js detectors).
 *  Uses redaction-grade precision (hasSecret AND redactSecrets changes the text), the same
 *  narrowed check commit_gate.js uses for its blocking path: hasSecret's ASSIGNED branch
 *  alone refuses any key-assigned value (e.g. `token = process.env.TOKEN`), which must not
 *  block a solo-trusted lens. One source of truth (secrets.js), calibrated to the verb. */
export function secretsLens(added) {
  const text = String(added ?? "");
  return {
    lens: "secrets",
    ran: true,
    s: hasSecret(text) && redactSecrets(text) !== text ? 1 : 0,
  };
}

/** speclock — spec-as-contract drift (speclock.js). No lock file → the lens abstains. */
export function speclockLens(root) {
  try {
    const r = speclockCheck(root);
    if (r.note) return { lens: "speclock", ran: false, s: 0, drift: [] };
    return {
      lens: "speclock",
      ran: true,
      s: r.drift.length ? 1 : 0,
      drift: r.drift.slice(0, 10),
    };
  } catch {
    return { lens: "speclock", ran: false, s: 0, drift: [] };
  }
}

// ---------------------------------------------------------------------------
// Reviewer lens — majority-of-N independent model samples (opt-in, never solo).
// ---------------------------------------------------------------------------

export function buildReviewPrompt({ files = [], added = "" } = {}) {
  return `You are ONE independent reviewer on a majority-vote panel. Judge whether this diff
plausibly contains a REAL defect — broken logic, wrong behavior, a missed edge case — not style.
Changed files: ${files.slice(0, 20).join(", ") || "(none listed)"}
Added lines:
"""${String(added).slice(0, 4000)}"""
Answer with STRICT JSON and nothing else:
{"verdict":"defect|pass","reason":"<short why>"}
No text outside the JSON object.`;
}

/** Validate one reviewer reply — anything but a clear defect/pass verdict is unusable. */
export function parseReviewProposal(obj) {
  const verdict = String(obj.verdict ?? "")
    .trim()
    .toLowerCase();
  if (verdict !== "defect" && verdict !== "pass") return null;
  return { verdict, reason: asText(obj.reason) };
}

/**
 * N independent `adjudicate` samples over the same evidence, majority vote. Abstains
 * (ran:false) when fewer than ⌈n/2⌉ replies are usable — a panel that mostly failed
 * to answer must not vote. Gated on `llmEnabled` (FORGE_LLM=1 or explicit opt-in);
 * off → ran:false and the deterministic lenses decide alone, byte-identical to today.
 * @param {{files?:string[], added?:string, n?:number, llm?:boolean, run?:(p:string)=>string}} [opts]
 */
export function reviewerLens({ files = [], added = "", n = 3, llm, run } = {}) {
  if (!llmEnabled({ llm }))
    return { lens: "reviewer", ran: false, s: 0, verdict: "off", votes: [] };
  const runner = run ?? buildRunner();
  const prompt = buildReviewPrompt({ files, added });
  const votes = [];
  for (let i = 0; i < Math.max(1, n); i += 1) {
    const v = adjudicate({ prompt, parse: parseReviewProposal, run: runner });
    if (v) votes.push(v);
  }
  if (votes.length < Math.ceil(Math.max(1, n) / 2))
    return { lens: "reviewer", ran: false, s: 0, verdict: "abstain", votes };
  const defects = votes.filter((v) => v.verdict === "defect").length;
  const defect = defects > votes.length / 2; // strict majority of USABLE votes; a tie passes
  return {
    lens: "reviewer",
    ran: true,
    s: defect ? defects / votes.length : 0,
    verdict: defect ? "defect" : "pass",
    votes,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — `forge verify --deep`.
// ---------------------------------------------------------------------------

/** One human-readable line per firing lens — the findings a reviewer actually reads. */
function findingsOf(lenses) {
  const out = [];
  for (const l of lenses) {
    if (l.ran === false || !(l.s > 0)) continue;
    if (l.lens === "tests") out.push(`tests failed (${l.runner ?? "project suite"})`);
    if (l.lens === "symbols")
      out.push(`calls symbols defined nowhere in the codebase: ${l.unknown.join(", ")}`);
    if (l.lens === "impact")
      out.push(`dependents of the changed code are not in this diff: ${l.dependents.join(", ")}`);
    if (l.lens === "docsdrift")
      out.push(`code changed with no doc artifact: ${l.codeFiles.join(", ")}`);
    if (l.lens === "secrets") out.push("a secret-shaped token appears in the added lines");
    if (l.lens === "speclock")
      out.push(
        `specs still claim symbols the code dropped: ${l.drift
          .map((d) => `${d.spec}:${d.symbol}`)
          .join(", ")}`,
      );
    if (l.lens === "reviewer")
      out.push(
        `reviewer panel majority says defect (${l.votes.filter((v) => v.verdict === "defect").length}/${l.votes.length})`,
      );
  }
  return out;
}

const round4 = (x) => Number(Number(x).toFixed(4));

/**
 * Multi-lens verification: run plain `verify()` (tests + unknown symbols + base
 * provenance), add the structural/security lenses and the optional reviewer panel,
 * aggregate, and persist — findings extend `.forge/provenance.json` and one
 * `stage:"verify"` metrics record is appended. Blocks (ok:false) only on
 * cross-family consensus or a solo-trusted lens at P(defect) ≥ BLOCK_THRESHOLD.
 * @param {object} [opts]
 * @param {string} [opts.targetRoot]
 * @param {string} [opts.base]
 * @param {boolean} [opts.llm] explicit reviewer opt-in/out (default: FORGE_LLM env)
 * @param {(p:string)=>string} [opts.run] injectable reviewer runner (tests: no network)
 * @param {number} [opts.reviewers] panel size N (default 3)
 * @param {typeof verify} [opts.verifyImpl] injectable core verify (tests: no test-suite run)
 */
export function verifyDeep({
  targetRoot = process.cwd(),
  base = "HEAD",
  llm,
  run,
  reviewers = 3,
  verifyImpl = verify,
} = {}) {
  const core = verifyImpl({ targetRoot, base });
  const changed = core.changedFiles ?? [];
  const added = core.added ?? "";
  let atlas = null;
  try {
    atlas = loadAtlas(targetRoot);
  } catch {}
  const lenses = [
    testsLens(core.tests),
    symbolsLens(core.unknown),
    impactLens(atlas, changed),
    docsDriftLens(changed),
    secretsLens(added),
    speclockLens(targetRoot),
    reviewerLens({ files: changed, added, n: reviewers, llm, run }),
  ];
  const verdict = aggregate(lenses);
  const findings = findingsOf(lenses);
  const deep = {
    lenses: lenses.map((l) => ({
      lens: l.lens,
      ran: l.ran !== false,
      s: round4(l.s ?? 0),
      weight: LENSES[l.lens].weight,
      family: LENSES[l.lens].family,
    })),
    findings,
    p: round4(verdict.p),
    families: verdict.families,
    fires: verdict.fires,
    residual: round4(verdict.residual),
    block: verdict.block,
  };
  const provenance = { ...core.provenance, deep };
  try {
    mkdirSync(join(targetRoot, ".forge"), { recursive: true });
    writeFileSync(
      join(targetRoot, ".forge", "provenance.json"),
      JSON.stringify(provenance, null, 2),
    );
  } catch {}
  recordMetric(targetRoot, {
    stage: "verify",
    outcome: verdict.block ? "block" : "pass",
    mode: "deep",
    lenses: deep.lenses.filter((l) => l.ran).length,
    p: deep.p,
    residual: deep.residual,
  });
  return {
    ok: !verdict.block,
    block: verdict.block,
    p: deep.p,
    fires: verdict.fires,
    families: verdict.families,
    residual: deep.residual,
    lenses,
    findings,
    provenance,
    tests: core.tests,
    changedFiles: changed,
  };
}
