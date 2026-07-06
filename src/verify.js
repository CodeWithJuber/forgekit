// forge verify — the independent verification layer. Deterministic-first and
// cross-tool: it trusts the project's OWN tests (never a benchmark number) and
// reuses `atlas` to flag calls to symbols that exist nowhere in the codebase
// (a cheap, zero-LLM hallucination signal). It emits a provenance stamp so a
// reviewer reads WHAT was checked, not the authoring transcript.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build as buildAtlas, has, isStale, load as loadAtlas } from "./atlas.js";

// Shared call-site extractor — one source of truth with atlas.js (they used to duplicate this).
export { extractCalledSymbols } from "./extract.js";

import { extractCalledSymbols } from "./extract.js";

/** Pure: which called symbols are defined nowhere in the atlas (possible hallucinations). */
export function findUnknownSymbols(atlas, symbols) {
  return symbols.filter((s) => !has(atlas, s));
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch {
    return "";
  }
}

// Run the project's own tests (JS or Python). The gate trusts these, not a benchmark. Bounded by
// a timeout (FORGE_VERIFY_TIMEOUT_MS, default 10 min) so a hanging test can't hang the gate — a
// timeout is reported as an honest "did not complete", never as a pass.
function runTests(cwd) {
  const timeout = Number(process.env.FORGE_VERIFY_TIMEOUT_MS) || 600000;
  const run = (cmd, args) =>
    execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe", timeout });
  try {
    if (existsSync(join(cwd, "package.json"))) {
      run("npm", ["test"]);
      return { ran: true, passed: true, runner: "npm test" };
    }
    if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini"))) {
      run("pytest", ["-q"]);
      return { ran: true, passed: true, runner: "pytest" };
    }
    return { ran: false };
  } catch (e) {
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
      return { ran: true, passed: false, timedOut: true, output: `test run exceeded ${timeout}ms` };
    }
    return {
      ran: true,
      passed: false,
      output: String(e.stdout || e.message || "").slice(-600),
    };
  }
}

export function verify({ targetRoot = process.cwd(), base = "HEAD" } = {}) {
  const diff =
    git(["diff", "--unified=0", base], targetRoot) ||
    git(["diff", "--unified=0", "--cached"], targetRoot);
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  const changedFiles = git(["diff", "--name-only", base], targetRoot).split("\n").filter(Boolean);

  // Verify runs AFTER edits — a cached, stale atlas would miss newly-added-but-undefined symbols
  // (false negatives) or flag just-defined ones (false positives). Rebuild when stale; the
  // incremental build only re-parses the files that changed, so this stays cheap.
  const cached = loadAtlas(targetRoot);
  const atlas = cached && !isStale(targetRoot, cached) ? cached : buildAtlas({ root: targetRoot });
  const symbols = extractCalledSymbols(added);
  // When the graph was capped (huge repo, files dropped), "defined nowhere" is unreliable — a
  // symbol may live in a dropped file — so don't assert hallucinations.
  const unknown = atlas.capped ? [] : findUnknownSymbols(atlas, symbols);
  const tests = runTests(targetRoot);

  const provenance = {
    base,
    changedFiles,
    tests,
    symbolsChecked: symbols.length,
    unknownSymbols: unknown,
  };
  mkdirSync(join(targetRoot, ".forge"), { recursive: true });
  writeFileSync(join(targetRoot, ".forge", "provenance.json"), JSON.stringify(provenance, null, 2));

  // Hard gate = the project's own tests. Unknown symbols are advisory (heuristic).
  const ok = tests.ran ? tests.passed === true : true;
  return { ok, provenance, unknown, tests, changedFiles };
}
