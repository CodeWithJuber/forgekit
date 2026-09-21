// forge preflight — the assumption detector. Before the agent spends a token, scan the task
// for code identifiers/files it NAMES but the repo doesn't DEFINE — those are the things it
// will silently ASSUME. The richer assumption gate also scores specification completeness.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { adjudicate, asText, asUnit, buildRunner, llmEnabled } from "./adjudicate.js";
import { build as buildAtlas, has, load as loadAtlas } from "./atlas.js";
import { jevEnabled, noul, systemOne } from "./jev.js";
import { sigmoid } from "./predictor.js";
import { CODE_EXT } from "./util.js";

const STOP = new Set([
  "the",
  "this",
  "that",
  "add",
  "fix",
  "make",
  "use",
  "code",
  "file",
  "test",
  "error",
  "errors",
  "function",
  "class",
  "value",
  "data",
  "type",
  "name",
  "todo",
  "note",
]);

const rx = (pattern) => new RegExp(pattern, "i");

const DIMENSIONS = [
  {
    key: "inputs_outputs",
    description: "exact input/output behavior",
    question: "What exact inputs, outputs, examples, or return values should this satisfy?",
    applies: rx(
      "\\b(function|api|endpoint|parse|convert|transform|read|write|generate|compute|return|implement)\\b",
    ),
    cues: rx(
      "(->|=>|input|output|returns?|given|example|e\\.g\\.|for example|format|json|csv|schema|signature|expected|```)",
    ),
  },
  {
    key: "target_scope",
    description: "target file/module/component scope",
    question: "Which specific file, module, component, or symbol should this change touch?",
    applies: rx(
      "\\b(fix|change|edit|update|modify|refactor|rewrite|redesign|clean|optimi[sz]e|improve|add to|remove from|integrate|wire|bug|issue|error)\\b",
    ),
    cues: rx(
      "\\b(file|module|class|function|component|path|directory|service|layer|endpoint)\\b|`[\\w./-]+`|\\w+\\.\\w+",
    ),
  },
  {
    key: "success_criteria",
    description: "external success criteria",
    question:
      "How will we verify it: tests, acceptance criteria, benchmark, or reference behavior?",
    applies: rx(
      "\\b(fix|optimi[sz]e|make it (faster|work|better)|improve|ensure|feature|behavior)\\b",
    ),
    // \btest: an unanchored "test" matched "latest"/"contest" and marked criteria as present.
    cues: rx(
      "(->|=>|\\btest|passes|acceptance|criteria|expected|should return|should equal|should match|verify|assert|benchmark|correct when|e\\.g\\.|example|```)",
    ),
  },
  {
    key: "constraints",
    description: "hard constraints",
    question:
      "What constraints must be respected: performance, dependencies, style, or compatibility?",
    // \w* because users type "scalable"/"concurrent"/"migration" — a bare "scal\b"
    // alternative never matched anything (review-verified dead branch). auth/payment
    // are here because money- and identity-touching work implies constraints.
    applies: rx(
      "\\b(design|architect|production|scal\\w*|migrat\\w*|distribut\\w*|concurren\\w*|refactor|authenticat\\w*|authoriz\\w*|payment|billing)\\b",
    ),
    cues: rx(
      "\\b(must|should|constraint|limit|no new dependenc|only use|standard library|without|performance|latency|O\\(|backward|compatib|convention|style)\\b",
    ),
  },
];

const VAGUE = rx(
  "\\b(some|somehow|etc|and so on|things?|stuff|appropriate(ly)?|as needed|handle (it|everything)|make it (work|better|nice|good)|clean it up|cleaner|the usual|standard way|properly|correctly|the way we (discussed|talked)|like before|as before)\\b",
);
// Concrete anchors. Scanned with URLs and markdown links removed (stripUrls), because an
// address is not a specification: a URL's host read as a filename and its port as a worked
// example. A named code identifier is one more anchor (countAnchors).
const ANCHORS = [
  /```/,
  /->|=>/,
  /\b\w+\([^)]*\)/,
  // A quoted literal. The opening quote may not follow a letter and the closing one may not
  // precede one, so contractions ("don't break it, it's") are not literals.
  /(?<![\w'])'[^'\n]+'(?![\w'])|"[^"\n]+"/,
  // A filename: a stem of 2+ chars and a letter-initial extension, so a version ("v2.3") or an
  // abbreviation ("e.g.") is not one.
  /\b[\w-]{2,}\.[A-Za-z][A-Za-z0-9]{0,4}\b/,
  // A worked value: a number beside an arrow or (in)equality, a `key: 42`-style value, or a
  // numeric call argument — not any number followed anywhere later by a colon ("since v2.3:").
  /\b\d+(?:\.\d+)?\s*(?:->|=>|==?)\s*\S|[\w)\]]\s*(?:->|=>|==?|:)\s*-?\d+(?:\.\d+)?\b|\(\d/,
  // "e.g." / "example:" end in punctuation, so a trailing \b made them unmatchable before a space.
  /\be\.g\.|\bfor example\b|\bsuch as\b|\bexample:/i,
];
const SPECIFIC =
  /\b(python|javascript|typescript|java|rust|golang|react|django|flask|node|redis|sql|postgres|asyncio|dijkstra|lru|adjacency|owasp|regex)\b|token-?bucket|binary heap|condition[- ]variable|recursive-?descent|in-?order|standard library|o\(\s*\d|o\(n|o\(1/gi;

const isCodeIdent = (p, backticked) => {
  if (!p || p.length < 2) return false;
  if (STOP.has(p.toLowerCase())) return false;
  if (backticked) return /^[A-Za-z_$][\w$]*$/.test(p);
  return (
    /[a-z][A-Z]/.test(p) || (p.includes("_") && /[a-z]/i.test(p)) || /^[A-Z][a-z]+[A-Z]/.test(p)
  );
};

// Any scheme://… URL (http, amqp, postgres, …) and bare www. hosts.
const URL_RX = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]"'`]+|\bwww\.[^\s<>()[\]"'`]+/gi;

/**
 * Remove addresses from task text before scanning it: markdown images entirely, markdown links
 * down to their text, and bare URLs. A URL is not a code reference — its path read as a file
 * ("example.com/issue/12"), its host as a filename anchor, its port as a worked example.
 * @param {string} text
 */
export function stripUrls(text) {
  return String(text)
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(URL_RX, " ");
}

// Fenced code blocks (``` or ~~~, closed or running to the end). Removed before the INLINE
// code scan: a single-backtick pairing would otherwise match a fence's third backtick with the
// next backtick and turn every word of the block ("for", "in", "return") into an identifier.
const FENCE_RX = /(```|~~~)[\s\S]*?(?:\1|$)/g;
// Inline code: a run of N backticks closed by a run of the same length on the same line, so
// RST/markdown ``double`` spans don't pair their inner backticks across the prose between them.
const INLINE_CODE_RX = /(`+)([^`\n]+)\1(?!`)/g;

// A host as the first path segment ("github.com/org/repo") means an address, not a path.
const HOST_RX = /^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}$/i;

/** Does a slash- or extension-bearing token name a file? Backticked tokens are trusted as paths
 *  (the author marked them as code); a bare one must look like a path — a file extension, a
 *  ./ ../ ~/ or / prefix, or a trailing / — so "N/A", "and/or", "input/output" are not files. */
function isFileRef(tok, backticked) {
  if (!/[A-Za-z0-9]/.test(tok)) return false;
  if (tok.includes("/")) {
    const segs = tok.split("/");
    if (HOST_RX.test(segs[0])) return false;
    if (backticked || CODE_EXT.test(tok)) return true;
    return (
      /\.[A-Za-z0-9]{1,8}$/.test(segs[segs.length - 1]) ||
      /^(?:\.{1,2}|~)?\//.test(tok) ||
      tok.endsWith("/")
    );
  }
  return CODE_EXT.test(tok);
}

export function referencedEntities(text) {
  const s = stripUrls(text);
  const symbols = new Set();
  const files = new Set();
  const consider = (raw, backticked) => {
    const tok = raw
      .trim()
      .replace(/\(\)$/, "")
      .replace(/[.,;:]+$/, "");
    if (!tok) return;
    if (tok.includes("/") || CODE_EXT.test(tok)) {
      if (isFileRef(tok, backticked)) files.add(tok);
      return;
    }
    for (const part of tok.split(".").filter(Boolean)) {
      if (isCodeIdent(part, backticked)) symbols.add(part);
    }
  };
  for (const m of s.replace(FENCE_RX, " ").matchAll(INLINE_CODE_RX))
    for (const t of m[2].split(/\s+/)) consider(t, true);
  // A bare token may carry a ./ ../ ~/ or / prefix — that prefix is what marks it as a path
  // (but not the "/" of an HTML closing tag like </summary>, nor one glued to a word).
  for (const m of s.matchAll(/(?:\.{1,2}\/|~\/|(?<![<\w])\/)?[A-Za-z_$][\w$./-]*/g)) {
    const t = m[0];
    if (t.includes("/") || CODE_EXT.test(t) || /[a-z][A-Z]/.test(t) || t.includes("_"))
      consider(t, false);
  }
  return { symbols: [...symbols], files: [...files] };
}

const AMBIGUITY = [
  /\bsome(how|thing)?\b/i,
  /\betc\.?\b/i,
  /\band so on\b/i,
  /\bas needed\b/i,
  /\bappropriate(ly)?\b/i,
  /\bproper(ly)?\b/i,
  /\ba few\b/i,
  /\bseveral\b/i,
  /\bmake it work\b/i,
  /\bhandle (the )?errors?\b/i,
  /\bvarious\b/i,
  /\band more\b/i,
];

export function ambiguityMarkers(text) {
  const out = [];
  for (const re of AMBIGUITY) {
    const m = String(text).match(re);
    if (m) out.push(m[0].trim().toLowerCase());
  }
  return [...new Set(out)];
}

// M2 completeness model — a logistic (log-odds) specification completeness heuristic score s(x),
// replacing the older additive scorer whose magic coefficients + discontinuous word-count steps
// the audit flagged as "graded-but-uncalibrated". Each feature contributes a signed amount to the
// log-odds and the sigmoid maps the sum to [0,1] — so the estimate is smooth (no step jumps),
// self-bounding (no ad-hoc clamp), and every feature's pull stays attributable (transparent rubric,
// the substrate's core commitment). Weights are a documented PRIOR calibrated so the paper's own
// examples land where they should (a bare "make the auth better" ≈ 0.23 → ask; a concrete
// "Change verifyToken … length > 20; update tests" ≈ 0.63 → proceed); a labeled task bank could
// refine them via predictor.js's trainLogistic without changing this call site.
export const COMPLETENESS_WEIGHTS = {
  bias: -0.858,
  concreteness: 1.44, // each concrete anchor (example, call signature, quoted literal, filename)
  specifics: 0.5, // each named technology/algorithm — real information even in prose
  vagueness: -1.3, // each vague filler that forces the agent to interpret — strong negative
  length: 0.6, // continuous length signal in [-1,1]; replaces the old ≥22/≥30-word steps
};

/**
 * Extract the completeness feature vector from a task string. Pure and exported so the estimate
 * is inspectable and a completeness bank could be fit against it.
 * @param {string} task
 */
export function completenessFeatures(task) {
  const raw = String(task || "");
  const words = raw.trim().split(/\s+/).filter(Boolean).length;
  const t = stripUrls(raw);
  return {
    words,
    concreteness: countAnchors(t),
    specifics: new Set([...t.matchAll(SPECIFIC)].map((m) => m[0].toLowerCase())).size,
    vagueness: new Set(
      [...t.matchAll(new RegExp(VAGUE.source, "gi"))].map((m) => m[0].toLowerCase()),
    ).size,
    // smooth, bounded length evidence: ~12-word tasks are neutral, shorter pulls down, longer up,
    // with no threshold jumps — tanh saturates so a wall of text can't dominate the verdict.
    length: Math.tanh((words - 12) / 12),
  };
}

/**
 * Specification completeness heuristic score s(x) ∈ (0,1) — a logistic over the feature
 * vector. It is a calibrated heuristic that reframes how completely a task is specified;
 * it is NOT a probability that the task is sufficiently specified, and carries no
 * empirical guarantee. Only the numeric scale is [0,1].
 */
export function completenessScore(features, weights = COMPLETENESS_WEIGHTS) {
  const z =
    weights.bias +
    weights.concreteness * features.concreteness +
    weights.specifics * features.specifics +
    weights.vagueness * features.vagueness +
    weights.length * features.length;
  return sigmoid(z);
}

/** Concrete anchors in (URL-stripped) text: each ANCHORS kind that fires, plus one when the task
 *  names a code identifier ("Rename getUser to fetchUser" is concrete, not underspecified). */
function countAnchors(text) {
  return (
    ANCHORS.filter((a) => a.test(text)).length + (referencedEntities(text).symbols.length ? 1 : 0)
  );
}

export function assessTask(text, { askThreshold = 0.6 } = {}) {
  const raw = String(text || "");
  const words = raw.trim().split(/\s+/).filter(Boolean).length;
  // Every feature below scans the task with its URLs/links removed (stripUrls).
  const task = stripUrls(raw);
  const concreteness = countAnchors(task);
  const specifics = [...new Set([...task.matchAll(SPECIFIC)].map((m) => m[0].toLowerCase()))];
  const vagueHits = [
    ...new Set([...task.matchAll(new RegExp(VAGUE.source, "gi"))].map((m) => m[0].toLowerCase())),
  ];
  const completeness = completenessScore({
    words,
    concreteness,
    specifics: specifics.length,
    vagueness: vagueHits.length,
    length: Math.tanh((words - 12) / 12),
  });
  const reasons = [];
  if (words <= 7) reasons.push("very short request");
  if (words >= 22) reasons.push(`detailed request (${words} words)`);
  if (concreteness) reasons.push(`${concreteness} concrete anchor(s)`);
  if (specifics.length) reasons.push(`${specifics.length} named technical specific(s)`);
  if (vagueHits.length) reasons.push(`${vagueHits.length} vague filler(s)`);

  const missing = [];
  const questions = [];
  for (const d of DIMENSIONS) {
    if (d.applies.test(task) && !d.cues.test(task)) {
      missing.push({ key: d.key, description: d.description });
      questions.push(d.question);
    }
  }
  const hardUnderspecified =
    concreteness === 0 && (words <= 10 || (vagueHits.length >= 1 && specifics.length === 0));
  const shouldAsk = completeness < askThreshold || hardUnderspecified;
  if (hardUnderspecified && !reasons.includes("very short request"))
    reasons.push("no concrete anchor to act on");
  const risk = completeness < 0.45 ? "high" : completeness < 0.7 ? "medium" : "low";
  return {
    completeness,
    risk,
    shouldAsk,
    hardUnderspecified,
    missing,
    questions: (shouldAsk && !questions.length
      ? ["What exactly should this produce, and how will we know it is correct?"]
      : questions
    ).slice(0, 3),
    reasons,
  };
}

// M2 assumption gate — LLM proposer. Scores the paper's s(x) completeness functional over the
// same four dimensions the rubric names, and may add clarifying questions. PROPOSER ONLY:
// reconcileAssumption() bounds it against the deterministic score and grounds every question.
const DIM_KEYS = DIMENSIONS.map((d) => d.key);

export function buildAssumptionPrompt(task) {
  return `A coding agent received this task. Judge how completely it is specified BEFORE any code is written.
Task: """${String(task).slice(0, 1200)}"""
Score specification completeness in [0,1] over these dimensions: inputs_outputs, target_scope,
success_criteria, constraints. List the concrete missing-information questions a careful engineer
would ask first. Respond with STRICT JSON and nothing else:
{"completeness":<0..1>,"missing":["<dimension name>"...],"questions":["<question>"...]}
Do not echo credentials or personal data. No text outside the JSON object.`;
}

export function parseAssumptionProposal(obj) {
  const completeness = asUnit(obj.completeness);
  if (completeness == null) return null;
  const missing = Array.isArray(obj.missing)
    ? obj.missing.map((m) => asText(m, 40)).filter((m) => DIM_KEYS.includes(m))
    : [];
  const questions = Array.isArray(obj.questions)
    ? [...new Set(obj.questions.map((q) => asText(q, 200)).filter(Boolean))].slice(0, 5)
    : [];
  return { completeness, missing, questions };
}

/** Ask the model for an assumption reading (proposer). Returns null when off/unavailable. */
export function assessTaskLLM(task, { run = buildRunner() } = {}) {
  return adjudicate({
    prompt: buildAssumptionPrompt(task),
    parse: parseAssumptionProposal,
    run,
  });
}

/** The assumption gate as batched Jev nouls — one per rubric dimension, one API call. */
export function buildAssumptionNouls(task) {
  const questions = {};
  for (const d of DIMENSIONS) {
    questions[d.key] = noul(
      `A coding agent received this task. Is "${d.key}" — ${d.description} — specified concretely enough to start coding?`,
      {
        true: `The ${d.description} is concrete and actionable`,
        false: `The ${d.description} is missing, vague, or left to be assumed`,
      },
    );
  }
  return { state: String(task).slice(0, 1200), questions };
}

/**
 * Ask Jev (TypeSafe System One) for an assumption reading: one batched call scoring every
 * rubric dimension as a yes/no probability. `completeness` is their mean; a dimension is
 * `missing` when its noul lands below 0.5 (more-likely-unspecified — the noul's own
 * semantics, no new threshold constant). Free-text clarifying questions are beyond a
 * System One model, so `questions` stays empty and the deterministic rubric's questions
 * stand. Returns null when off/unavailable.
 * @param {string} task
 * @param {object} [opts]
 * @param {boolean} [opts.llm]
 * @param {(payload:object)=>object} [opts.call] injectable Jev transport (tests)
 */
export function assessTaskJev(task, { llm, call } = {}) {
  if (!jevEnabled({ llm })) return null;
  const { state, questions } = buildAssumptionNouls(task);
  const res = systemOne({ state, questions, call });
  if (!res) return null;
  const values = [];
  for (const k of DIM_KEYS) {
    const v = res.answers?.[k]?.noul;
    if (typeof v !== "number") return null;
    values.push(v);
  }
  const completeness = values.reduce((s, v) => s + v, 0) / values.length;
  const missing = DIM_KEYS.filter((_, i) => values[i] < 0.5);
  return { completeness, missing, questions: [], provider: "jev" };
}

/**
 * Minimum probability a proposer must put on its OWN verdict (ask vs proceed) before it may flip
 * the rubric's. An a-priori conservative default, NOT fit to any data: the right value has to be
 * chosen on fresh labelled tasks (the frozen held-out set is spent). Configurable per call and via
 * `llm.minConfidence` in source/substrate.json (0 disables the gate).
 */
export const GATE_MIN_CONFIDENCE = 0.8;

/**
 * Verify-don't-trust reconcile for M2, band to band. The rubric's completeness and a proposer's
 * are on different scales — the rubric's logistic saturates on real issues (median ≈ 0.98) while a
 * proposer's reading is a probability that the task is specified, centred on 0.5 — so each is
 * judged against its OWN threshold and only the two verdicts are compared (the old ±band clamp of
 * one onto the other pinned the proposer to the edge of the band and left it no say). When they
 * disagree, the proposer's verdict wins only if it holds it with probability ≥ `minConfidence`:
 *   - TIGHTEN (rubric proceeds, proposer asks) — always allowed; caution can only grow.
 *   - CLEAR (rubric asks, proposer proceeds) — only in `bidirectional` mode, and never past two
 *     floors: a task with no concrete anchor (`hardUnderspecified`), or one naming symbols/files
 *     the repo doesn't define (`hasUnresolved`). The floors guard clearing ONLY — they never force
 *     an ask the rubric didn't raise (a rename's new name is unresolved by definition).
 * The reported `completeness`/`risk` stay the rubric's; the proposer's reading rides along in
 * provenance. Extra questions survive only if they map to a rubric-flagged dimension or (via
 * `grounded`) reference a real repo entity.
 * @param {object} det - assessTask() result
 * @param {{completeness:number, missing:string[], questions:string[], provider?:string}|null} proposal
 * @param {object} [opts]
 * @param {(q:string)=>boolean} [opts.grounded]
 * @param {boolean} [opts.bidirectional]
 * @param {boolean} [opts.hasUnresolved]
 * @param {number} [opts.minConfidence]
 */
export function reconcileAssumption(
  det,
  proposal,
  {
    grounded = () => false,
    bidirectional = true,
    hasUnresolved = false,
    minConfidence = GATE_MIN_CONFIDENCE,
  } = {},
) {
  if (!proposal) return { ...det, provenance: { path: "deterministic" } };
  const p = proposal.completeness; // P(specified) on the proposer's own scale
  const modelAsk = p < 0.5;
  const confidence = modelAsk ? 1 - p : p;
  const flaggedDims = new Set(det.missing.map((m) => m.key));
  const extraQuestions = proposal.questions.filter(
    (q) => proposal.missing.some((m) => flaggedDims.has(m)) || grounded(q),
  );
  const questions = [...new Set([...det.questions, ...extraQuestions])].slice(0, 3);
  let shouldAsk = det.shouldAsk;
  let overruledBy = null;
  if (modelAsk !== det.shouldAsk) {
    if (minConfidence > 0 && confidence < minConfidence) overruledBy = "confidence";
    else if (modelAsk) shouldAsk = true;
    else if (!bidirectional) overruledBy = "bidirectional-off";
    else if (det.hardUnderspecified) overruledBy = "no-anchor";
    else if (hasUnresolved) overruledBy = "unresolved-entities";
    else shouldAsk = false;
  }
  let path;
  if (shouldAsk && !det.shouldAsk) path = "llm-tightened";
  else if (!shouldAsk && det.shouldAsk) path = "llm-cleared";
  else if (overruledBy) path = "llm-overruled";
  else path = questions.length !== det.questions.length ? "llm-verified" : "llm-agreed";
  return {
    ...det,
    shouldAsk,
    questions:
      shouldAsk && !questions.length
        ? ["What exactly should this produce, and how will we know it is correct?"]
        : questions,
    provenance: {
      path,
      detCompleteness: det.completeness,
      proposalCompleteness: p,
      ...(overruledBy ? { overruledBy } : {}),
      ...(proposal.provider ? { provider: proposal.provider } : {}),
    },
  };
}

export function informationGap(text, deps = {}) {
  const { hasSymbol = () => false, fileExists = () => false } = deps;
  const { symbols, files } = referencedEntities(text);
  const ambiguous = ambiguityMarkers(text);
  const unresolvedSymbols = symbols.filter((s) => !hasSymbol(s));
  const unresolvedFiles = files.filter((f) => !fileExists(f));
  const problems = unresolvedSymbols.length + unresolvedFiles.length + ambiguous.length;
  const denom = symbols.length + files.length + ambiguous.length;
  const gap = denom === 0 ? 0 : Math.min(1, problems / denom);
  return {
    gap,
    unresolved: { symbols: unresolvedSymbols, files: unresolvedFiles },
    ambiguous,
    entities: { symbols, files },
  };
}

export function clarifyBlock(result, { threshold = 0.5 } = {}) {
  const nRef = result.unresolved.symbols.length + result.unresolved.files.length;
  const assumption = result.assumption;
  if (nRef === 0 && result.gap < threshold && !assumption?.shouldAsk) return "";
  const lines = [
    "## Before starting — clarify (Forge Preflight)",
    "This task has unknowns that would otherwise become assumptions:",
    "",
  ];
  for (const s of result.unresolved.symbols)
    lines.push(`- \`${s}\` — not found in the code. Different name, or should it be created?`);
  for (const f of result.unresolved.files)
    lines.push(`- \`${f}\` — file not found. Confirm the path, or that it is new.`);
  if (result.ambiguous.length)
    lines.push(
      `- Ambiguous: ${result.ambiguous.map((a) => `"${a}"`).join(", ")} — state concrete acceptance criteria.`,
    );
  if (assumption?.shouldAsk) for (const q of assumption.questions) lines.push(`- ${q}`);
  lines.push("", "_Advisory: ask rather than assume._");
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.allowBuild]
 * @param {number} [opts.askThreshold]
 * @param {boolean} [opts.llm]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {(p:string)=>string} [opts.run]
 * @param {(payload:object)=>object} [opts.jevCall] injectable Jev transport (tests)
 * @param {boolean} [opts.bidirectional]
 * @param {number} [opts.minConfidence] probability a proposer needs on its verdict to flip the rubric's
 */
export function preflightRepo(
  root,
  text,
  {
    allowBuild = true,
    askThreshold = 0.6,
    llm,
    model,
    timeoutMs,
    run,
    jevCall,
    bidirectional = true,
    minConfidence,
  } = {},
) {
  const atlas = loadAtlas(root) || (allowBuild ? buildAtlas({ root }) : null);
  // When the graph is capped (files were dropped) we can't be sure a symbol is truly absent, so
  // treat everything as resolvable rather than raising false "not found in the code" clarifications.
  const hasSymbol = atlas && !atlas.capped ? (name) => has(atlas, name) : () => true;
  const gap = informationGap(text, {
    hasSymbol,
    fileExists: (f) => existsSync(join(root, f)),
  });
  const det = assessTask(text, { askThreshold });
  // M2 proposer: only when opted in. The rubric is the external judge; the model refines it
  // within bounds and can add grounded questions. Fail-safe: null proposal keeps `det`.
  if (!llmEnabled({ llm }))
    return {
      ...gap,
      assumption: { ...det, provenance: { path: "deterministic" } },
    };
  const proposal =
    assessTaskJev(text, { llm, call: jevCall }) ??
    assessTaskLLM(text, {
      run: run || buildRunner({ model, timeoutMs }),
    });
  const grounded = (q) => {
    const { symbols, files } = referencedEntities(q);
    return symbols.some(hasSymbol) || files.some((f) => existsSync(join(root, f)));
  };
  // Repo grounding is a hard floor on CLEARING: if the task names entities the repo lacks, the
  // model can never wave a rubric ask through no matter how "complete" it judges the prose. It is
  // not a reason to ask by itself — the rubric already weighed the task without it.
  const hasUnresolved = gap.unresolved.symbols.length + gap.unresolved.files.length > 0;
  return {
    ...gap,
    assumption: reconcileAssumption(det, proposal, {
      grounded,
      bidirectional,
      hasUnresolved,
      ...(typeof minConfidence === "number" ? { minConfidence } : {}),
    }),
  };
}
