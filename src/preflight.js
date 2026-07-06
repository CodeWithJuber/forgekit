// forge preflight — the assumption detector. Before the agent spends a token, scan the task
// for code identifiers/files it NAMES but the repo doesn't DEFINE — those are the things it
// will silently ASSUME. The richer assumption gate also scores specification completeness.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { adjudicate, asText, asUnit, buildRunner, llmEnabled } from "./adjudicate.js";
import { build as buildAtlas, has, load as loadAtlas } from "./atlas.js";

const CODE_EXT =
  /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|json|ya?ml|toml|md|css|scss|html|vue|svelte)$/i;

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
      "\\b(fix|change|edit|update|modify|refactor|add to|remove from|integrate|wire|bug|issue|error)\\b",
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
    cues: rx(
      "(->|=>|test|passes|acceptance|criteria|expected|should return|should equal|should match|verify|assert|benchmark|correct when|e\\.g\\.|example|```)",
    ),
  },
  {
    key: "constraints",
    description: "hard constraints",
    question:
      "What constraints must be respected: performance, dependencies, style, or compatibility?",
    applies: rx("\\b(design|architect|production|scal|migrate|distributed|concurren|refactor)\\b"),
    cues: rx(
      "\\b(must|should|constraint|limit|no new dependenc|only use|standard library|without|performance|latency|O\\(|backward|compatib|convention|style)\\b",
    ),
  },
];

const VAGUE = rx(
  "\\b(some|somehow|etc|and so on|things?|stuff|appropriate(ly)?|as needed|handle (it|everything)|make it (work|better|nice|good)|clean it up|cleaner|the usual|standard way|properly|correctly|the way we (discussed|talked)|like before|as before)\\b",
);
const ANCHORS = [
  /```/,
  /->|=>/,
  /\b\w+\([^)]*\)/,
  /'[^']+'|"[^"]+"/,
  /\b\w+\.\w{1,5}\b/,
  /\b\d+\b.*(->|=>|=|:)|\(\d/,
  /\b(e\.g\.|for example|such as|example:)\b/i,
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

export function referencedEntities(text) {
  const s = String(text);
  const symbols = new Set();
  const files = new Set();
  const consider = (raw, backticked) => {
    const tok = raw
      .trim()
      .replace(/\(\)$/, "")
      .replace(/[.,;:]+$/, "");
    if (!tok) return;
    if (tok.includes("/") || CODE_EXT.test(tok)) {
      files.add(tok);
      return;
    }
    for (const part of tok.split(".").filter(Boolean)) {
      if (isCodeIdent(part, backticked)) symbols.add(part);
    }
  };
  for (const m of s.matchAll(/`([^`]+)`/g)) for (const t of m[1].split(/\s+/)) consider(t, true);
  for (const m of s.matchAll(/[A-Za-z_$][\w$./-]*/g)) {
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

export function assessTask(text, { askThreshold = 0.6 } = {}) {
  const task = String(text || "");
  const words = task.trim().split(/\s+/).filter(Boolean).length;
  const concreteness = ANCHORS.filter((a) => a.test(task)).length;
  const specifics = [...new Set([...task.matchAll(SPECIFIC)].map((m) => m[0].toLowerCase()))];
  const vagueHits = [
    ...new Set([...task.matchAll(new RegExp(VAGUE.source, "gi"))].map((m) => m[0].toLowerCase())),
  ];
  const reasons = [];
  let score =
    0.45 +
    Math.min(0.45, 0.18 * concreteness) +
    Math.min(0.2, 0.06 * specifics.length) -
    0.22 * vagueHits.length;
  if (words <= 7) {
    score -= 0.22;
    reasons.push("very short request");
  }
  if (words >= 30 && specifics.length >= 2) {
    score += 0.2;
    reasons.push(`long detailed spec (${words} words)`);
  } else if (words >= 22 && specifics.length >= 1) {
    score += 0.1;
    reasons.push(`detailed spec (${words} words)`);
  }
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
  const completeness = Math.max(0, Math.min(1, score));
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
  return adjudicate({ prompt: buildAssumptionPrompt(task), parse: parseAssumptionProposal, run });
}

/**
 * Verify-don't-trust reconcile for M2. The model may only move completeness within ±band of the
 * deterministic score, so a clearly-specified or clearly-vague task can never be flipped — only a
 * borderline reading shifts. In `bidirectional` mode (default) the ask is recomputed purely from
 * that bounded completeness, so a verified reading can also CLEAR a false ask — but two hard
 * floors the model can never override still force the ask: a task with no concrete anchor
 * (`hardUnderspecified`), or one naming symbols/files the repo doesn't define (`hasUnresolved`).
 * With `bidirectional:false` the gate only ever tightens (the conservative pre-bidirectional
 * behaviour). Extra questions survive only if they map to a rubric-flagged dimension or (via
 * `grounded`) reference a real repo entity.
 * @param {object} det - assessTask() result
 * @param {{completeness:number, missing:string[], questions:string[]}|null} proposal
 * @param {object} [opts]
 * @param {number} [opts.askThreshold]
 * @param {number} [opts.band]
 * @param {(q:string)=>boolean} [opts.grounded]
 * @param {boolean} [opts.bidirectional]
 * @param {boolean} [opts.hasUnresolved]
 */
export function reconcileAssumption(
  det,
  proposal,
  {
    askThreshold = 0.6,
    band = 0.25,
    grounded = () => false,
    bidirectional = true,
    hasUnresolved = false,
  } = {},
) {
  if (!proposal) return { ...det, provenance: { path: "deterministic" } };
  const bounded = Math.max(
    det.completeness - band,
    Math.min(det.completeness + band, proposal.completeness),
  );
  const completeness = Math.max(0, Math.min(1, bounded));
  const flaggedDims = new Set(det.missing.map((m) => m.key));
  const extraQuestions = proposal.questions.filter(
    (q) => proposal.missing.some((m) => flaggedDims.has(m)) || grounded(q),
  );
  const questions = [...new Set([...det.questions, ...extraQuestions])].slice(0, 3);
  // Bidirectional (default): the ask follows the bounded completeness, guarded by two floors the
  // model can't override. Tighten-only: the rubric's ask always stands, the model can only add one.
  const shouldAsk = bidirectional
    ? det.hardUnderspecified || hasUnresolved || completeness < askThreshold
    : det.shouldAsk || det.hardUnderspecified || completeness < askThreshold;
  const risk = completeness < 0.45 ? "high" : completeness < 0.7 ? "medium" : "low";
  const moved =
    Math.abs(completeness - det.completeness) > 1e-9 || questions.length !== det.questions.length;
  let path;
  if (shouldAsk && !det.shouldAsk) path = "llm-tightened";
  else if (!shouldAsk && det.shouldAsk) path = "llm-cleared";
  else path = moved ? "llm-verified" : "llm-agreed";
  return {
    ...det,
    completeness,
    risk,
    shouldAsk,
    questions:
      shouldAsk && !questions.length
        ? ["What exactly should this produce, and how will we know it is correct?"]
        : questions,
    provenance: { path, detCompleteness: det.completeness },
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
 * @param {boolean} [opts.bidirectional]
 * @param {number} [opts.band]
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
    bidirectional = true,
    band,
  } = {},
) {
  const atlas = loadAtlas(root) || (allowBuild ? buildAtlas({ root }) : null);
  const hasSymbol = atlas ? (name) => has(atlas, name) : () => true;
  const gap = informationGap(text, {
    hasSymbol,
    fileExists: (f) => existsSync(join(root, f)),
  });
  const det = assessTask(text, { askThreshold });
  // M2 proposer: only when opted in. The rubric is the external judge; the model refines it
  // within bounds and can add grounded questions. Fail-safe: null proposal keeps `det`.
  if (!llmEnabled({ llm }))
    return { ...gap, assumption: { ...det, provenance: { path: "deterministic" } } };
  const proposal = assessTaskLLM(text, { run: run || buildRunner({ model, timeoutMs }) });
  const grounded = (q) => {
    const { symbols, files } = referencedEntities(q);
    return symbols.some(hasSymbol) || files.some((f) => existsSync(join(root, f)));
  };
  // Repo grounding is a hard floor on clearing: if the task names entities the repo lacks, the
  // model can never wave the gate through no matter how "complete" it judges the prose.
  const hasUnresolved = gap.unresolved.symbols.length + gap.unresolved.files.length > 0;
  return {
    ...gap,
    assumption: reconcileAssumption(det, proposal, {
      askThreshold,
      grounded,
      bidirectional,
      hasUnresolved,
      ...(typeof band === "number" ? { band } : {}),
    }),
  };
}
