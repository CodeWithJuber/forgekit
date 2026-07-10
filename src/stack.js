// forge stack — DYNAMIC stack detection. The atlas RULES table lists the languages forge
// can PARSE; this module answers the different question "what is THIS repo actually built
// with?" by reading the dependency manifests instead of guessing from a hardcoded menu.
// Everything is data: SIGNATURES maps a dependency/marker to a label, so widening coverage
// is adding a row, never editing logic. Fail-safe — an unreadable or absent manifest is
// skipped, never thrown.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (root, rel) => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
};
const readJson = (root, rel) => {
  const t = read(root, rel);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

// Dependency name → framework label. Exact match, except a trailing-slash entry
// (`@remix-run/`) which matches any dep under that scope. Ordered specific→general.
// Pure data.
const NODE_FRAMEWORKS = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@remix-run/", "Remix"],
  ["@angular/core", "Angular"],
  ["@nestjs/core", "NestJS"],
  ["svelte", "Svelte"],
  ["vue", "Vue"],
  ["react", "React"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["@hapi/hapi", "Hapi"],
  ["electron", "Electron"],
  ["react-native", "React Native"],
  ["gatsby", "Gatsby"],
  ["astro", "Astro"],
];
const NODE_TEST = [
  ["vitest", "vitest"],
  ["jest", "jest"],
  ["mocha", "mocha"],
  ["@playwright/test", "playwright test"],
  ["ava", "ava"],
];
const PY_FRAMEWORKS = [
  ["django", "Django"],
  ["flask", "Flask"],
  ["fastapi", "FastAPI"],
  ["starlette", "Starlette"],
  ["pyramid", "Pyramid"],
  ["tornado", "Tornado"],
];

// String blob (Python/Rust/…): plain substring test.
const hasAny = (hay, pairs) => {
  const out = [];
  for (const [needle, label] of pairs) if (hay.includes(needle)) out.push(label);
  return [...new Set(out)];
};

// Node dep NAMES (an array): EXACT element match, or startsWith for a scoped `@scope/`
// signature. Exact avoids `preact`→React / `next-auth`→Next.js false positives that a
// naive substring would cause; the prefix form catches `@remix-run/react` etc.
const hasAnyDep = (names, pairs) => {
  const out = [];
  for (const [needle, label] of pairs) {
    const hit = needle.endsWith("/")
      ? names.some((n) => n.startsWith(needle))
      : names.includes(needle);
    if (hit) out.push(label);
  }
  return [...new Set(out)];
};

function detectNode(root, add) {
  const pkg = readJson(root, "package.json");
  if (!pkg) return;
  add.language("JavaScript/TypeScript");
  add.evidence("package.json");
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const names = Object.keys(deps);
  if (existsSync(join(root, "tsconfig.json")) || names.some((n) => n === "typescript"))
    add.language("TypeScript");
  for (const f of hasAnyDep(names, NODE_FRAMEWORKS)) add.framework(f);
  for (const t of hasAnyDep(names, NODE_TEST)) add.testCmd(runnerCmd(root, t));
  // package manager from the lockfile present
  if (existsSync(join(root, "pnpm-lock.yaml"))) add.pm("pnpm");
  else if (existsSync(join(root, "yarn.lock"))) add.pm("yarn");
  else if (existsSync(join(root, "bun.lockb"))) add.pm("bun");
  else if (existsSync(join(root, "package-lock.json"))) add.pm("npm");
  // an explicit test script beats guessing
  if (pkg.scripts?.test) add.testCmd(`${pmRun(root)} test`);
}

const pmRun = (root) =>
  existsSync(join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(root, "yarn.lock"))
      ? "yarn"
      : existsSync(join(root, "bun.lockb"))
        ? "bun"
        : "npm";
const runnerCmd = (root, runner) =>
  runner === "npm test" ? `${pmRun(root)} test` : `npx ${runner}`;

function detectPython(root, add) {
  const pyproject = read(root, "pyproject.toml");
  const reqs = read(root, "requirements.txt");
  const pipfile = read(root, "Pipfile");
  const blob = [pyproject, reqs, pipfile].filter(Boolean).join("\n").toLowerCase();
  if (!blob && !existsSync(join(root, "setup.py"))) return;
  add.language("Python");
  if (pyproject) add.evidence("pyproject.toml");
  else if (reqs) add.evidence("requirements.txt");
  else if (pipfile) add.evidence("Pipfile");
  for (const f of hasAny(blob, PY_FRAMEWORKS)) add.framework(f);
  if (blob.includes("pytest") || existsSync(join(root, "pytest.ini"))) add.testCmd("pytest -q");
  else add.testCmd("python -m unittest");
  if (blob.includes("ruff")) add.tool("ruff");
  if (blob.includes("[tool.uv]") || existsSync(join(root, "uv.lock"))) add.pm("uv");
  else if (pipfile) add.pm("pipenv");
  else if (reqs || pyproject) add.pm("pip");
}

function detectGo(root, add) {
  const mod = read(root, "go.mod");
  if (mod == null) return;
  add.language("Go");
  add.evidence("go.mod");
  add.testCmd("go test ./...");
  const m = /^module\s+(\S+)/m.exec(mod);
  if (m) add.note(`module ${m[1]}`);
  if (/gin-gonic\/gin/.test(mod)) add.framework("Gin");
  if (/labstack\/echo/.test(mod)) add.framework("Echo");
  if (/gofiber\/fiber/.test(mod)) add.framework("Fiber");
}

function detectRust(root, add) {
  const cargo = read(root, "Cargo.toml");
  if (cargo == null) return;
  add.language("Rust");
  add.evidence("Cargo.toml");
  add.pm("cargo");
  add.testCmd("cargo test");
  if (/\bactix-web\b/.test(cargo)) add.framework("Actix");
  if (/\baxum\b/.test(cargo)) add.framework("Axum");
  if (/\brocket\b/.test(cargo)) add.framework("Rocket");
  if (/\btokio\b/.test(cargo)) add.note("tokio async runtime");
}

function detectRuby(root, add) {
  const gemfile = read(root, "Gemfile");
  if (gemfile == null && !existsSync(join(root, "Rakefile"))) return;
  add.language("Ruby");
  if (gemfile) add.evidence("Gemfile");
  add.pm("bundler");
  const g = (gemfile || "").toLowerCase();
  if (g.includes("rails")) add.framework("Rails");
  if (g.includes("sinatra")) add.framework("Sinatra");
  if (g.includes("rspec")) add.testCmd("bundle exec rspec");
  else add.testCmd("bundle exec rake test");
}

function detectPhp(root, add) {
  const composer = readJson(root, "composer.json");
  if (!composer) return;
  add.language("PHP");
  add.evidence("composer.json");
  add.pm("composer");
  const deps = Object.keys({
    ...(composer.require || {}),
    ...(composer["require-dev"] || {}),
  });
  if (deps.some((d) => d.startsWith("laravel/"))) add.framework("Laravel");
  if (deps.some((d) => d.startsWith("symfony/"))) add.framework("Symfony");
  if (deps.some((d) => d.includes("phpunit"))) add.testCmd("./vendor/bin/phpunit");
}

function detectJvm(root, add) {
  const pom = read(root, "pom.xml");
  const gradle = read(root, "build.gradle") || read(root, "build.gradle.kts");
  if (pom == null && gradle == null) return;
  const blob = [pom, gradle].filter(Boolean).join("\n").toLowerCase();
  // Kotlin DSL or kotlin plugin → Kotlin, else Java
  if (existsSync(join(root, "build.gradle.kts")) || blob.includes("kotlin")) add.language("Kotlin");
  add.language("Java");
  if (pom) {
    add.evidence("pom.xml");
    add.pm("Maven");
    add.testCmd("mvn test");
  } else {
    add.evidence(existsSync(join(root, "build.gradle.kts")) ? "build.gradle.kts" : "build.gradle");
    add.pm("Gradle");
    add.testCmd("./gradlew test");
  }
  if (blob.includes("springframework") || blob.includes("spring-boot")) add.framework("Spring");
}

function detectDotnet(root, add) {
  let files = [];
  try {
    files = readdirSync(root);
  } catch {}
  const proj = files.find(
    (f) => f.endsWith(".csproj") || f.endsWith(".sln") || f.endsWith(".fsproj"),
  );
  if (!proj) return;
  add.language(proj.endsWith(".fsproj") ? "F#" : "C#");
  add.evidence(proj);
  add.pm("dotnet");
  add.testCmd("dotnet test");
}

const DETECTORS = [
  detectNode,
  detectPython,
  detectGo,
  detectRust,
  detectRuby,
  detectPhp,
  detectJvm,
  detectDotnet,
];

/**
 * Detect the repo's real stack by reading its manifests. Pure aside from fs reads;
 * every detector is fail-safe. Returns deduped, deterministic (sorted) arrays.
 * @param {string} [root]
 * @returns {{languages:string[], frameworks:string[], packageManagers:string[],
 *   testCommands:string[], tools:string[], notes:string[], evidence:string[]}}
 */
export function detectStack(root = process.cwd()) {
  const sets = {
    languages: new Set(),
    frameworks: new Set(),
    packageManagers: new Set(),
    testCommands: new Set(),
    tools: new Set(),
    notes: new Set(),
    evidence: new Set(),
  };
  const add = {
    language: (v) => v && sets.languages.add(v),
    framework: (v) => v && sets.frameworks.add(v),
    pm: (v) => v && sets.packageManagers.add(v),
    testCmd: (v) => v && sets.testCommands.add(v),
    tool: (v) => v && sets.tools.add(v),
    note: (v) => v && sets.notes.add(v),
    evidence: (v) => v && sets.evidence.add(v),
  };
  for (const d of DETECTORS) {
    try {
      d(root, add);
    } catch {}
  }
  const sort = (s) => [...s].sort();
  return {
    languages: sort(sets.languages),
    frameworks: sort(sets.frameworks),
    packageManagers: sort(sets.packageManagers),
    testCommands: sort(sets.testCommands),
    tools: sort(sets.tools),
    notes: sort(sets.notes),
    evidence: sort(sets.evidence),
  };
}
