// forge substrate — one pre-action surface for the cognitive substrate described in
// the paper: gate assumptions, route model effort, inspect scope/impact, surface memory,
// and produce an external verification checklist. Deterministic where possible;
// advisory where the paper marks the research edge.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunner, llmEnabled } from "./adjudicate.js";
import { gitFiles, goalDrift, workFiles } from "./anchor.js";
import {
  isStale as atlasIsStale,
  build as buildAtlas,
  buildSccIndex,
  byRelation,
  DEPENDENT_RELATIONS,
  fileRelations,
  IMPACT_RELATIONS,
  impact as impactGraph,
  load as loadAtlas,
  relationRank,
} from "./atlas.js";
import { assemble as assembleContext } from "./context.js";
import { matchingLessons } from "./cortex.js";
import { recordGate } from "./cost_report.js";
import { leanRepo } from "./lean.js";
import { mergedLessons } from "./ledger_read.js";
import { clarifyBlock, preflightRepo, referencedEntities } from "./preflight.js";
import { rankReport } from "./rank.js";
import { reusePeek, reuseQuery } from "./reuse.js";
import { meterRoute, routeTask } from "./route.js";
import { decompose } from "./scope.js";
import { currentSessionId, sessionChanges } from "./session.js";
import { detectStack } from "./stack.js";
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
  // Derive the real test command(s) from the repo's actual stack instead of assuming npm.
  try {
    for (const cmd of detectStack(root).testCommands) checks.push(cmd);
  } catch {}
  // Node repos also get typecheck/lint if the scripts plausibly exist (cheap heuristic).
  if (existsSync(join(root, "package.json"))) {
    checks.push("npm run typecheck");
    checks.push("npm run lint");
  }
  checks.push("review impacted files before editing");
  checks.push("run the narrowest affected test first, then the broader suite");
  return [...new Set(checks)];
}

// The files THIS session changed (session.js sessionChanges, noise-filtered like the drift
// check's own view), or null when the session has no baseline — the caller then keeps the
// whole-working-diff view. Fail-open: any trouble is "not scoped", never a throw.
function sessionScope(root, sid) {
  try {
    const s = sessionChanges(root, sid);
    return s ? { base: s.base, files: workFiles(s.changed), attributed: s.attributed } : null;
  } catch {
    return null;
  }
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

/**
 * Predict the tests likely to fail if the impacted files change (impacted tests + siblings).
 * @param {string} root
 * @param {string[]} impactedFiles
 * @param {Record<string, string>} [rels] file → relation (atlas fileRelations)
 * @returns {string[]}
 */
export function predictFailingTests(root, impactedFiles, rels) {
  const out = new Set();
  // With relation tags, tests predicted by a DEPENDENT come before a sibling's or forward
  // file's (a Set keeps first insertion), so the capped "run these first" list leads with
  // them; untagged input keeps the plain sorted order.
  const files = rels ? byRelation(impactedFiles, rels) : impactedFiles;
  for (const f of files) {
    if (isTestFile(f)) {
      out.add(f);
      continue;
    }
    for (const c of siblingTestCandidates(f)) if (existsSync(join(root, c))) out.add(c);
  }
  return rels ? [...out] : [...out].sort();
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
 * Load rank data (SCC index + per-file hazard scores) for enhanced impact analysis.
 * Fail-open: if rank.js is unavailable or the data can't be computed, returns nulls
 * and impact() falls back to basic mode transparently.
 * @param {string} root
 * @returns {{sccIndex: Map<string, number>|undefined, hazards: Map<string, number>|undefined}}
 */
export function loadRankData(root) {
  try {
    const report = rankReport(root);
    if (!report.built) return { sccIndex: undefined, hazards: undefined };
    const sccIndex = report.cycles?.length ? buildSccIndex(report.cycles) : undefined;
    const hazards = report.topFiles?.length
      ? new Map(report.topFiles.map((f) => [f.file, f.hazard]))
      : undefined;
    return { sccIndex, hazards };
  } catch {
    return { sccIndex: undefined, hazards: undefined };
  }
}

/**
 * @param {string} root
 * @param {string} target
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {boolean} [opts.llm]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.basic] skip hazard-aware enhancements
 * @param {readonly string[]} [opts.relations] which relations to walk; omitted means
 *   impact()'s own default (reverse only). Pass IMPACT_RELATIONS for the wide walk.
 */
export function predictImpact(
  root,
  target,
  { threshold = 0.1, llm, model, timeoutMs, basic, relations } = {},
) {
  const cached = loadAtlas(root);
  const atlas = cached && !atlasIsStale(root, cached) ? cached : buildAtlas({ root });
  const useLLM = llmEnabled({ llm });
  const rankData = basic ? {} : loadRankData(root);
  return impactGraph(atlas, target, {
    threshold,
    // undefined → impact()'s own default (reverse only). `forge impact --all-relations`
    // passes IMPACT_RELATIONS to add the paper's sibling/forward walk.
    ...(relations ? { relations } : {}),
    llm: useLLM,
    run: useLLM ? buildRunner({ model, timeoutMs }) : undefined,
    verify: makeImpactVerify(root),
    sccIndex: rankData.sccIndex,
    hazards: rankData.hazards,
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
 * @param {readonly string[]} [opts.relations] impact relations to walk — default
 *   IMPACT_RELATIONS (reverse + the paper's sibling/forward repair, each file tagged);
 *   pass DEFAULT_IMPACT_RELATIONS (["reverse"]) for the reverse-only walk.
 * @param {string|null} [opts.sessionId] the session this check runs in (default: the
 *   FORGE_SESSION_ID / CLAUDE_CODE_SESSION_ID env). When that session has a baseline, goal
 *   drift and the minimality footprint measure only what THIS session changed.
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
    relations = IMPACT_RELATIONS,
    sessionId = currentSessionId(),
  } = {},
) {
  const text = String(task || "");
  // Pre-action checks read the WORKING DIFF. In a checkout several agents share, most of
  // it is other agents' work (or dirt older than this session), and critiquing it as this
  // task's footprint is noise. Scoped to the session when it has a baseline; else as before.
  const session = sessionScope(root, sessionId);
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
    minConfidence: spec?.llm?.minConfidence,
    signalFloor: spec?.llm?.signalFloor,
  };
  const entities = referencedEntities(text);
  const preflight = preflightRepo(root, text, {
    askThreshold,
    allowBuild,
    ...llmOpts,
  });
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
  // builds or writes .forge/atlas.json from a hook. When the cached atlas is missing or STALE
  // and we can't rebuild (ambient), impact is not trustworthy: flag it (atlasFresh:false) so
  // callers surface "impact unavailable" instead of presenting 0 impacted files as fact.
  let atlas = loadAtlas(root);
  let atlasFresh = true;
  if (atlas) {
    if (atlasIsStale(root, atlas)) {
      if (allowBuild) {
        atlas = buildAtlas({ root });
      } else {
        // Stale cache, can't rebuild from a hook. A stale graph is NOT evidence — drop it
        // entirely so impacts/impactedFiles/predictedTests all derive from nothing instead
        // of from a snapshot of a repo that no longer exists (RA-07).
        atlas = null;
        atlasFresh = false;
      }
    }
  } else if (allowBuild) {
    atlas = buildAtlas({ root });
  } else {
    atlasFresh = false; // no atlas and can't build
  }
  const impactTargets = [...new Set([...entities.symbols, ...entities.files])].slice(0, 8);
  const impactRun = useLLM ? buildRunner({ model, timeoutMs }) : undefined;
  const impactVerify = makeImpactVerify(root);
  // Recall-critical: the reverse-only walk the empirical refutation measured at recall 0.022
  // (94.7% of its misses were sibling files) is not the default here. Every file is tagged
  // with the relation that reached it, so a reader can tell a dependent from a co-change
  // candidate, and the enforce gate can count dependents only.
  const impacts = atlas
    ? impactTargets.map((target) =>
        impactGraph(atlas, target, {
          threshold,
          relations,
          llm: useLLM,
          run: impactRun,
          verify: impactVerify,
        }),
      )
    : [];
  const impactedFiles = [...new Set(impacts.flatMap((r) => r.impactedFiles || []))].sort();
  const impactRelations = fileRelations(impacts);
  /** @type {Record<string, number>} */
  const relationCounts = {};
  for (const f of impactedFiles) {
    const r = impactRelations[f] ?? "reverse";
    relationCounts[r] = (relationCounts[r] ?? 0) + 1;
  }
  // Scope decomposition and lesson matching keep the DEPENDENT set they always used: they
  // describe the work itself, and co-change candidates are for review, not for scoping.
  const dependentFiles = impactedFiles.filter((f) =>
    DEPENDENT_RELATIONS.includes(impactRelations[f] ?? "reverse"),
  );
  // Consequence simulation (Eq 4), class "failing tests": which tests likely break if the
  // impacted files change — the impacted files that ARE tests, plus each impacted source file's
  // sibling test. Cheap, exact-ish, and surfaced BEFORE the edit (not after, like verify).
  // Gated on atlas freshness (belt and braces with the null atlas above): predictions from a
  // stale graph are not trustworthy and must not be presented as consequence evidence.
  const predictedTests = atlasFresh
    ? predictFailingTests(root, impactedFiles, impactRelations)
    : [];
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
          ? {
              id: r.artifact.id,
              path: r.artifact.body.code?.path,
              form: r.artifact.body.form,
            }
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
  const scopedFiles = [...new Set([...entities.files, ...dependentFiles])];
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
    impact: {
      targets: impactTargets,
      reports: impacts,
      impactedFiles,
      // Which relations were walked, the relation each impacted file was reached by
      // (strongest claim wins: reverse > llm-verified > sibling > forward), and the counts.
      relations: [...relations],
      fileRelations: impactRelations,
      relationCounts,
      predictedTests,
      // Truthful freshness: false when the atlas is missing/stale and couldn't be rebuilt.
      // Consumers must not present impactedFiles as trustworthy when this is false.
      atlasFresh,
      ...(atlasFresh ? {} : { note: "impact unavailable: atlas missing or stale" }),
    },
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
      const scope = session ? "session" : "worktree";
      if (!allowBuild) return { warnings: pre, footprint: null, scope };
      // This session changed nothing yet: whatever diff exists is not its footprint.
      if (session && !session.files.length)
        return {
          warnings: pre,
          footprint: null,
          scope,
          ...(gitFiles(root).length ? { note: "pre-existing diff (not measured)" } : {}),
        };
      const lean = session
        ? leanRepo(root, text, { base: session.base ?? "HEAD", files: session.files })
        : leanRepo(root, text);
      return {
        warnings: [...pre, ...lean.warnings],
        footprint: lean.footprint,
        scope,
      };
    })(),
    // M4 goal-anchoring: re-read the stated goal against files already changed this session.
    // Quiet pre-action (clean tree → no drift); speaks mid-session when work wandered off-goal.
    goalAnchor: goalDrift(root, text, session ? { ...llmOpts, changed: session.files } : llmOpts),
    verification: { checklist: verificationChecklist(root) },
    substrate: loadSubstrateSpec(),
    // Which faculties, if any, had a model proposal survive external verification this run, and
    // which direction it moved (…-cleared / …-tightened for the gate, …-lowered for routing; a
    // routing …-raise-deferred is recorded as advisory only and never applied). Every non-deterministic value was
    // checked before it counted.
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
        "assumption refinement (verdict vs verdict, confidence-gated; clears a false ask only past the no-anchor + repo-grounding floors)",
        "routing (band-to-band; a confident lower vote only, never below the strong-signal floor; a higher vote is never applied, only recorded as an advisory escalateTo that names the tier IF an external check later fails — the doom-loop diagnosis is its only consumer)",
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
 * The blast-radius count is taken over DEPENDENTS (reverse / llm-verified files) by default:
 * the 25-file threshold was set on that walk, and the sibling/forward relations are a recall
 * instrument (precision 0.093 on this repo) — counting them would block most edits here,
 * against this gate's "strongest, lowest-false-positive signals only" contract. The block
 * reason still names them, and `blastRelations` counts other relations when wanted.
 * @param {object} result - substrateCheck() result
 * @param {object} [opts]
 * @param {boolean} [opts.enforce]
 * @param {number} [opts.blastThreshold]
 * @param {readonly string[]} [opts.blastRelations] relations counted toward blastThreshold
 */
export function enforceDecision(
  result,
  { enforce, blastThreshold = 25, blastRelations = DEPENDENT_RELATIONS } = {},
) {
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
  // Blast-radius block ONLY on a fresh atlas: a stale/missing graph yields an empty (or
  // untrustworthy) impacted set, and stale predictions must never hard-block an edit —
  // the explicit guard documents the intent even though a stale atlas now yields blast 0.
  if (result.impact?.atlasFresh !== false) {
    const files = result.impact?.impactedFiles ?? [];
    const rels = result.impact?.fileRelations ?? {};
    // An untagged file (a result built without relation tags) counts, as it always did.
    const counted = files.filter((f) => !rels[f] || blastRelations.includes(rels[f]));
    const blast = counted.length;
    if (blast >= blastThreshold) {
      const others = files.length - blast;
      return {
        block: true,
        reason: `Forge gate (enforcing): this touches a large blast radius (${blast} files predicted${
          others ? `, plus ${others} co-change candidate(s): ${relationSummary(result.impact)}` : ""
        }). Review the impacted files (or narrow the change) before editing.${tail}`,
      };
    }
  }
  return { block: false };
}

/** "2 reverse, 3 sibling, 1 forward" — counts in RELATION_ORDER; "" when untagged. */
function relationSummary(impact) {
  const counts = impact?.relationCounts ?? {};
  return Object.keys(counts)
    .sort((a, b) => relationRank(a) - relationRank(b))
    .map((r) => `${counts[r]} ${r}`)
    .join(", ");
}

/** What each relation tag claims — printed once, only when a non-reverse tag is shown. */
const RELATION_LEGEND =
  "reverse = depends on the change · sibling = shares a dependency with it · forward = the change depends on it";

/** Impacted files strongest relation first, each with its tag when tags exist. */
function taggedFiles(impact) {
  const rels = impact?.fileRelations ?? {};
  return byRelation(impact?.impactedFiles ?? [], rels).map((f) =>
    rels[f] ? `${f} (${rels[f]})` : f,
  );
}
const hasCoChange = (impact) =>
  Object.values(impact?.fileRelations ?? {}).some((r) => !DEPENDENT_RELATIONS.includes(r));

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
  if (result.impact.atlasFresh === false) {
    lines.push("", "  impact: unavailable — atlas missing or stale (predictions not trustworthy)");
  } else {
    const summary = relationSummary(result.impact);
    lines.push(
      "",
      `  impact: ${result.impact.impactedFiles.length} file(s) predicted${summary ? ` — ${summary}` : ""}`,
    );
    const shown = taggedFiles(result.impact);
    for (const file of shown.slice(0, 10)) lines.push(`    - ${file}`);
    if (shown.length > 10) lines.push(`    … ${shown.length - 10} more`);
    if (hasCoChange(result.impact)) lines.push(`    (${RELATION_LEGEND})`);
  }
  // Predicted tests only speak for a FRESH atlas — right after an "impact: unavailable"
  // notice, a likely-affected-tests list would contradict it with stale data (RA-07).
  const tests = result.impact.atlasFresh === false ? [] : result.impact.predictedTests || [];
  if (tests.length) {
    lines.push("", `  likely-affected tests (${tests.length}) — run these first:`);
    for (const t of tests.slice(0, 8)) lines.push(`    - ${t}`);
  }
  if (result.minimality.warnings.length) {
    lines.push("", "  minimality warnings:");
    for (const w of result.minimality.warnings) lines.push(`    - ${w}`);
  }
  if (result.minimality.note) lines.push("", `  minimality: ${result.minimality.note}`);
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
    result.impact.atlasFresh === false ||
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
  if (result.impact.atlasFresh === false) {
    lines.push(
      "- Impact unavailable: atlas missing or stale — predicted blast radius is not trustworthy (rebuild the atlas to get it).",
    );
  } else if (result.impact.impactedFiles.length) {
    const files = taggedFiles(result.impact);
    const summary = relationSummary(result.impact);
    lines.push(
      `- Predicted blast radius (${files.length}${summary ? `: ${summary}` : ""}): ${files.slice(0, 8).join(", ")}${files.length > 8 ? " …" : ""}. Review these before editing.`,
    );
    if (hasCoChange(result.impact)) lines.push(`  (${RELATION_LEGEND})`);
  }
  // Same freshness rule as the renderer: never advise stale test predictions (RA-07).
  const predTests = result.impact.atlasFresh === false ? [] : result.impact.predictedTests || [];
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
