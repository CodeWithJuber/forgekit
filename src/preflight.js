// forge preflight — the assumption detector. Before the agent spends a token, scan the task
// for code identifiers/files it NAMES but the repo doesn't DEFINE — those are the things it
// can check. The prerequisite gate measures only inputs explicitly required to exist.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { adjudicate, asText, asUnit, buildRunner, llmEnabled } from "./adjudicate.js";
import { build as buildAtlas, has, load as loadAtlas } from "./atlas.js";
import { askDecision } from "./decisions.js";
import { isDialogueTurn } from "./intent.js";
import { jevEnabled, noul } from "./jev.js";
import { containsPath, physicalPath } from "./private_paths.js";
import { CODE_EXT } from "./util.js";

// Named dimensions form the opt-in provider response schema.
const DIMENSIONS = [
  { key: "inputs_outputs", description: "exact input/output behavior" },
  { key: "target_scope", description: "target file/module/component scope" },
  { key: "success_criteria", description: "external success criteria" },
  { key: "constraints", description: "hard constraints" },
];

const isCodeIdent = (p, backticked) => {
  if (!p) return false;
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
  for (const m of s.replace(FENCE_RX, " ").matchAll(INLINE_CODE_RX)) {
    const atoms = m[2].trim().split(/\s+/);
    for (const t of atoms) consider(t, atoms.length === 1);
  }
  // A bare token may carry a ./ ../ ~/ or / prefix — that prefix is what marks it as a path
  // (but not the "/" of an HTML closing tag like </summary>, nor one glued to a word).
  for (const m of s.matchAll(/(?:\.{1,2}\/|~\/|(?<![<\w])\/)?[A-Za-z_$][\w$./-]*/g)) {
    const t = m[0];
    if (t.includes("/") || CODE_EXT.test(t) || /[a-z][A-Z]/.test(t) || t.includes("_"))
      consider(t, false);
  }
  return { symbols: [...symbols], files: [...files] };
}

/**
 * Fraction of declared prerequisites observed present. Empty evidence has no score.
 * Prose alone does not identify which files a developer requires to exist before work.
 * @param {string} text
 * @param {{requirements?:Array<{path:string,present:boolean}>}} [options]
 */
export function assessTask(text, { requirements = [] } = {}) {
  const missing = requirements.filter((r) => !r.present);
  const count = requirements.length;
  const completeness = count ? (count - missing.length) / count : null;
  return {
    completeness,
    evidence: requirements,
    risk: count ? (missing.length ? "unmet" : "met") : "unknown",
    shouldAsk: missing.length > 0,
    hardUnderspecified: missing.length > 0,
    intervention: { dialogue: isDialogueTurn(text), evidence: count },
    missing: missing.map((r) => ({ key: "required_file", description: r.path })),
    questions: missing.map((r) => `Where is the required file ${JSON.stringify(r.path)}?`),
    reasons: [
      count
        ? `${count - missing.length} of ${count} declared files present`
        : "No explicit prerequisites to measure",
    ],
  };
}

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
 * @param {string} [opts.root]
 * @param {(payload:object)=>object} [opts.call] injectable Jev transport (tests)
 */
export function assessTaskJev(task, { llm, root, call } = {}) {
  const { state, questions } = buildAssumptionNouls(task);
  const res = askDecision({ root, llm, state, questions, call });
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
 * Provider readings remain advisory unless a caller sets a confidence threshold.
 * A provider cannot waive a missing, explicitly declared prerequisite.
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
  { grounded = () => false, bidirectional = true, hasUnresolved = false, minConfidence } = {},
) {
  if (!proposal) return { ...det, provenance: { path: "deterministic" } };
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)
    return {
      ...det,
      provenance: {
        path: "llm-advisory",
        proposalCompleteness: proposal.completeness,
        questions: proposal.questions.filter(grounded),
        ...(proposal.provider ? { provider: proposal.provider } : {}),
      },
    };
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
    else if (det.hardUnderspecified) overruledBy = "missing-requirement";
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
  const { hasSymbol = () => null, fileExists = () => null } = deps;
  const entities = referencedEntities(text);
  function inspect(names, lookup) {
    const missing = [],
      unknown = [];
    for (const name of names) {
      const found = lookup(name);
      if (found === false) missing.push(name);
      else if (found !== true) unknown.push(name);
    }
    return { missing, unknown, checked: names.length - unknown.length };
  }
  const symbols = inspect(entities.symbols, hasSymbol);
  const files = inspect(entities.files, fileExists);
  const checked = symbols.checked + files.checked;
  const named = entities.symbols.length + entities.files.length;
  return {
    gap: checked ? (symbols.missing.length + files.missing.length) / checked : named ? null : 0,
    checked,
    unresolved: { symbols: symbols.missing, files: files.missing },
    unknown: { symbols: symbols.unknown, files: files.unknown },
    ambiguous: [],
    entities,
  };
}

export function clarifyBlock(result) {
  const nRef = result.unresolved.symbols.length + result.unresolved.files.length;
  const assumption = result.assumption;
  if (!nRef && !assumption?.shouldAsk) return "";
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

/** Explicit CLI and MCP queries report coverage even when the ambient gate has
 * no reason to interrupt a user. Only a lookup that ran can ground a reference. */
export function preflightReport(result) {
  const sections = [clarifyBlock(result)].filter(Boolean);
  const { symbols, files } = result.unknown;
  if (symbols.length || files.length) {
    const { indexCoverage } = result;
    if (symbols.length && indexCoverage.status === "partial")
      sections.push(
        `Partial repository index (${indexCoverage.indexedFiles} files indexed, ${indexCoverage.skippedFiles} omitted).`,
      );
    if (symbols.length && indexCoverage.status === "unavailable")
      sections.push("The repository index is unavailable.");
    if (symbols.length) sections.push(`Unchecked symbols: ${symbols.join(", ")}.`);
    if (files.length) sections.push(`Unchecked paths: ${files.join(", ")}.`);
  }
  if (sections.length) return sections.join("\n");
  return result.checked
    ? "All clear — the preflight check resolved every named reference."
    : "The task contains no named code references to check.";
}

/**
 * @param {string} root
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.allowBuild]
 * @param {string[]} [opts.requiredFiles]
 * @param {boolean} [opts.llm]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {(p:string)=>string} [opts.run]
 * @param {(payload:object)=>object} [opts.jevCall] injectable Jev transport (tests)
 * @param {boolean} [opts.bidirectional]
 * @param {number} [opts.minConfidence] optional operator threshold for a provider suggestion
 */
export function preflightRepo(
  root,
  text,
  {
    allowBuild = true,
    requiredFiles = [],
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
  // Missing or incomplete index coverage yields an unknown symbol observation.
  const hasSymbol = (name) => {
    if (atlas && has(atlas, name)) return true;
    return atlas && !atlas.capped ? false : null;
  };
  const indexCoverage = {
    status: !atlas ? "unavailable" : atlas.capped ? "partial" : "available",
    indexedFiles: atlas ? atlas.files - (atlas.omitted?.length ?? 0) : null,
    skippedFiles: atlas ? (atlas.skippedFiles ?? 0) : null,
  };
  const workspace = physicalPath(root);
  const fileExists = (file, regular = false) => {
    if (typeof file !== "string" || !file.trim() || /\p{Cc}/u.test(file)) return false;
    try {
      const target = resolve(root, file);
      if (!containsPath(resolve(root), target) || !containsPath(workspace, physicalPath(target)))
        return false;
      const st = statSync(target, { throwIfNoEntry: false });
      return regular ? !!st?.isFile() : !!st;
    } catch (error) {
      if (["ENOTDIR", "ENOENT", "EACCES", "EPERM", "ELOOP"].includes(error.code)) return false;
      throw error;
    }
  };
  const gap = informationGap(text, {
    hasSymbol,
    fileExists,
  });
  const requirements = [...new Set(requiredFiles)].map((path) => ({
    path,
    present: fileExists(path, true),
  }));
  const det = assessTask(text, { requirements });
  // M2 proposer: only when opted in. The rubric is the external judge; the model refines it
  // within bounds and can add grounded questions. Fail-safe: null proposal keeps `det`.
  if (
    (det.intervention.dialogue && !requirements.length) ||
    (!llmEnabled({ llm }) && !jevEnabled({ root, llm }))
  )
    return {
      ...gap,
      indexCoverage,
      assumption: { ...det, provenance: { path: "deterministic" } },
    };
  const proposal =
    assessTaskJev(text, { root, llm, call: jevCall }) ??
    (llmEnabled({ llm })
      ? assessTaskLLM(text, { run: run || buildRunner({ model, timeoutMs }) })
      : null);
  const grounded = (q) => {
    const { symbols, files } = referencedEntities(q);
    return symbols.some(hasSymbol) || files.some((f) => fileExists(f));
  };
  // Repo grounding is a hard floor on CLEARING: if the task names entities the repo lacks, the
  // model can never wave a rubric ask through no matter how "complete" it judges the prose. It is
  // not a reason to ask by itself — the rubric already weighed the task without it.
  const hasUnresolved = gap.unresolved.symbols.length + gap.unresolved.files.length > 0;
  return {
    ...gap,
    indexCoverage,
    assumption: reconcileAssumption(det, proposal, {
      grounded,
      bidirectional,
      hasUnresolved,
      ...(typeof minConfidence === "number" ? { minConfidence } : {}),
    }),
  };
}
