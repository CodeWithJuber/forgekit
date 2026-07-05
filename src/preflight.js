// forge preflight — the assumption detector. Before the agent spends a token, scan the task
// for code identifiers/files it NAMES but the repo doesn't DEFINE — those are the things it
// will silently ASSUME. The richer assumption gate also scores specification completeness.
import { existsSync } from "node:fs";
import { join } from "node:path";
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
    missing,
    questions: (shouldAsk && !questions.length
      ? ["What exactly should this produce, and how will we know it is correct?"]
      : questions
    ).slice(0, 3),
    reasons,
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

export function preflightRepo(root, text, { allowBuild = true, askThreshold = 0.6 } = {}) {
  const atlas = loadAtlas(root) || (allowBuild ? buildAtlas({ root }) : null);
  const gap = informationGap(text, {
    hasSymbol: atlas ? (name) => has(atlas, name) : () => true,
    fileExists: (f) => existsSync(join(root, f)),
  });
  return { ...gap, assumption: assessTask(text, { askThreshold }) };
}
