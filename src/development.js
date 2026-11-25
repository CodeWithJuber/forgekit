// A planning record. Only an explicit executor (forge develop --verify) can attach a
// verification verdict. Prompt hooks inspect bounded evidence and never run Git or tests.
import { chooseAdvice } from "./decisions.js";
import { assessTask, referencedEntities } from "./preflight.js";
import { readForgeConfig, readUserConfig } from "./repo_config.js";
import { riskMatches } from "./route_policy.js";
import { redactSecrets } from "./secrets.js";
import { resolveChangedFiles, selectTestsSync } from "./test_select.js";

const CATEGORY_ADVICE = {
  auth: "Try a permitted identity and a denied identity against the same resource.",
  money: "Test replay, idempotency, rounding and partial failure on the affected transaction.",
  migrations: "Check old and new readers, retries, rollback and data preservation.",
  secrets: "Check credentials, log redaction and access to stored data.",
  security: "Exercise hostile input and verify the expected rejection at the trust boundary.",
  dependencies:
    "Check exact package identity, upstream maintenance, license, advisory and lockfile changes.",
};
const clean = (value, n = 230) =>
  redactSecrets(String(value ?? ""))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .slice(0, n);
const stage = (id, phase, action, commands = [], refs = []) => ({
  id,
  phase,
  status: "planned",
  action,
  commands,
  refs,
});
const safeFile = (p) =>
  typeof p === "string" &&
  p.length <= 400 &&
  !p.startsWith("/") &&
  !/[\\:\p{Cc}\p{Cf}]/u.test(p) &&
  p.split("/").every((s) => s && s !== "." && s !== "..");

/**
 * @param {string} task
 * @param {{root?:string,evidence?:any,changedFiles?:string[],mode?:string,hook?:boolean,llm?:boolean,
 * jevCall?:(payload:object)=>object}} options
 */
export function developmentPlan(
  task,
  {
    root = process.cwd(),
    evidence = {},
    changedFiles,
    mode: requestedMode,
    hook = false,
    llm,
    jevCall,
  } = {},
) {
  if (typeof task !== "string" || !task.trim()) throw new Error("Supply a development task");
  if (changedFiles !== undefined && !Array.isArray(changedFiles))
    throw new Error("Expected a list of changed files");
  const objective = clean(task, 2000);
  const observed = changedFiles ?? (hook ? [] : (resolveChangedFiles(root) ?? []));
  const files = observed.filter(safeFile).slice(0, 200);
  const entities = referencedEntities(objective);
  const targets = [...new Set([...files, ...entities.files.filter(safeFile)])].slice(0, 200);
  // A named review policy is an operator preference. Shipped keyword lists
  // cannot classify an unfamiliar task or authorize a narrower test run.
  const policy = {
    ...readUserConfig()?.route?.riskCategories,
    ...readForgeConfig(root)?.route?.riskCategories,
  };
  const signals = riskMatches([objective, ...targets].join(" "), policy);
  const changedManifests = targets.filter((path) => (evidence.manifests ?? []).includes(path));
  if (changedManifests.length)
    signals.push({ category: "dependencies", keyword: clean(changedManifests.join(", ")) });
  const security = signals.map((s) => ({
    ...s,
    check:
      CATEGORY_ADVICE[s.category] ??
      "Test the affected boundary and review the evidence with its owner.",
  }));
  // The display truncates paths. The decision must account for every observed path.
  const selection = hook || !observed.length ? null : selectTestsSync({ root, files: observed });
  const tier = selection?.tier ?? "unselected";
  const tests = selection?.tests ?? [];
  const mode =
    requestedMode ?? (evidence.verification?.tests?.status === "FAIL" ? "repair" : "standard");
  if (!["focused", "repair", "standard"].includes(mode))
    throw new Error("Choose a development mode: focused, repair or standard");
  const focused = mode === "focused";
  const sources = (evidence.hits ?? [])
    .slice(0, 3)
    .map((x) => clean([x.sourceId, x.path, x.locator].filter(Boolean).join(" ")));
  const symbols = (evidence.symbols ?? [])
    .slice(0, 3)
    .map((x) => clean(`${x.file}:${x.line} ${x.name}`));
  const manifests = (evidence.manifests ?? []).slice(0, 3).map((x) => clean(x));
  const refs = [...sources, ...symbols];
  const testsAction = focused
    ? "Inspect the requested change in context and run its verification plan."
    : tests.length
      ? "Run the listed tests, then check affected callers and the project verification verdict."
      : "Run the project suite and record any failing or unavailable runner.";
  const acceptance = assessTask(objective).questions.slice(0, 3);
  const stages = [
    stage(
      "plan",
      "before",
      focused
        ? "Locate the requested change and identify the acceptance check."
        : "Define the observable success case and identify affected callers, inputs and constraints.",
      [],
      refs,
    ),
  ];
  if (!focused) {
    if (mode === "repair")
      stages.push(
        stage(
          "reproduce",
          "before",
          "Reproduce the failure with a minimal input. Capture the error and expected behavior before modifying its cause.",
          [],
          refs,
        ),
      );
    stages.push(
      stage(
        "reuse",
        "before",
        "Inspect team artifacts and matched declarations, then the standard library and installed SDKs. If a gap remains, compare a maintained upstream example at the installed version and record the source and license.",
        [],
        [
          ...symbols,
          ...manifests,
          ...(evidence.reuse?.tier && evidence.reuse.tier !== "miss"
            ? [clean(evidence.reuse.path ?? evidence.reuse.tier)]
            : []),
        ],
      ),
    );
  }
  stages.push(
    stage(
      "implement",
      "during",
      focused
        ? "Make the focused edit and inspect the resulting diff."
        : "Extend the chosen implementation at its existing entry point. Preserve existing callers and implement the smallest delta that satisfies the acceptance case.",
      [],
      symbols,
    ),
  );
  if (!focused)
    stages.push(
      stage(
        "security",
        "during",
        security.length
          ? security.map((s) => s.check).join(" ")
          : "Inspect changed trust boundaries, validation, error paths and logs. Check any added package with the appropriate registry guard.",
        security.some((s) => s.category === "dependencies") ? ["forge radar"] : [],
        targets.slice(0, 4),
      ),
    );
  stages.push(
    stage("test", "after", testsAction, ["forge test-select --json", "forge verify --json"], tests),
  );
  if (!focused)
    stages.push(
      stage(
        "review",
        "after",
        "Have a separate reviewer inspect the final diff and reported results for regressions, uncovered edge cases and duplicated code. If unavailable, leave independent review pending.",
        ["git diff --", "git diff --cached --", "git ls-files --others --exclude-standard"],
        targets.slice(0, 4),
      ),
    );
  const repair = {
    condition: "a check fails",
    action:
      "Capture the first failing assertion. Reproduce it, revise the cause, review the new diff, and rerun the same failing check before broad verification.",
  };
  const focus = chooseAdvice({
    root,
    llm: focused ? false : llm,
    call: jevCall,
    timeoutMs: hook ? 800 : 5000,
    state: {
      mode,
      changedFileCount: files.length,
      riskCategories: security
        .map((s) => s.category)
        .filter((c) => Object.hasOwn(CATEGORY_ADVICE, c)),
      localReuse: Boolean(
        symbols.length > 0 || (evidence.reuse?.tier && evidence.reuse.tier !== "miss"),
      ),
      acceptanceQuestions: acceptance.length,
    },
    choices: {
      acceptance: "Clarify the observable acceptance case before editing.",
      inspect: "Inspect existing declarations and their callers before choosing an implementation.",
      ...(mode === "repair"
        ? { reproduce: "Capture a minimal reproduction before changing the cause." }
        : {}),
      ...(security.length
        ? { boundary: "Inspect the affected trust boundary and its denied-input case." }
        : {}),
    },
    fallback: mode === "repair" ? "reproduce" : "acceptance",
  });
  const text = focused
    ? "Locate the requested change, make the edit and verify the result in context."
    : [
        mode === "repair"
          ? "Development: reproduce the failure first."
          : "Development: define the acceptance case.",
        "Inspect existing code and dependencies, then adapt the smallest change.",
        security.length
          ? `Review ${security.map((s) => s.category).join(", ")} risks.`
          : "Review changed trust boundaries.",
        "Run focused tests and verification, then review the diff independently. On failure, reproduce and rerun the same check.",
      ].join(" ");
  return {
    mode,
    objective,
    stages,
    security,
    testing: {
      tier,
      tests,
      ...(selection ? { fullSuite: selection.fullSuite, reason: selection.reason } : {}),
    },
    changedFiles: files,
    changedFilesTruncated: observed.length > files.length,
    changeInspection:
      hook && changedFiles === undefined
        ? "deferred"
        : changedFiles === undefined
          ? "git"
          : "supplied",
    acceptanceQuestions: acceptance,
    repair,
    focus,
    text: `${text} Planning focus (${focus.source}): ${focus.reason}`,
  };
}
