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
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { heading } from "./cli/shared.js";

// ── Tier 1: deterministic signals ────────────────────────────────────────────

const COSMETIC_PATTERNS = [
  /\.md$/,
  /\.mdx$/,
  /\.txt$/,
  /\.rst$/,
  /^(docs|mintlify|landing)\//,
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
        const out = execSync(
          `grep -l "${base}" test/*.test.js test/*.test.ts 2>/dev/null || true`,
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10000,
          },
        );
        for (const m of out.trim().split("\n").filter(Boolean)) {
          if (!tests.includes(m)) tests.push(m);
        }
      } catch {
        /* ignore — no mapping is not a failure */
      }
    }
  }
  return [...new Set(tests)];
}

// ── Tier 2: blast radius via the real impact API (heuristic) ─────────────────

/**
 * Union of `forge impact` over the changed src files, via the impact module
 * directly (not the CLI). HEURISTIC: the atlas is regex-derived; the result
 * narrows the test run, it never certifies the change.
 * @param {string} root repo root
 * @param {string[]} srcFiles repo-relative src paths
 * @returns {Promise<{files: string[], count: number} | null>} null when unmeasurable
 */
export async function blastRadius(root, srcFiles) {
  try {
    const { predictImpact } = await import("./substrate.js");
    const union = new Set();
    for (const f of srcFiles) {
      // basic: fixed threshold, no hazard enhancements — fast, and honest about
      // being the heuristic leg (the hazard-weighted walk is verify's job).
      const r = predictImpact(root, f, { basic: true });
      // found === false means the atlas cannot see the file at all (unbuilt atlas,
      // unresolvable target) — that is UNMEASURABLE, not "no impact". Fail safe.
      if (r?.found !== true) return null;
      for (const hit of r?.impactedFiles ?? []) union.add(hit);
      union.add(f);
    }
    const files = [...union].sort();
    return { files, count: files.length };
  } catch {
    return null; // fail-safe: unknown → the caller escalates to high
  }
}

// ── The pipeline ─────────────────────────────────────────────────────────────

const BLAST_RADIUS_ESCALATION = 10;

/**
 * Run the tier pipeline over a changed-file list.
 * @param {{root?: string, files?: string[]}} opts
 * @returns {Promise<{tier: string, reason: string, tests: string[], lint: string[], typecheck: boolean, fullSuite: boolean}>}
 */
export async function selectTests({ root = process.cwd(), files = [] } = {}) {
  const result = classifyDeterministic(files);

  if (result.tier === "medium" && result.srcFiles) {
    const blast = await blastRadius(root, result.srcFiles);
    if (blast === null) {
      result.tier = "high";
      result.reason += " + blast radius unmeasurable (fail-safe)";
    } else if (blast.count > BLAST_RADIUS_ESCALATION) {
      result.tier = "high";
      result.reason += ` + large heuristic blast radius (${blast.count} files)`;
    } else {
      result.reason += ` + heuristic blast radius ${blast.count} file(s)`;
      // Blast-radius test files run directly; src files map to their tests by convention.
      const srcTargets = [...result.srcFiles, ...blast.files.filter((f) => SRC_FILE.test(f))];
      const testTargets = blast.files.filter((f) => TEST_FILE.test(f));
      result.tests = [...new Set([...testTargets, ...mapToTests(root, srcTargets)])].sort();
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
  if (changed)
    return changed
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  const git = (args) => {
    try {
      return execSync(`git ${args}`, {
        cwd,
        encoding: "utf8",
        timeout: 15000,
      }).trim();
    } catch {
      return null;
    }
  };
  if (base) {
    const out = git(`diff --name-only ${base}...${head || "HEAD"}`);
    return out ? out.split("\n").filter(Boolean) : [];
  }
  const files = new Set();
  const staged = git("diff --cached --name-only");
  const unstaged = git("diff --name-only");
  const untracked = git("ls-files --others --exclude-standard");
  for (const out of [staged, unstaged, untracked]) {
    if (out) for (const f of out.split("\n").filter(Boolean)) files.add(f);
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
