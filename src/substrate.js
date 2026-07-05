// forge substrate — one pre-action surface for the cognitive substrate described in
// the paper: gate assumptions, route model effort, inspect scope/impact, surface memory,
// and produce an external verification checklist. Deterministic where possible;
// advisory where the paper marks the research edge.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export function predictImpact(root, target, { threshold = 0.1 } = {}) {
  const atlas = loadAtlas(root) || buildAtlas({ root });
  return impactGraph(atlas, target, { threshold });
}

export function substrateCheck(
  root,
  task,
  { threshold = 0.1, askThreshold = 0.6, allowBuild = true } = {},
) {
  const text = String(task || "");
  const entities = referencedEntities(text);
  const preflight = preflightRepo(root, text, { askThreshold, allowBuild });
  const route = routeTask(root, text);
  // allowBuild:false (ambient hooks) uses the atlas only if one is already cached — never
  // builds or writes .forge/atlas.json from a hook. Impact is then best-effort.
  const atlas = loadAtlas(root) || (allowBuild ? buildAtlas({ root }) : null);
  const impactTargets = [...new Set([...entities.symbols, ...entities.files])].slice(0, 8);
  const impacts = atlas
    ? impactTargets.map((target) => impactGraph(atlas, target, { threshold }))
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
    goalAnchor: goalDrift(root, text),
    verification: { checklist: verificationChecklist(root) },
    substrate: loadSubstrateSpec(),
    guarantees: {
      deterministic: [
        "assumption rubric",
        "repo symbol/file grounding",
        "model routing rubric",
        "impact graph traversal",
        "scope decomposition",
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
