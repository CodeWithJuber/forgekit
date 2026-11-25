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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveChangedFiles, selectTests } from "../src/test_select.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── Tier 3: OpenRouter classification (workspace-only refinement) ────────────

async function classifyWithLLM(files, _reason) {
  try {
    const cli = fileURLToPath(
      new URL("../../../skills/openrouter/bin/openrouter-chat", import.meta.url),
    );
    if (!existsSync(cli)) return null;
    const prompt = `Changed files in a Node.js CLI repo (forgekit):
${files.slice(0, 20).join("\n")}

Classify this change. Reply with EXACTLY one word: behavioral, refactor, cosmetic, or uncertain.
- behavioral: changes what the code DOES (new features, bug fixes, logic changes)
- refactor: restructures without changing behavior
- cosmetic: docs, comments, formatting, renames without logic change
- uncertain: cannot tell from filenames alone`;

    const out = execFileSync(process.execPath, [cli, "--prompt", prompt, "--max-tokens", "10"], {
      timeout: 60000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
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
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const files =
    args.includes("--base") || args.includes("--changed")
      ? (resolveChangedFiles(ROOT, {
          base: value("--base"),
          head: value("--head"),
          changed: value("--changed"),
        }) ?? [])
      : [];

  const plan = await selectTests({ root: ROOT, files });

  if (plan.tier === "medium") {
    const classification = await classifyWithLLM(files, plan.reason);
    if (classification === "behavioral" || classification === "uncertain") {
      plan.tier = "high";
      plan.reason += ` + LLM: ${classification}`;
      plan.fullSuite = true;
    }
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
