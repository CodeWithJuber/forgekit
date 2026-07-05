// forge verify — the independent verification layer. Deterministic-first and
// cross-tool: it trusts the project's OWN tests (never a benchmark number) and
// reuses `atlas` to flag calls to symbols that exist nowhere in the codebase
// (a cheap, zero-LLM hallucination signal). It emits a provenance stamp so a
// reviewer reads WHAT was checked, not the authoring transcript.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as loadAtlas, build as buildAtlas, has } from "./atlas.js";

// Called identifiers that are language/runtime built-ins, not project symbols.
const IGNORE = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "typeof",
  "await",
  "super",
  "new",
  "delete",
  "void",
  "yield",
  "import",
  "export",
  "require",
  "print",
  "range",
  "len",
  "str",
  "int",
  "float",
  "list",
  "dict",
  "set",
  "tuple",
  "bool",
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Set",
  "Map",
  "WeakMap",
  "Date",
  "Error",
  "RegExp",
  "Symbol",
  "Buffer",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "fetch",
  "structuredClone",
  "process",
  "assert",
]);

/** Pure: called identifiers in a block of source (skips `.method(` calls). */
export function extractCalledSymbols(text) {
  const found = new Set();
  const re = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const line of String(text).split("\n")) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const name = m[1];
      if (!IGNORE.has(name)) found.add(name);
    }
  }
  return [...found];
}

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

// Run the project's own tests (JS or Python). The gate trusts these, not a benchmark.
function runTests(cwd) {
  try {
    if (existsSync(join(cwd, "package.json"))) {
      execFileSync("npm", ["test"], { cwd, encoding: "utf8", stdio: "pipe" });
      return { ran: true, passed: true, runner: "npm test" };
    }
    if (
      existsSync(join(cwd, "pyproject.toml")) ||
      existsSync(join(cwd, "pytest.ini"))
    ) {
      execFileSync("pytest", ["-q"], { cwd, encoding: "utf8", stdio: "pipe" });
      return { ran: true, passed: true, runner: "pytest" };
    }
    return { ran: false };
  } catch (e) {
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
  const changedFiles = git(["diff", "--name-only", base], targetRoot)
    .split("\n")
    .filter(Boolean);

  const atlas = loadAtlas(targetRoot) || buildAtlas({ root: targetRoot });
  const symbols = extractCalledSymbols(added);
  const unknown = findUnknownSymbols(atlas, symbols);
  const tests = runTests(targetRoot);

  const provenance = {
    base,
    changedFiles,
    tests,
    symbolsChecked: symbols.length,
    unknownSymbols: unknown,
  };
  mkdirSync(join(targetRoot, ".forge"), { recursive: true });
  writeFileSync(
    join(targetRoot, ".forge", "provenance.json"),
    JSON.stringify(provenance, null, 2),
  );

  // Hard gate = the project's own tests. Unknown symbols are advisory (heuristic).
  const ok = tests.ran ? tests.passed === true : true;
  return { ok, provenance, unknown, tests, changedFiles };
}
