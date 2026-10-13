#!/usr/bin/env node
/**
 * smart-test-select.mjs — Honest AI-assisted test selection for forgekit.
 *
 * Thin CLI wrapper over `src/test_select.js` (the canonical tier implementation,
 * also shipped as `forge test-select`). This script keeps the exact JSON contract
 * the workspace push gate (`~/workspace/push_gate.py`) consumes, plus the
 * workspace-only LLM refinement tier (needs the openrouter skill; skipped when
 * absent — `forge test-select` runs the deterministic + impact tiers only).
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
 *   node scripts/smart-test-select.mjs --base main --head HEAD  (git diff)
 *
 * Output: JSON { tier, tests: [...], lint: [...], typecheck: bool, reason }
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectTests } from "../src/test_select.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// ── Tier 3: OpenRouter classification (workspace-only refinement) ────────────

async function classifyWithLLM(files, _reason) {
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

  const plan = await selectTests({ root: ROOT, files });

  // Tier 3: LLM refinement for the medium tier only (workspace skill present?).
  // The deterministic + impact tiers already ran inside selectTests; the LLM can
  // only narrow (cosmetic) or escalate (behavioral/uncertain) — never widen a pass.
  if (plan.tier === "medium") {
    const classification = await classifyWithLLM(files, plan.reason);
    if (classification === "behavioral") {
      plan.tier = "high";
      plan.reason += " + LLM: behavioral change";
      plan.fullSuite = true;
    } else if (classification === "cosmetic") {
      plan.tier = "cosmetic";
      plan.reason += " + LLM: cosmetic";
      plan.tests = [];
      plan.lint = files;
      plan.typecheck = false;
      plan.fullSuite = false;
    } else if (classification === "uncertain") {
      plan.tier = "high";
      plan.reason += " + LLM: uncertain (fail-safe)";
      plan.fullSuite = true;
    }
    // null = LLM unavailable, keep medium
  }

  console.log(JSON.stringify(plan, null, 2));
}

// Only run the CLI when executed as a script (not when imported).
const invokedAsScript = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
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
}
