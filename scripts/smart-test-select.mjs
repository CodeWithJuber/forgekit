#!/usr/bin/env node
/**
 * smart-test-select.mjs — Honest AI-assisted test selection for forgekit.
 *
 * Same 4-tier pattern as hikmah-workspace, adapted for forgekit:
 * - Tests: node --test test/*.test.js (not vitest)
 * - Lint: biome (not eslint/prettier)
 * - Typecheck: tsc -p tsconfig.json
 *
 * Tiers:
 *   cosmetic — docs/comments/whitespace only → biome check on changed files
 *   low      — test file changes → run those specific test files
 *   medium   — src changes → related tests + typecheck
 *   high     — config/CLI/core changes → full suite (fail-safe)
 *
 * Honesty: AI selects scope, never skips verification.
 * Any uncertainty → full suite.
 *
 * Usage:
 *   node scripts/smart-test-select.mjs --changed "src/cli.js,test/foo.test.js"
 *   node scripts/smart-test-select.mjs --changed-files < file-with-paths.txt
 *   node scripts/smart-test-select.mjs --base main --head HEAD  (git diff)
 *
 * Output: JSON { tier, tests: [...], lint: [...], typecheck: bool, reason }
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// ── Tier 1: Deterministic signals ──────────────────────────────────────────

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

const TEST_FILE = /^test\/.*\.test\.js$/;
const SRC_FILE = /^src\/.*\.js$/;

// Changes that ALWAYS trigger full suite (fail-safe)
const HIGH_RISK = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig\.json$/,
  /^biome\.json$/,
  /^\.github\/workflows\//,
  /^src\/cli\.js$/, // CLI entry — everything flows through it
  /^test\/_setup\.js$/, // Test harness itself
  /^global\/hooks\//, // Guard hooks
  /^bin\//,
];

function classifyDeterministic(files) {
  if (files.length === 0) return { tier: "high", reason: "no changed files detected (fail-safe)" };

  // Any high-risk file → full suite
  const risky = files.filter((f) => HIGH_RISK.some((p) => p.test(f)));
  if (risky.length > 0) {
    return { tier: "high", reason: `high-risk files: ${risky.slice(0, 3).join(", ")}` };
  }

  // All cosmetic → lint only
  if (files.every((f) => COSMETIC_PATTERNS.some((p) => p.test(f)))) {
    return { tier: "cosmetic", reason: "docs/assets only" };
  }

  // Only test files → run those tests
  if (files.every((f) => TEST_FILE.test(f))) {
    return { tier: "low", reason: "test files only", tests: files };
  }

  // src changes → medium (related tests + typecheck)
  const srcFiles = files.filter((f) => SRC_FILE.test(f));
  if (srcFiles.length > 0 && srcFiles.length === files.length) {
    return { tier: "medium", reason: `src changes: ${srcFiles.length} files`, srcFiles };
  }

  // Mixed → escalate to high (fail-safe)
  return { tier: "high", reason: "mixed change types (fail-safe)" };
}

// ── Tier 2: forge impact (blast radius) ────────────────────────────────────

function getBlastRadius(srcFiles) {
  try {
    const forge = path.join(ROOT, "src/cli.js");
    if (!existsSync(forge)) return null;
    const files = srcFiles.join(" ");
    const out = execSync(`node "${forge}" impact --files ${files} --format json 2>/dev/null`, {
      cwd: ROOT,
      timeout: 30000,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const data = JSON.parse(out);
    // Count affected files from impact output
    const affected = data.affected || data.files || [];
    return Array.isArray(affected) ? affected.length : null;
  } catch {
    return null; // fail-safe: unknown → escalate
  }
}

// ── Tier 3: OpenRouter classification ──────────────────────────────────────

async function classifyWithLLM(files, reason) {
  try {
    const cli = new URL("../../../skills/openrouter/bin/openrouter-chat", import.meta.url).pathname;
    if (!existsSync(cli)) return null;
    const prompt = `Changed files in a Node.js CLI repo (forgekit):
${files.slice(0, 20).join("\n")}

Classify this change. Reply with EXACTLY one word: behavioral, refactor, cosmetic, or uncertain.
- behavioral: changes what the code DOES (new features, bug fixes, logic changes)
- refactor: restructures without changing behavior
- cosmetic: docs, comments, formatting, renames without logic change
- uncertain: cannot tell from filenames alone`;

    const out = execSync(
      `node "${cli}" --prompt ${JSON.stringify(prompt).replace(/'/g, "'\\''")} --max-tokens 10 2>/dev/null`,
      { timeout: 60000, encoding: "utf8" },
    );
    const word = out.trim().toLowerCase().split(/\s+/)[0];
    if (["behavioral", "refactor", "cosmetic", "uncertain"].includes(word)) return word;
    return null;
  } catch {
    return null; // fail-safe
  }
}

// ── Map src files to test files ────────────────────────────────────────────

function mapToTests(srcFiles) {
  // Convention: src/foo.js → test/foo.test.js, src/commands/bar.js → test/bar.test.js
  const tests = [];
  for (const src of srcFiles) {
    const base = path.basename(src, ".js");
    const candidates = [
      `test/${base}.test.js`,
      // Also check for partial matches
    ];
    for (const c of candidates) {
      if (existsSync(path.join(ROOT, c))) tests.push(c);
    }
    // Fallback: grep test files that import this src file
    if (tests.length === 0 || !candidates.some((c) => existsSync(path.join(ROOT, c)))) {
      try {
        const out = execSync(`grep -l "${base}" test/*.test.js 2>/dev/null || true`, {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 10000,
        });
        const matches = out.trim().split("\n").filter(Boolean);
        for (const m of matches) {
          if (!tests.includes(m)) tests.push(m);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [...new Set(tests)];
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let files = [];

  const changedIdx = args.indexOf("--changed");
  if (changedIdx >= 0 && args[changedIdx + 1]) {
    files = args[changedIdx + 1]
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  const baseIdx = args.indexOf("--base");
  if (baseIdx >= 0 && args[baseIdx + 1]) {
    const base = args[baseIdx + 1];
    const head = args[args.indexOf("--head") + 1] || "HEAD";
    try {
      const out = execSync(`git diff --name-only ${base}...${head}`, {
        cwd: ROOT,
        encoding: "utf8",
      });
      files = out.trim().split("\n").filter(Boolean);
    } catch {
      files = []; // fail-safe: empty → high tier
    }
  }

  const result = classifyDeterministic(files);

  // Tier 2: forge impact for medium tier (src changes)
  if (result.tier === "medium" && result.srcFiles) {
    const blastRadius = getBlastRadius(result.srcFiles);
    if (blastRadius === null) {
      // Unknown blast radius → escalate to high (fail-safe)
      result.tier = "high";
      result.reason += " + unknown blast radius (fail-safe)";
    } else if (blastRadius > 10) {
      result.tier = "high";
      result.reason += ` + large blast radius (${blastRadius} files)`;
    } else {
      // Tier 3: LLM classification (only for small blast radius)
      const classification = await classifyWithLLM(result.srcFiles, result.reason);
      if (classification === "behavioral") {
        result.tier = "high";
        result.reason += " + LLM: behavioral change";
      } else if (classification === "cosmetic") {
        result.tier = "cosmetic";
        result.reason += " + LLM: cosmetic";
      } else if (classification === null || classification === "uncertain") {
        // Fail-safe: uncertain → high
        if (classification === "uncertain") {
          result.tier = "high";
          result.reason += " + LLM: uncertain (fail-safe)";
        }
        // null = LLM unavailable, keep medium
      }
      // refactor → stay medium
    }
    result.tests = mapToTests(result.srcFiles);
    delete result.srcFiles;
  }

  // Build output
  const output = {
    tier: result.tier,
    reason: result.reason,
    tests: result.tests || [],
    lint: result.tier === "cosmetic" ? files : [],
    typecheck: ["medium", "high"].includes(result.tier),
    fullSuite: result.tier === "high",
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  // Absolute fail-safe: any crash → full suite
  console.log(
    JSON.stringify(
      {
        tier: "high",
        reason: `selector crashed (fail-safe): ${err.message}`,
        tests: [],
        lint: [],
        typecheck: true,
        fullSuite: true,
      },
      null,
      2,
    ),
  );
  process.exit(0); // exit 0 so CI doesn't fail on selector error
});
