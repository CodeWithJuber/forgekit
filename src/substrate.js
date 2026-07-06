// forge substrate — one pre-action surface for the cognitive substrate described in
// the paper: gate assumptions, route model effort, inspect scope/impact, surface memory,
// and produce an external verification checklist. Deterministic where possible;
// advisory where the paper marks the research edge.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunner, llmEnabled } from "./adjudicate.js";
import { goalDrift } from "./anchor.js";
import { build as buildAtlas, impact as impactGraph, load as loadAtlas } from "./atlas.js";
import { matchingLessons } from "./cortex.js";
import { load as loadLessons } from "./lessons_store.js";
import { clarifyBlock, preflightRepo, referencedEntities } from "./preflight.js";
import { routeTask } from "./route.js";
import { decompose } from "./scope.js";

function loadSubstrateSpec() {
  const path = join(dirname(dirname(fileURLToPath(import.meta.url))), "source", "substrate.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function verificationChecklist(root) {
  const checks = [];
  if (existsSync(join(root, "package.json"))) {
    checks.push("npm test");
    checks.push("npm run typecheck");
    checks.push("npm run lint");
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini")))
    checks.push("pytest -q");
  checks.push("review impacted files before editing");
  checks.push("run the narrowest affected test first, then the broader suite");
  return [...new Set(checks)];
}

function minimalityWarnings(task, route, preflight) {
  const warnings = [];
  const text = String(task).toLowerCase();
  if (
    /\b(refactor|rewrite|clean|redesign|optimi[sz]e|improve)\b/.test(text) &&
    preflight.entities.files.length === 0
  ) {
    warnings.push(
      "High-risk broad change with no target files named; ask for scope before editing.",
    );
  }
  if (route.score >= 0.55 && preflight.assumption.completeness < 0.7) {
    warnings.push(
      "Complex task with medium/low specification completeness; clarify before spending a premium model.",
    );
  }
  if (
    /\b(add authentication|payment|migration|distributed|concurrent|production)\b/.test(text) &&
    !/\btest|acceptance|rollback|constraint|must|should\b/.test(text)
  ) {
    warnings.push("Production-sensitive task lacks explicit constraints or acceptance criteria.");
  }
  return warnings;
}

// Grep-style verify for the LLM impact pass: a proposed dependent is only kept if the target
// symbol/file name actually appears in the candidate file's source. External check, not trust.
function makeImpactVerify(root) {
  const base = (t) =>
    String(t)
      .split(/[/\\]/)
      .pop()
      .replace(/\.[^.]+$/, "");
  return (file, target) => {
    try {
      const src = readFileSync(join(root, file), "utf8");
      const name = base(target);
      return name.length > 1 && new RegExp(`\\b${name.replace(/[^\w$]/g, "")}\\b`).test(src);
    } catch {
      return false;
    }
  };
}

/**
 * @param {string} root
 * @param {string} target
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {boolean} [opts.llm]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 */
export function predictImpact(root, target, { threshold = 0.1, llm, model, timeoutMs } = {}) {
  const atlas = loadAtlas(root) || buildAtlas({ root });
  const useLLM = llmEnabled({ llm });
  return impactGraph(atlas, target, {
    threshold,
    llm: useLLM,
    run: useLLM ? buildRunner({ model, timeoutMs }) : undefined,
    verify: makeImpactVerify(root),
  });
}

/**
 * @param {string} root
 * @param {string} task
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {number} [opts.askThreshold]
 * @param {boolean} [opts.allowBuild]
 * @param {boolean} [opts.llm]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.bidirectional]
 */
export function substrateCheck(
  root,
  task,
  {
    threshold = 0.1,
    askThreshold = 0.6,
    allowBuild = true,
    llm,
    model,
    timeoutMs,
    bidirectional,
  } = {},
) {
  const text = String(task || "");
  const spec = loadSubstrateSpec();
  // LLM adjudication is opt-in. On the ambient hook path (allowBuild:false) it stays OFF unless
  // FORGE_LLM_AMBIENT=1, so the per-prompt hook never pays model latency by default. An explicit
  // `llm` option always wins. Every faculty is fail-safe: a null proposal keeps the rubric.
  const useLLM =
    typeof llm === "boolean"
      ? llm
      : allowBuild
        ? llmEnabled()
        : process.env.FORGE_LLM_AMBIENT === "1";
  // Bidirectional (clear-a-false-ask / route-down, within rails) follows the JSON default unless
  // the caller overrides it. The numeric bands/floor come from the same config block.
  const bi =
    typeof bidirectional === "boolean" ? bidirectional : (spec?.llm?.bidirectional ?? true);
  const llmOpts = {
    llm: useLLM,
    model,
    timeoutMs,
    bidirectional: bi,
    band: spec?.llm?.band,
    routingBand: spec?.llm?.routingBand,
    signalFloor: spec?.llm?.signalFloor,
  };
  const entities = referencedEntities(text);
  const preflight = preflightRepo(root, text, { askThreshold, allowBuild, ...llmOpts });
  // Reuse the gap preflight already computed — routeTask would otherwise recompute it (and, with
  // FORGE_LLM on, fire a second, redundant assumption model call whose result it discards).
  const route = routeTask(root, text, { ...llmOpts, ambiguity: preflight.gap });
  // allowBuild:false (ambient hooks) uses the atlas only if one is already cached — never
  // builds or writes .forge/atlas.json from a hook. Impact is then best-effort.
  const atlas = loadAtlas(root) || (allowBuild ? buildAtlas({ root }) : null);
  const impactTargets = [...new Set([...entities.symbols, ...entities.files])].slice(0, 8);
  const impactRun = useLLM ? buildRunner({ model, timeoutMs }) : undefined;
  const impactVerify = makeImpactVerify(root);
  const impacts = atlas
    ? impactTargets.map((target) =>
        impactGraph(atlas, target, {
          threshold,
          llm: useLLM,
          run: impactRun,
          verify: impactVerify,
        }),
      )
    : [];
  const impactedFiles = [...new Set(impacts.flatMap((r) => r.impactedFiles || []))].sort();
  const scopedFiles = [...new Set([...entities.files, ...impactedFiles])];
  const scope = scopedFiles.length
    ? decompose(root, scopedFiles)
    : { clusters: [], independentGroups: 0 };
  const lessons = matchingLessons(loadLessons(root), {
    files: scopedFiles,
    symbols: entities.symbols,
  });
  const result = {
    okToProceed: !preflight.assumption.shouldAsk,
    task: text,
    assumption: preflight.assumption,
    clarify: clarifyBlock(preflight),
    route,
    entities,
    impact: { targets: impactTargets, reports: impacts, impactedFiles },
    scope,
    memory: {
      matchingLessons: lessons.length,
      advisory: lessons.slice(0, 5).map((lesson) => ({
        id: lesson.id,
        status: lesson.status,
        scope: lesson.scope,
      })),
    },
    minimality: { warnings: minimalityWarnings(text, route, preflight) },
    // M4 goal-anchoring: re-read the stated goal against files already changed this session.
    // Quiet pre-action (clean tree → no drift); speaks mid-session when work wandered off-goal.
    goalAnchor: goalDrift(root, text, llmOpts),
    verification: { checklist: verificationChecklist(root) },
    substrate: loadSubstrateSpec(),
    // Which faculties, if any, had a model proposal survive external verification this run, and
    // which direction it moved (…-cleared / …-tightened for the gate, …-raised / …-lowered for
    // routing). Every non-deterministic value was checked before it counted.
    llm: {
      enabled: useLLM,
      bidirectional: bi,
      provenance: {
        assumption: preflight.assumption.provenance?.path ?? "deterministic",
        route: route.provenance?.path ?? "deterministic",
        impact: impacts.some((r) => (r.llmVerified || []).length)
          ? "llm-verified"
          : "deterministic",
        goalAnchor: undefined, // set below once goalAnchor is in scope
      },
    },
    guarantees: {
      deterministic: [
        "assumption rubric",
        "repo symbol/file grounding",
        "model routing rubric",
        "impact graph traversal",
        "scope decomposition",
      ],
      // Proposed by a model, then checked against the repo/graph/tests before it could move a
      // verdict — safe to surface, never blindly trusted (whitepaper tabayyun gate).
      llmVerified: [
        "assumption refinement (bounded ±band; clears a false ask only past the no-anchor + repo-grounding floors)",
        "routing (free raise; bounded lower, never below strong-signal floor)",
        "impact edges (graph + grep verified)",
        "goal-drift rescue (off→on, goal-referenced)",
      ],
      advisory: [
        "model capability fit",
        "scope minimality",
        "goal-drift check",
        "memory/learning relevance",
        "verification completeness",
      ],
    },
  };
  result.llm.provenance.goalAnchor = result.goalAnchor?.provenance?.path ?? "deterministic";
  return result;
}

export function renderSubstrate(result) {
  const lines = ["Forge substrate — pre-action check", ""];
  lines.push(`  proceed: ${result.okToProceed ? "yes" : "ASK FIRST"}`);
  lines.push(
    `  assumption: ${result.assumption.risk} risk · completeness ${result.assumption.completeness.toFixed(2)}`,
  );
  if (result.assumption.questions.length) {
    lines.push("", "  clarify:");
    for (const q of result.assumption.questions) lines.push(`    - ${q}`);
  }
  lines.push(
    "",
    `  route: ${result.route.model.name} (${result.route.tier}) · complexity ${result.route.score.toFixed(2)}`,
  );
  if (result.route.reasons.length) lines.push(`    driven by: ${result.route.reasons.join(", ")}`);
  lines.push("", `  impact: ${result.impact.impactedFiles.length} file(s) predicted`);
  for (const file of result.impact.impactedFiles.slice(0, 10)) lines.push(`    - ${file}`);
  if (result.impact.impactedFiles.length > 10)
    lines.push(`    … ${result.impact.impactedFiles.length - 10} more`);
  if (result.minimality.warnings.length) {
    lines.push("", "  minimality warnings:");
    for (const w of result.minimality.warnings) lines.push(`    - ${w}`);
  }
  if (result.goalAnchor?.drift) {
    lines.push(
      "",
      `  goal drift: ${result.goalAnchor.offGoal.length} changed file(s) off the stated goal:`,
    );
    for (const f of result.goalAnchor.offGoal.slice(0, 8)) lines.push(`    - ${f}`);
  }
  lines.push("", "  verify:");
  for (const c of result.verification.checklist) lines.push(`    - ${c}`);
  return lines.join("\n");
}

// Compact advisory for AMBIENT injection (Claude Code UserPromptSubmit additionalContext).
// Returns "" unless there is something worth surfacing — never nags on a well-specified,
// low-impact task. Gated on: must-ask assumptions, a premium model recommendation,
// predicted blast radius, or a minimality warning.
export function substrateContext(result) {
  const worthSaying =
    result.assumption.shouldAsk ||
    result.impact.impactedFiles.length > 0 ||
    result.minimality.warnings.length > 0 ||
    result.goalAnchor?.drift ||
    ["opus", "fable"].includes(result.route.key);
  if (!worthSaying) return "";
  const lines = ["Forge substrate — pre-action advisory (advisory, never blocks):"];
  if (result.assumption.shouldAsk) {
    lines.push(
      `- Under-specified (${result.assumption.risk} risk). Ask before editing:`,
      ...result.assumption.questions.map((q) => `    • ${q}`),
    );
  }
  lines.push(
    `- Suggested model: ${result.route.model.name} (${result.route.tier}); escalate only on a verifier failure.`,
  );
  if (result.impact.impactedFiles.length) {
    const files = result.impact.impactedFiles;
    lines.push(
      `- Predicted blast radius (${files.length}): ${files.slice(0, 8).join(", ")}${files.length > 8 ? " …" : ""}. Review these before editing.`,
    );
  }
  for (const w of result.minimality.warnings) lines.push(`- Minimality: ${w}`);
  if (result.goalAnchor?.drift)
    lines.push(
      `- Goal drift: ${result.goalAnchor.offGoal.length} changed file(s) off the stated goal (${result.goalAnchor.offGoal.slice(0, 5).join(", ")}). Intended, or wandering?`,
    );
  if (result.memory.matchingLessons)
    lines.push(`- ${result.memory.matchingLessons} past lesson(s) match this area (advisory).`);
  lines.push(`- Verify with: ${result.verification.checklist.join(" · ")}`);
  return lines.join("\n");
}
