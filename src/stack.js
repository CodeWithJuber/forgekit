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

// The script `npm init` writes. It is a placeholder, not a suite: running it "fails" every
// time, which would turn every freshly-initialised workspace package into a false FAIL.
const NPM_PLACEHOLDER_TEST = /no test specified/;

/** The package's declared `scripts.test`, or null when absent or npm's placeholder. */
export function declaredTestScript(pkg) {
  const script = pkg?.scripts?.test;
  return typeof script === "string" && script.trim() && !NPM_PLACEHOLDER_TEST.test(script)
    ? script
    : null;
}

function detectNode(root, add, { pmRoot = root } = {}) {
  const pkg = readJson(root, "package.json");
  if (!pkg) return;
  add.language("JavaScript/TypeScript");
  add.evidence("package.json");
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const names = Object.keys(deps);
  if (existsSync(join(root, "tsconfig.json")) || names.some((n) => n === "typescript"))
    add.language("TypeScript");
  for (const f of hasAnyDep(names, NODE_FRAMEWORKS)) add.framework(f);
  // package manager from the lockfile present
  if (existsSync(join(root, "pnpm-lock.yaml"))) add.pm("pnpm");
  else if (existsSync(join(root, "yarn.lock"))) add.pm("yarn");
  else if (existsSync(join(root, "bun.lockb"))) add.pm("bun");
  else if (existsSync(join(root, "package-lock.json"))) add.pm("npm");
  // A runner found in the dependencies is INVENTORY — a tool that is available — not a
  // suite someone declared (review F09). With an explicit `scripts.test`, that script IS
  // the suite (`"test": "vitest run"` already runs vitest), so the dependency must not
  // become a second, report-only obligation that turns a passing run INCOMPLETE. Only
  // when nothing is declared does an installed runner stand in as the (report-only)
  // suite. npx-based detections stay label-only either way: forge never EXECUTES npx (it
  // can download arbitrary packages), so no bin/args descriptor is emitted for them.
  const script = declaredTestScript(pkg);
  for (const t of hasAnyDep(names, NODE_TEST)) {
    const label = runnerCmd(pmRoot, t);
    if (script) add.inventory(label);
    else add.runner({ label });
  }
  // an explicit test script beats guessing — executable via the DETECTED package manager
  // (a workspace package uses the monorepo root's lockfile, hence pmRoot)
  if (script)
    add.runner({
      bin: pmRun(pmRoot),
      args: ["test"],
      label: `${pmRun(pmRoot)} test`,
    });
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
  if (blob.includes("pytest") || existsSync(join(root, "pytest.ini")))
    add.runner({ bin: "pytest", args: ["-q"], label: "pytest -q" });
  else add.runner({ label: "python -m unittest" });
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
  add.runner({ bin: "go", args: ["test", "./..."], label: "go test ./..." });
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
  add.runner({ bin: "cargo", args: ["test"], label: "cargo test" });
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
  if (g.includes("rspec"))
    add.runner({
      bin: "bundle",
      args: ["exec", "rspec"],
      label: "bundle exec rspec",
    });
  else
    add.runner({
      bin: "bundle",
      args: ["exec", "rake", "test"],
      label: "bundle exec rake test",
    });
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
  if (deps.some((d) => d.includes("phpunit")))
    add.runner({
      bin: "./vendor/bin/phpunit",
      args: [],
      label: "./vendor/bin/phpunit",
    });
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
    add.runner({ bin: "mvn", args: ["test"], label: "mvn test" });
  } else {
    add.evidence(existsSync(join(root, "build.gradle.kts")) ? "build.gradle.kts" : "build.gradle");
    add.pm("Gradle");
    add.runner({ bin: "./gradlew", args: ["test"], label: "./gradlew test" });
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
  add.runner({ bin: "dotnet", args: ["test"], label: "dotnet test" });
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

// ---------------------------------------------------------------------------
// Monorepo / workspace detection (ME-03). The DETECTORS above read manifests only at
// the repo ROOT, so npm/pnpm/yarn workspaces and Turborepo/lerna/Maven/Gradle
// subprojects (and nested Python packages) are invisible — a single root test command
// may or may not cover them, and forge never verified that. This surfaces the declared
// workspace globs (`workspaces`) and the nested package roots actually on disk
// (`packageRoots`) so the caller/verifier can see there is more than one suite. It is
// deliberately BOUNDED — a shallow, budgeted BFS, never a deep walk of a huge tree.
// ---------------------------------------------------------------------------

// Manifests that mark a directory as its own package/suite root.
const WORKSPACE_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
];
// Never descend into these — vendored deps, VCS metadata, build output, caches.
const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".forge",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
]);
const MONO_MAX_DEPTH = 3; // deepest nested dir considered (e.g. apps/web, packages/*/pkg)
const MONO_SCAN_BUDGET = 200; // hard ceiling on dirs stat-ed — bounds cost on large trees
const MONO_MAX_ROOTS = 50; // most nested package roots surfaced

// Zero-dep: pull the `packages:` list from a pnpm-workspace.yaml. Ignores negations (`!…`).
function parsePnpmPackages(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const m = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v && !v.startsWith("!")) out.push(v);
    } else if (/^\S/.test(line)) {
      inBlock = false; // a new top-level key ends the list
    }
  }
  return out;
}

// Declared workspace globs from every root config that declares them. Never throws.
function workspaceGlobs(root) {
  const globs = new Set();
  const pkg = readJson(root, "package.json");
  if (pkg) {
    const ws = pkg.workspaces;
    const arr = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
    for (const g of arr) if (typeof g === "string") globs.add(g);
  }
  const lerna = readJson(root, "lerna.json");
  if (lerna && Array.isArray(lerna.packages))
    for (const g of lerna.packages) if (typeof g === "string") globs.add(g);
  const pnpm = read(root, "pnpm-workspace.yaml");
  if (pnpm) for (const g of parsePnpmPackages(pnpm)) globs.add(g);
  return [...globs].sort();
}

// Bounded BFS for nested package roots below `root`. Returns POSIX-relative dir paths,
// deduped and sorted. Never descends past MONO_MAX_DEPTH, never stats more than
// MONO_SCAN_BUDGET dirs, never returns more than MONO_MAX_ROOTS — so a giant repo is
// sampled, never fully walked. Fail-safe: an unreadable dir is skipped. `truncated` says
// the walk stopped early (budget or root cap): the list is then a SAMPLE, and nothing may
// claim every package was covered (review F08).
function scanPackageRoots(root) {
  const found = [];
  let budget = MONO_SCAN_BUDGET;
  /** @type {{dir:string, rel:string, depth:number}[]} */
  const queue = [];
  const enqueueChildren = (absDir, relDir, depth) => {
    if (depth > MONO_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || WALK_SKIP.has(e.name)) continue;
      queue.push({
        dir: join(absDir, e.name),
        rel: relDir ? `${relDir}/${e.name}` : e.name,
        depth,
      });
    }
  };
  enqueueChildren(root, "", 1);
  while (queue.length && budget > 0 && found.length < MONO_MAX_ROOTS) {
    const { dir, rel, depth } = queue.shift();
    budget--;
    if (WORKSPACE_MANIFESTS.some((m) => existsSync(join(dir, m)))) found.push(rel);
    enqueueChildren(dir, rel, depth + 1);
  }
  return { roots: [...new Set(found)].sort(), truncated: queue.length > 0 };
}

/**
 * Does a workspace glob (`packages/*`, `apps/**`, `libs/core`) name this package dir?
 * `*` matches one path segment, `**` any number. Pure.
 * @param {string} glob @param {string} rel POSIX path relative to the repo root
 */
export function matchesWorkspaceGlob(glob, rel) {
  const g = String(glob).replace(/^\.\//, "").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      // `**/` = zero or more whole segments; a trailing `**` = anything below
      const slash = g[i + 2] === "/";
      re += slash ? "(?:[^/]+/)*" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(String(rel).replace(/\/+$/, ""));
}

// A root test script that runs EVERY workspace's suite itself — so a nested package that is a
// declared workspace member is covered by the root run and must not be run twice.
const RECURSIVE_TEST_RE =
  /(?:^|\s)(?:--workspaces|-ws|--recursive|-r)(?:\s|$)|\bworkspaces\s+foreach\b|\bturbo\s+(?:run\s+)?test\b|\blerna\s+run\s+test\b|\bnx\s+run-many\b/;

/** Whether the root's declared test script runs every declared workspace's tests. Pure
 *  w.r.t. the tree (reads package.json). */
export function rootTestCoversWorkspaces(root) {
  const script = declaredTestScript(readJson(root, "package.json"));
  return !!script && RECURSIVE_TEST_RE.test(script);
}

/**
 * The runners ONE directory declares — the manifest detectors only, no workspace walk.
 * `pmRoot` is where the package manager's lockfile lives (a workspace package installs
 * through the monorepo root). Used for per-package suites in a monorepo (review F08).
 * @param {string} dir
 * @param {{pmRoot?: string}} [opts]
 * @returns {TestRunner[]}
 */
export function detectRunners(dir, { pmRoot = dir } = {}) {
  return collect(dir, { pmRoot }).testRunners;
}

/**
 * One detected test runner. `label` is the human-readable command string (always
 * mirrored into `testCommands` for back-compat). `bin`/`args` are the structured,
 * shell-free spawn descriptor — present only when the command is safe to execute
 * verbatim (label-only entries, e.g. `npx vitest` or `python -m unittest`, are
 * report-only: forge never executes them).
 * @typedef {object} TestRunner
 * @property {string} label
 * @property {string} [bin]
 * @property {string[]} [args]
 */

// Run every manifest detector over ONE directory. Fail-safe per detector.
function collect(root, { pmRoot = root } = {}) {
  const sets = {
    languages: new Set(),
    frameworks: new Set(),
    packageManagers: new Set(),
    testCommands: new Set(),
    testInventory: new Set(),
    tools: new Set(),
    notes: new Set(),
    evidence: new Set(),
  };
  /** @type {Map<string, TestRunner>} */
  const runners = new Map();
  const add = {
    language: (v) => v && sets.languages.add(v),
    framework: (v) => v && sets.frameworks.add(v),
    pm: (v) => v && sets.packageManagers.add(v),
    testCmd: (v) => v && sets.testCommands.add(v),
    /** @param {TestRunner} r structured descriptor — the label also lands in testCommands */
    runner: (r) => {
      if (!r?.label) return;
      sets.testCommands.add(r.label);
      sets.testInventory.add(r.label);
      if (!runners.has(r.label)) runners.set(r.label, r);
    },
    /** an AVAILABLE runner that no declaration requires (inventory only, never a suite) */
    inventory: (v) => v && sets.testInventory.add(v),
    tool: (v) => v && sets.tools.add(v),
    note: (v) => v && sets.notes.add(v),
    evidence: (v) => v && sets.evidence.add(v),
  };
  for (const d of DETECTORS) {
    try {
      d(root, add, { pmRoot });
    } catch {}
  }
  const sort = (s) => [...s].sort();
  return {
    languages: sort(sets.languages),
    frameworks: sort(sets.frameworks),
    packageManagers: sort(sets.packageManagers),
    testCommands: sort(sets.testCommands),
    testRunners: [...runners.values()].sort((a, b) => a.label.localeCompare(b.label)),
    testInventory: sort(sets.testInventory),
    tools: sort(sets.tools),
    notes: sort(sets.notes),
    evidence: sort(sets.evidence),
  };
}

/**
 * Detect the repo's real stack by reading its manifests. Pure aside from fs reads;
 * every detector is fail-safe. Returns deduped, deterministic (sorted) arrays;
 * `testRunners` is deduped by label and sorted by label.
 * `testCommands`/`testRunners` are the REQUIRED suites (what a declaration asks for:
 * an explicit `scripts.test`, a pytest config, go.mod…); `testInventory` is every runner
 * DETECTED, including ones merely installed as a dependency (review F09) — inventory is
 * never an extra obligation.
 * Additive monorepo fields (ME-03): `workspaces` are the declared workspace globs and
 * `packageRoots` the nested package/suite roots found on disk (bounded, capped) — either
 * being non-empty signals the root suite does NOT necessarily cover the whole repo. Both
 * are `[]` for a plain single-root repo, so the pre-existing shape is unchanged.
 * `packageRootsTruncated` is true when the bounded walk stopped early (the list is a
 * sample, so full coverage cannot be claimed from it).
 * @param {string} [root]
 * @returns {{languages:string[], frameworks:string[], packageManagers:string[],
 *   testCommands:string[], testRunners:TestRunner[], testInventory:string[], tools:string[],
 *   notes:string[], evidence:string[], workspaces:string[], packageRoots:string[],
 *   packageRootsTruncated:boolean}}
 */
export function detectStack(root = process.cwd()) {
  const scan = scanPackageRoots(root);
  return {
    ...collect(root),
    workspaces: workspaceGlobs(root),
    packageRoots: scan.roots,
    packageRootsTruncated: scan.truncated,
  };
}
