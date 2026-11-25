// forge test-select — smart test selection as a first-class command.
//
// The tier contract (deterministic first, judgment on top):
//   cosmetic — docs/assets only            → lint the changed files
//   low      — test files only              → run those test files
//   medium   — src changes                  → impact-mapped related tests + typecheck
//   high     — config/CLI/core/mixed/unknown → full suite (fail-safe)
//
// The selector chooses the SCOPE; verification itself is never skipped — any
// uncertainty escalates to the full suite. The impact leg is HEURISTIC (the atlas is
// regex-derived, not a parser) and the output says so; it narrows the run, it never
// certifies the change. `forge verify` remains the verdict.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { heading } from "./cli/shared.js";

// ── Tier 1: deterministic signals ────────────────────────────────────────────

const COSMETIC_PATTERNS = [
  /\.md$/,
  /\.mdx$/,
  /\.txt$/,
  /\.rst$/,
  /\.png$/,
  /\.jpg$/,
  /\.svg$/,
  /\.ico$/,
  /CITATION\.cff$/,
  /LICENSE$/,
];

const TEST_FILE = /(^|\/)test\/.*\.test\.(js|ts|mjs|cjs)$/;
const SRC_FILE = /^src\/.*\.(js|ts|mjs|cjs)$/;

// Changes that ALWAYS trigger the full suite (fail-safe).
const HIGH_RISK = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig\.json$/,
  /^biome\.json$/,
  /^\.github\/workflows\//,
  /^src\/cli\.js$/, // CLI entry — everything flows through it
  /(^|\/)test\/_setup\.(js|ts)$/, // test harness itself
  /^global\/hooks\//, // guard hooks
  /^bin\//,
];

/**
 * Pure tier classification from a changed-file list. No I/O.
 * @param {string[]} files repo-relative paths
 * @returns {{tier: "cosmetic"|"low"|"medium"|"high", reason: string, tests?: string[], srcFiles?: string[]}}
 */
export function classifyDeterministic(files) {
  if (files.length === 0) return { tier: "high", reason: "no changed files detected (fail-safe)" };

  const risky = files.filter((f) => HIGH_RISK.some((p) => p.test(f)));
  if (risky.length > 0)
    return {
      tier: "high",
      reason: `high-risk files: ${risky.slice(0, 3).join(", ")}`,
    };

  if (files.every((f) => COSMETIC_PATTERNS.some((p) => p.test(f))))
    return { tier: "cosmetic", reason: "docs/assets only" };

  if (files.every((f) => TEST_FILE.test(f)))
    return { tier: "low", reason: "test files only", tests: files };

  const srcFiles = files.filter((f) => SRC_FILE.test(f));
  if (srcFiles.length > 0 && srcFiles.length === files.length)
    return {
      tier: "medium",
      reason: `src changes: ${srcFiles.length} file(s)`,
      srcFiles,
    };

  return { tier: "high", reason: "mixed change types (fail-safe)" };
}

// ── Test mapping ─────────────────────────────────────────────────────────────

/**
 * Map src files to their test files: convention first (`src/foo.js` →
 * `test/foo.test.js`), then a grep for test files that reference the module.
 * @param {string} root repo root
 * @param {string[]} srcFiles repo-relative src paths
 * @returns {string[]} repo-relative test paths (deduped)
 */
export function mapToTests(root, srcFiles) {
  const tests = [];
  for (const src of srcFiles) {
    const base = src
      .split("/")
      .pop()
      .replace(/\.(js|ts|mjs|cjs)$/, "");
    const candidates = [`test/${base}.test.js`, `test/${base}.test.ts`];
    let found = false;
    for (const c of candidates) {
      if (existsSync(join(root, c))) {
        tests.push(c);
        found = true;
      }
    }
    if (!found) {
      try {
        for (const entry of readdirSync(join(root, "test"), { withFileTypes: true })) {
          if (!entry.isFile() || !/\.test\.(?:js|ts)$/.test(entry.name)) continue;
          const rel = `test/${entry.name}`;
          const path = join(root, rel);
          if (statSync(path).size <= 1024 * 1024 && readFileSync(path, "utf8").includes(base))
            tests.push(rel);
        }
      } catch {
        /* ignore — no mapping is not a failure */
      }
    }
  }
  return [...new Set(tests)];
}

// ── Tier 2: reverse dependency closure of the current atlas ─────────────────

/**
 * Walk resolved edges in the current atlas from changed files to all dependents.
 * The result is a scoped test plan. Dynamic dependencies may be absent.
 * @param {string} root repo root
 * @param {string[]} srcFiles repo-relative src paths
 * @returns {Promise<{files: string[], count: number, withoutTestPath: string[]} | null>} null when unmeasurable
 */
export async function blastRadius(root, srcFiles) {
  try {
    const { build, isStale, load } = await import("./atlas.js");
    const cached = load(root);
    const atlas = cached && !isStale(root, cached) ? cached : build({ root });
    if (atlas.capped || srcFiles.some((f) => !Object.hasOwn(atlas.fileHashes, f))) return null;
    if (
      atlas.coverage?.mode === "ast" &&
      (atlas.stats.imports.unresolved ||
        Object.values(atlas.coverage.byFile).some(
          (entry) => entry.reason || entry.limitations?.length,
        ))
    )
      return null; // a partial syntax dependency graph cannot certify a reduced suite
    const fileOf = new Map(atlas.nodes.map((node) => [node.id, node.file]));
    const dependents = new Map();
    const dependencies = new Map();
    for (const edge of atlas.edges) {
      if (edge.unresolved) continue;
      const source = fileOf.get(edge.source),
        target = fileOf.get(edge.target);
      if (!source || !target || source === target) continue;
      if (!dependents.has(target)) dependents.set(target, new Set());
      dependents.get(target).add(source);
      if (!dependencies.has(source)) dependencies.set(source, new Set());
      dependencies.get(source).add(target);
    }

    // A multi-source reverse traversal follows every measured file dependency.
    // Cycles terminate through the visited set. Ranking scores cannot prune a caller.
    const closure = (roots, edges) => {
      const reached = new Set(roots);
      for (const current of reached) {
        for (const next of edges.get(current) ?? []) reached.add(next);
      }
      return reached;
    };
    const files = [...closure(srcFiles, dependents)].sort();
    const tested = closure(
      files.filter((f) => TEST_FILE.test(f)),
      dependencies,
    );
    return { files, count: files.length, withoutTestPath: srcFiles.filter((f) => !tested.has(f)) };
  } catch {
    return null; // fail-safe: unknown → the caller escalates to high
  }
}

// ── The pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the tier pipeline over a changed-file list.
 * @param {{root?: string, files?: string[]}} opts
 * @returns {Promise<{tier: string, reason: string, tests: string[], lint: string[], typecheck: boolean, fullSuite: boolean}>}
 */
export async function selectTests({ root = process.cwd(), files = [] } = {}) {
  const result = classifyDeterministic(files);

  if (result.tier === "low" && result.tests.some((f) => !existsSync(join(root, f)))) {
    result.tier = "high";
    result.reason = "test file removed or renamed (fail-safe)";
    delete result.tests;
  }
  if (result.tier === "medium" && result.srcFiles) {
    const blast = await blastRadius(root, result.srcFiles);
    if (blast === null) {
      result.tier = "high";
      result.reason += " + blast radius unmeasurable (fail-safe)";
    } else {
      result.reason += ` + heuristic blast radius ${blast.count} file(s)`;
      // Blast-radius test files run directly; src files map to their tests by convention.
      const srcTargets = [...result.srcFiles, ...blast.files.filter((f) => SRC_FILE.test(f))];
      const testTargets = blast.files.filter((f) => TEST_FILE.test(f));
      result.tests = [...new Set([...testTargets, ...mapToTests(root, srcTargets)])].sort();
      if (
        !result.tests.length ||
        blast.withoutTestPath.some((f) => !mapToTests(root, [f]).length)
      ) {
        result.tier = "high";
        result.reason += " + no affected tests mapped (fail-safe)";
      }
    }
    delete result.srcFiles;
  }

  return {
    tier: result.tier,
    reason: result.reason,
    tests: result.tests || [],
    lint: result.tier === "cosmetic" ? files : [],
    typecheck: ["medium", "high"].includes(result.tier),
    fullSuite: result.tier === "high",
  };
}

// ── Changed-file resolution ──────────────────────────────────────────────────

/**
 * Resolve the changed-file list: explicit `--changed a,b`, a `--base/--head` diff,
 * or the working tree (staged + unstaged + untracked). Returns null when the tree
 * is CLEAN — empty scope means "nothing to select", never "run everything".
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
      return execFileSync("git", args, {
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
  if (base) {
    if (base.startsWith("-") || head?.startsWith("-")) return [];
    const out = git(["diff", "--name-only", "-z", `${base}...${head || "HEAD"}`, "--"]);
    return out ? out.split("\0").filter(Boolean) : [];
  }
  const files = new Set();
  const staged = git(["diff", "--cached", "--no-renames", "--name-only", "-z", "--"]);
  const unstaged = git(["diff", "--no-renames", "--name-only", "-z", "--"]);
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
export async function runTestSelect(argv) {
  const json = argv.includes("--json");
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const files = resolveChangedFiles(process.cwd(), {
    changed: flag("--changed"),
    base: flag("--base"),
    head: flag("--head"),
  });
  if (files === null) {
    const msg = "no changes in the working tree — nothing to select";
    if (json) console.log(JSON.stringify({ tier: "none", reason: msg, tests: [] }));
    else console.log(`  ${msg}.`);
    return;
  }
  const plan = await selectTests({ root: process.cwd(), files });
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
  if (plan.tier === "medium")
    console.log(
      "  note:       blast radius is heuristic (regex atlas) — it narrows, never certifies",
    );
  console.log(
    `\n  selection only — run the tests yourself, then \`${BRAND.cli} verify\` for the verdict.`,
  );
}
