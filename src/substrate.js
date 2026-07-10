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
import { assemble as assembleContext } from "./context.js";
import { matchingLessons } from "./cortex.js";
import { recordGate } from "./cost_report.js";
import { leanRepo } from "./lean.js";
import { mergedLessons } from "./ledger_read.js";
import { clarifyBlock, preflightRepo, referencedEntities } from "./preflight.js";
import { reusePeek, reuseQuery } from "./reuse.js";
import { meterRoute, routeTask } from "./route.js";
import { decompose } from "./scope.js";
import { epochDay } from "./util.js";

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

// Every warning derives from signals the gate ALREADY computed — the preflight
// DIMENSIONS rubric owns "which dimensions apply and which are missing", routing owns
// complexity. No second keyword copy here to drift out of sync with those sources.
function minimalityWarnings(_task, route, preflight) {
  const warnings = [];
  const missing = new Set((preflight.assumption?.missing ?? []).map((m) => m.key));
  if (missing.has("target_scope") && preflight.entities.files.length === 0) {
    warnings.push(
      "High-risk broad change with no target files named; ask for scope before editing.",
    );
  }
  if (route.score >= 0.55 && (preflight.assumption?.completeness ?? 1) < 0.7) {
    warnings.push(
      "Complex task with medium/low specification completeness; clarify before spending a premium model.",
    );
  }
  // Worded to what the signal actually means: the constraints DIMENSION applies to
  // design/refactor work too, not only production systems — an overclaiming
  // "production-sensitive!" on a casual refactor teaches users to ignore warnings.
  if (missing.has("constraints")) {
    warnings.push(
      "Task implies constraints (design/production/auth/payment-class work) but states none — name performance, compatibility, or rollback expectations.",
    );
  }
  return warnings;
}

const TEST_FILE_RE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.(py|go|rs)$|(^|\/)test_[^/]+\.py$/i;

export const isTestFile = (f) => TEST_FILE_RE.test(String(f));

// Candidate sibling-test paths for a source file: foo.js → foo.test.js / foo.spec.js /
// __tests__/foo.js / test(s)/foo.js, and foo.py → test_foo.py / tests/test_foo.py.
function siblingTestCandidates(file) {
  const s = String(file);
  const slash = s.lastIndexOf("/");
  const dir = slash >= 0 ? s.slice(0, slash + 1) : "";
  const nameExt = s.slice(slash + 1);
  const dot = nameExt.lastIndexOf(".");
  const base = dot > 0 ? nameExt.slice(0, dot) : nameExt;
  const ext = dot > 0 ? nameExt.slice(dot) : "";
  if (ext === ".py")
    return [`${dir}test_${base}.py`, `${dir}tests/test_${base}.py`, `tests/test_${base}.py`];
  const out = [];
  for (const suf of [".test", ".spec"]) out.push(`${dir}${base}${suf}${ext}`);
  for (const d of ["__tests__/", "test/", "tests/"])
    out.push(`${dir}${d}${base}${ext}`, `${d}${base}${ext}`);
  return out;
}

/** Predict the tests likely to fail if the impacted files change (impacted tests + siblings). */
export function predictFailingTests(root, impactedFiles) {
  const out = new Set();
  for (const f of impactedFiles) {
    if (isTestFile(f)) {
      out.add(f);
      continue;
    }
    for (const c of siblingTestCandidates(f)) if (existsSync(join(root, c))) out.add(c);
  }
  return [...out].sort();
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
  // P8 gate metering: one metrics line per explicit gate decision (halt = spend avoided).
  // Same write contract as reuseQuery vs reusePeek below — the ambient hook path
  // (allowBuild:false) never appends. Best-effort: measurement must never block the gate.
  if (allowBuild) {
    try {
      recordGate(root, { halted: preflight.assumption.shouldAsk });
    } catch {}
  }
  // Reuse the gap preflight already computed — routeTask would otherwise recompute it (and, with
  // FORGE_LLM on, fire a second, redundant assumption model call whose result it discards).
  const route = routeTask(root, text, { ...llmOpts, ambiguity: preflight.gap });
  // P8 route metering, same write contract as recordGate above: the explicit gate
  // meters, the ambient hook path (allowBuild:false) never appends. meterRoute is
  // itself best-effort (try/catch inside), so measurement can never block routing.
  if (allowBuild) meterRoute(root, text, route);
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
  // Consequence simulation (Eq 4), class "failing tests": which tests likely break if the
  // impacted files change — the impacted files that ARE tests, plus each impacted source file's
  // sibling test. Cheap, exact-ish, and surfaced BEFORE the edit (not after, like verify).
  const predictedTests = predictFailingTests(root, impactedFiles);
  // P3 reuse stage: has this team already built (and verified) this? The explicit gate
  // meters + writes evidence (reuseQuery); the ambient hook path stays read-only
  // (reusePeek) so a per-prompt hook never appends to the ledger or metrics.
  const reuse = (() => {
    try {
      const opts = { atlas, nowDay: epochDay() };
      const r = allowBuild ? reuseQuery(root, text, opts) : reusePeek(root, text, opts);
      return {
        tier: r.tier,
        artifact: r.artifact
          ? { id: r.artifact.id, path: r.artifact.body.code?.path, form: r.artifact.body.form }
          : undefined,
        jaccard: r.jaccard,
      };
    } catch {
      return { tier: "miss" }; // cache trouble must never block the gate
    }
  })();
  // P4 context assembly: what the edit REQUIRES to be known (defs, dependents, tests,
  // trusted lessons) vs what can be supplied — missing becomes derived questions, not
  // assumptions. Explicit gate only (file reads are too heavy for the per-prompt hook).
  const context = allowBuild
    ? (() => {
        try {
          return assembleContext(root, text, { atlas, nowDay: epochDay() });
        } catch {
          return null; // assembly trouble must never block the gate
        }
      })()
    : null;
  const scopedFiles = [...new Set([...entities.files, ...impactedFiles])];
  const scope = scopedFiles.length
    ? decompose(root, scopedFiles)
    : { clusters: [], independentGroups: 0 };
  // Merged view (P2 read flip): a teammate's merged lesson counts in the advisory too.
  const lessons = matchingLessons(mergedLessons(root, epochDay()), {
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
    reuse,
    context: context && {
      ok: context.ok,
      tokens: context.tokens,
      budget: context.budget,
      required: context.required.length,
      missing: context.missing,
      questions: context.questions,
    },
    impact: { targets: impactTargets, reports: impacts, impactedFiles, predictedTests },
    scope,
    memory: {
      matchingLessons: lessons.length,
      advisory: lessons.slice(0, 5).map((lesson) => ({
        id: lesson.id,
        status: lesson.status,
        scope: lesson.scope,
      })),
    },
    // M5 anti-over-engineering: the pre-action keyword heuristics PLUS a measured footprint check
    // (φ(y) − φ*(x)) against the working diff once one exists — abstractions/files/lines the task
    // never asked for. `lean` is diff-based, so it's quiet until there's something to measure.
    minimality: (() => {
      const pre = minimalityWarnings(text, route, preflight);
      const lean = allowBuild ? leanRepo(root, text) : { warnings: [], footprint: null };
      return { warnings: [...pre, ...lean.warnings], footprint: lean.footprint };
    })(),
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

/**
 * Opt-in mandatory gate (the paper's Eq 5 / M2 "halt on insufficient input"). Turns the advisory
 * assumption gate into an actual BLOCK — but only on the strongest, lowest-false-positive signals,
 * so it halts a vacuous prompt ("fix it", "make it better") or an edit into a very large blast
 * radius, and never a specified task. Off unless `FORGE_ENFORCE=1` (or `enforce:true`); default
 * behaviour is unchanged. `reason` is written to be shown to the agent.
 * @param {object} result - substrateCheck() result
 * @param {object} [opts]
 * @param {boolean} [opts.enforce]
 * @param {number} [opts.blastThreshold]
 */
export function enforceDecision(result, { enforce, blastThreshold = 25 } = {}) {
  const on = typeof enforce === "boolean" ? enforce : process.env.FORGE_ENFORCE === "1";
  if (!on || !result) return { block: false };
  const tail = "\n(Set FORGE_ENFORCE=0 to make Forge advisory again.)";
  if (result.assumption?.hardUnderspecified) {
    const qs = (result.assumption.questions || []).map((q) => `  • ${q}`).join("\n");
    return {
      block: true,
      reason: `Forge gate (enforcing): this task has no concrete anchor to act on — clarify before I start:\n${qs}${tail}`,
    };
  }
  // P4 completeness gate: the task names things the repo cannot supply — the questions
  // are DERIVED from the missing-knowledge set, so acting now means acting on a guess.
  if (result.context && !result.context.ok && result.context.questions.length) {
    const qs = result.context.questions.map((q) => `  • ${q}`).join("\n");
    return {
      block: true,
      reason: `Forge gate (enforcing): the required context can't be assembled from this repo — resolve before I edit:\n${qs}${tail}`,
    };
  }
  const blast = result.impact?.impactedFiles?.length ?? 0;
  if (blast >= blastThreshold) {
    return {
      block: true,
      reason: `Forge gate (enforcing): this touches a large blast radius (${blast} files predicted). Review the impacted files (or narrow the change) before editing.${tail}`,
    };
  }
  return { block: false };
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
  if (result.reuse && result.reuse.tier !== "miss") {
    const a = result.reuse.artifact;
    lines.push(
      "",
      `  reuse: ${result.reuse.tier.toUpperCase()} hit — verified ${a?.form ?? "artifact"}${a?.path ? ` at ${a.path}` : ""} (\`forge ledger show ${a?.id.slice(0, 8)}\`) — start from it, don't regenerate`,
    );
  }
  if (result.context) {
    lines.push(
      "",
      `  context: ${result.context.ok ? "complete" : "INCOMPLETE"} — ${result.context.required} required item(s), ${result.context.tokens}/${result.context.budget} tokens (\`forge context\` for the assembly)`,
    );
    for (const q of result.context.questions ?? []) lines.push(`    ? ${q}`);
  }
  lines.push("", `  impact: ${result.impact.impactedFiles.length} file(s) predicted`);
  for (const file of result.impact.impactedFiles.slice(0, 10)) lines.push(`    - ${file}`);
  if (result.impact.impactedFiles.length > 10)
    lines.push(`    … ${result.impact.impactedFiles.length - 10} more`);
  const tests = result.impact.predictedTests || [];
  if (tests.length) {
    lines.push("", `  likely-affected tests (${tests.length}) — run these first:`);
    for (const t of tests.slice(0, 8)) lines.push(`    - ${t}`);
  }
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
  const predTests = result.impact.predictedTests || [];
  if (predTests.length)
    lines.push(
      `- Likely-affected tests (${predTests.length}): ${predTests.slice(0, 6).join(", ")}${predTests.length > 6 ? " …" : ""}. Run these first.`,
    );
  for (const w of result.minimality.warnings) lines.push(`- Minimality: ${w}`);
  if (result.goalAnchor?.drift)
    lines.push(
      `- Goal drift: ${result.goalAnchor.offGoal.length} changed file(s) off the stated goal (${result.goalAnchor.offGoal.slice(0, 5).join(", ")}). Intended, or wandering?`,
    );
  if (result.memory.matchingLessons)
    lines.push(`- ${result.memory.matchingLessons} past lesson(s) match this area (advisory).`);
  // I3: proceeding is fine below the ask-threshold, but never SILENTLY — the gaps are
  // named here and recorded to the session log (the handoff surfaces them later).
  if (
    !result.assumption.shouldAsk &&
    ((result.assumption.missing?.length ?? 0) > 0 || result.assumption.questions?.length > 0)
  ) {
    const keys = (result.assumption.missing ?? []).map((m) => m.key);
    lines.push(
      `- Proceeding without asking under ${keys.length || result.assumption.questions.length} recorded assumption(s)${keys.length ? ` (${keys.join(", ")})` : ""}. Verify them before claiming done.`,
    );
  }
  lines.push(`- Verify with: ${result.verification.checklist.join(" · ")}`);
  return lines.join("\n");
}
