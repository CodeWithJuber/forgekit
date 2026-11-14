// A planning record. Only an explicit executor (forge develop --verify) can attach a
// verification verdict. Prompt hooks inspect bounded evidence and never run Git or tests.
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { resolveRoutePolicy } from "./orchestration.js";
import { assessTask, referencedEntities } from "./preflight.js";
import { riskMatches } from "./route_policy.js";
import { redactSecrets } from "./secrets.js";
import { classifyDeterministic, resolveChangedFiles } from "./test_select.js";

const FIX =
  /\b(debug|diagnos\w*|bug|broken|fail(?:ed|ing|ures?)?|crash\w*|regression|deadlock|timeout|stack trace|root cause|fix|masla)\b/i;
const SMALL = /\b(typos?|misspell\w*|punctuation|formatting|spelling)\b/i;
const DEPENDENCY =
  /(^|\/)(package(?:-lock)?\.json|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|pom\.xml|pyproject\.toml|requirements[^/]*\.txt|composer\.(?:json|lock)|Gemfile(?:\.lock)?|pubspec\.yaml|yarn\.lock|pnpm-lock\.yaml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$/i;
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
function testPointers(root, files) {
  const candidates = new Set();
  for (const file of files.slice(0, 32)) {
    const ext = extname(file);
    const name = basename(file, ext);
    if (/\btest\b|\.test\.|\.spec\.|_test\.|^test_/i.test(file)) candidates.add(file);
    for (const candidate of [
      join(dirname(file), `${name}.test${ext}`),
      join(dirname(file), `${name}.spec${ext}`),
      join("test", `${name}.test${ext}`),
      join("tests", `test_${name}${ext}`),
      ...(ext === ".go" ? [join(dirname(file), `${name}_test.go`)] : []),
    ])
      if (existsSync(join(root, candidate))) candidates.add(candidate);
  }
  return [...candidates].slice(0, 10);
}
const safeFile = (p) =>
  typeof p === "string" &&
  p.length <= 400 &&
  !p.startsWith("/") &&
  !/[\\:\p{Cc}\p{Cf}]/u.test(p) &&
  p.split("/").every((s) => s && s !== "." && s !== "..");

/**
 * @param {string} task
 * @param {{root?:string,evidence?:any,changedFiles?:string[],hook?:boolean}} options
 */
export function developmentPlan(
  task,
  { root = process.cwd(), evidence = {}, changedFiles, hook = false } = {},
) {
  if (typeof task !== "string" || !task.trim()) throw new Error("Supply a development task");
  if (changedFiles !== undefined && !Array.isArray(changedFiles))
    throw new Error("Expected a list of changed files");
  const objective = clean(task, 2000);
  const observed = changedFiles ?? (hook ? [] : (resolveChangedFiles(root) ?? []));
  const files = observed.filter(safeFile).slice(0, 200);
  const entities = referencedEntities(objective);
  const targets = [...new Set([...files, ...entities.files.filter(safeFile)])].slice(0, 200);
  const { riskCategories } = resolveRoutePolicy(root);
  const signals = riskMatches(
    [objective, ...targets].join(" ").replace(/([a-z])([A-Z])/g, "$1 $2"),
    riskCategories,
  );
  if (
    targets.some((p) => DEPENDENCY.test(p)) ||
    /\b(?:add|install|upgrade) (?:a |the )?(?:dependency|package|sdk|library)\b/i.test(objective)
  )
    signals.push({ category: "dependencies", keyword: "package or manifest" });
  const security = signals.map((s) => ({
    ...s,
    check:
      CATEGORY_ADVICE[s.category] ??
      "Test the affected boundary and review the evidence with its owner.",
  }));
  const tier = files.length ? classifyDeterministic(files).tier : "unselected";
  const tests = hook ? [] : testPointers(root, targets);
  const focused =
    !security.length &&
    (files.length === 0 || tier === "cosmetic") &&
    SMALL.test(objective) &&
    !/\b(implement|architecture|integrate|refactor|migrate|regression|crash|security|also)\b/i.test(
      objective,
    );
  const mode = focused ? "focused" : FIX.test(objective) ? "repair" : "standard";
  const sources = (evidence.hits ?? [])
    .slice(0, 3)
    .map((x) => clean([x.sourceId, x.path, x.locator].filter(Boolean).join(" ")));
  const symbols = (evidence.symbols ?? [])
    .slice(0, 3)
    .map((x) => clean(`${x.file}:${x.line} ${x.name}`));
  const manifests = (evidence.manifests ?? []).slice(0, 3).map((x) => clean(x));
  const refs = [...sources, ...symbols];
  const testsAction = focused
    ? "Inspect the changed wording in context and run its applicable spelling, docs or render check."
    : tests.length
      ? "Run the listed tests, then check affected callers and the project verification verdict."
      : "Select affected tests from the diff and run them. Record any failing or unavailable runner.";
  const acceptance = assessTask(objective).questions.slice(0, 3);
  const stages = [
    stage(
      "plan",
      "before",
      focused
        ? "Locate the requested wording and identify the expected edit."
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
    stage(
      "test",
      "after",
      testsAction,
      focused ? [] : ["forge test-select --json", "forge verify --json"],
      tests,
    ),
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
  const text = focused
    ? "Development: locate the wording, make the requested edit and check the result in context."
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
    testing: { tier, tests },
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
    text,
  };
}
