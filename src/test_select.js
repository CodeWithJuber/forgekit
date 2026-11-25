// Test selection is an evidence query. Without a complete input graph, the
// ordinary runner remains responsible for all tests, for every kind of file.
import { execFileSync } from "node:child_process";
import { BRAND } from "./brand.js";
import { heading } from "./cli/shared.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { dependencyState, measuredImpact, registerDependencies } from "./test_dependencies.js";

function full(reason) {
  return { tier: "high", reason, tests: [], lint: [], typecheck: true, fullSuite: true };
}

/** Planning callers with filenames alone cannot establish a smaller suite. */
export function classifyDeterministic(files) {
  return full(
    files.length
      ? "No measured dependencies supplied for these paths"
      : "Change set unknown (fail-safe)",
  );
}

/** @param {{root?:string,files?:string[],head?:string,evidence?:string}} [options] */
export function selectTestsSync({ root = process.cwd(), files = [], head, evidence } = {}) {
  if (!files.length) return classifyDeterministic(files);
  try {
    const { affected, ...observation } = measuredImpact(root, files, evidence, head);
    if (!observation.tests.length || observation.tests.length === observation.testUniverse)
      return full("The affected set requires the full suite");
    return {
      tier: "medium",
      reason: "Reverse closure of the complete producer-declared test dependencies",
      lint: [],
      typecheck: true,
      fullSuite: false,
      affectedCount: affected.length,
      ...observation,
    };
  } catch (error) {
    return full(
      (error instanceof Error ? error.message : "Dependency observation unavailable") +
        " (fail-safe)",
    );
  }
}

/** @param {Parameters<typeof selectTestsSync>[0]} [options] */
export async function selectTests(options) {
  return selectTestsSync(options);
}

export function mapToTests(root, files) {
  try {
    return measuredImpact(root, files).tests;
  } catch {
    return [];
  }
}

export async function blastRadius(root, files) {
  try {
    const { affected } = measuredImpact(root, files);
    return { files: affected, count: affected.length, withoutTestPath: [] };
  } catch {
    return null;
  }
}

// ── Changed-file resolution ──────────────────────────────────────────────────

/**
 * Resolve explicit repo-relative paths or the working tree plus an optional ref
 * range. Pending inputs matter because the runner consumes the working tree.
 * Null means a known empty scope. An empty list means the change set is unknown.
 * @param {string} cwd
 * @param {{changed?: string, base?: string, head?: string}} opts
 * @returns {string[] | null}
 */
export function resolveChangedFiles(cwd, { changed, base, head } = {}) {
  if (changed !== undefined)
    return changed
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  const git = (args) => {
    try {
      return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        encoding: "utf8",
        timeout: 4000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
  const files = new Set();
  if (base) {
    if (base.startsWith("-") || head?.startsWith("-")) return [];
    const out = git([
      "diff",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      `${base}...${head || "HEAD"}`,
      "--",
    ]);
    if (out === null) return [];
    for (const f of out.split("\0").filter(Boolean)) files.add(f);
  }
  const diff = ["--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "--"];
  const staged = git(["diff", "--cached", ...diff]);
  const unstaged = git(["diff", ...diff]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const out of [staged, unstaged, untracked]) {
    if (out === null) return [];
    if (out) for (const f of out.split("\0").filter(Boolean)) files.add(f);
  }
  return files.size ? [...files].sort() : null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/**
 * `forge test-select [--changed a,b] [--base X --head Y] [--json]`
 * Prints the test plan for the current change. Never runs tests.
 * @param {string[]} argv
 */
export async function runTestSelect(argv, root = process.cwd()) {
  root = sourceWorkspaceRoot(root);
  const json = argv.includes("--json");
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  if (argv.includes("--state")) {
    console.log(JSON.stringify(dependencyState(root), null, 2));
    return;
  }
  if (argv.includes("--register")) {
    const input = flag("--register");
    if (!input || input.startsWith("--"))
      throw new Error("--register requires a protected evidence path");
    console.log(JSON.stringify(registerDependencies(root, input), null, 2));
    return;
  }
  const files = resolveChangedFiles(root, {
    changed: flag("--changed"),
    base: flag("--base"),
    head: flag("--head"),
  });
  if (files === null) {
    const msg = "no changes in the selected checkout scope";
    if (json) console.log(JSON.stringify({ tier: "none", reason: msg, tests: [] }));
    else console.log(`  ${msg}.`);
    return;
  }
  const plan = await selectTests({
    root,
    files,
    head: flag("--head"),
    evidence: flag("--evidence"),
  });
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  heading(`${BRAND.brand} test-select — the test plan for this change\n`);
  console.log(`  tier:       ${plan.tier} — ${plan.reason}`);
  console.log(
    `  tests:      ${plan.tests.length ? plan.tests.join(", ") : plan.fullSuite ? "(full suite)" : "(none)"}`,
  );
  if (plan.lint.length) console.log(`  lint:       ${plan.lint.join(", ")}`);
  console.log(`  typecheck:  ${plan.typecheck ? "yes" : "no"}`);
  console.log(
    `\n  selection only — run the tests yourself, then \`${BRAND.cli} verify\` for the verdict.`,
  );
}
