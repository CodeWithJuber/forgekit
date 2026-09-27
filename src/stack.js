// forge stack — DYNAMIC stack detection. The atlas RULES table lists the languages forge
// can PARSE; this module answers the different question "what is THIS repo actually built
// with?" by reading the dependency manifests instead of guessing from a hardcoded menu.
// Everything is data: SIGNATURES maps a dependency/marker to a label, so widening coverage
// is adding a row, never editing logic. Fail-safe — an unreadable or absent manifest is
// skipped, never thrown.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripTrailingSlashes } from "./util.js";

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
      args: scriptArgs(pmRoot),
      label: [pmRun(pmRoot), ...scriptArgs(pmRoot)].join(" "),
    });
}

// `bun test` is Bun's OWN test runner — it never runs `scripts.test`; `bun run test` does
// (review N03 round 2: a root `bun test` was credited with a recursive npm script it skipped).
const scriptArgs = (root) => (pmRun(root) === "bun" ? ["run", "test"] : ["test"]);

const pmRun = (root) =>
  existsSync(join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(root, "yarn.lock"))
      ? "yarn"
      : existsSync(join(root, "bun.lockb"))
        ? "bun"
        : "npm";
const runnerCmd = (root, runner) =>
  runner === "npm test" ? [pmRun(root), ...scriptArgs(root)].join(" ") : `npx ${runner}`;

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

// Zero-dep: pull the `packages:` list from a pnpm-workspace.yaml. Negations (`!…`) are
// dropped unless `negations` is set (membership needs them: `!packages/legacy` is NOT run).
function parsePnpmPackages(text, { negations = false } = {}) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    // A comment line — at any indentation, column 0 included — is not a key that ends the
    // list (review N03 round 2: `# legacy` at column 0 dropped the negations after it).
    if (/^\s*#/.test(raw)) continue;
    const hash = raw.search(/\s#/);
    const line = hash < 0 ? raw : raw.slice(0, hash);
    if (/^packages:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const m = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v && (negations || !v.startsWith("!"))) out.push(v);
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
  const g = stripTrailingSlashes(String(glob).replace(/^\.\//, ""));
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
  return new RegExp(`^${re}$`).test(stripTrailingSlashes(rel));
}

/**
 * Is `rel` a member of a workspace glob list? Included by some positive glob and excluded by
 * no `!negation` — the way npm, yarn and pnpm read their lists. Pure.
 * @param {string[]} globs @param {string} rel
 */
export function isWorkspaceMember(globs, rel) {
  let member = false;
  for (const g of globs) {
    if (typeof g !== "string") continue;
    if (g.startsWith("!")) {
      // A negation excludes whatever it MIGHT match (review N03 round 2): with a trailing
      // `/**` removed too (pnpm's own `!**/test/**` excludes packages/test itself), and
      // whenever it uses syntax this matcher does not model (`{a,b}`, `[…]`, `(…)`).
      const pat = g.slice(1);
      if (
        /[{}[\]()]/.test(pat) ||
        matchesWorkspaceGlob(pat, rel) ||
        matchesWorkspaceGlob(pat.replace(/\/\*\*$/, ""), rel)
      )
        return false;
    } else if (!member && matchesWorkspaceGlob(g, rel)) member = true;
  }
  return member;
}

// ---------------------------------------------------------------------------
// Recursive workspace test runs (review N03). A root `test` script covers the workspaces only
// when it PROVABLY runs every member's own `test` script and that run's failure reaches the
// script's exit status. The old check matched a flag token anywhere in the text, so Node's
// preload flag (`node -r ./setup.cjs --test`) read as `pnpm -r`: a failing workspace was never
// executed and verify said PASS. The script is now read as shell STRUCTURE — commands split at
// `&&` `||` `;` `|` `&`, quotes resolved, each command's executable identified through
// env/cross-env/npx/exec wrappers — and only a known, UNFILTERED recursive run of `test`
// counts:
//   npm test|run test --workspaces|-ws        no -w/--workspace/--prefix
//   pnpm -r|--recursive test|run test         no --filter/-F/--resume-from/-C/-w/--no-bail
//   yarn workspaces run test (v1)
//   yarn workspaces foreach [-A|-W] [run] test  no --include/--exclude/--since/--from/-R/--no-private
//   turbo run test [other tasks]              no --filter/-F/--affected/--since/--scope/--dry-run/--continue
//   lerna run test                            no --scope/--ignore/--since/--no-private/--no-bail
//   nx run-many -t test                       no --projects/-p/--exclude
// — directly or through at most four `npm run <root script>` hops. Its status must reach the
// script's: the last command of its pipeline, in the script's final list, not backgrounded,
// with no `||` right before it or anywhere after it. Anything else — including a construct
// this reader does not model (`$VAR`, `$(…)`, subshells, here-docs) — is NOT established, and
// the planner runs each workspace suite in its own directory; only `verify.workspaces:
// "root"` can declare otherwise. Which packages the run reaches is read from the tool's OWN
// workspace list (npm/yarn: package.json, pnpm: pnpm-workspace.yaml, lerna: lerna.json),
// negations included.
// ---------------------------------------------------------------------------

/**
 * Read a package-script command line the way `sh` splits it — for RECOGNITION only, nothing
 * is executed. Each command is its words (quotes and backslashes resolved, redirections
 * dropped) plus the control operator that follows it (`&&`, `||`, `;`, `|`, `&`, or null at
 * the end). `null` when the line uses a construct this reader does not model: parameter
 * expansion, command substitution, subshells or `{ }` groups, here-docs, a dangling quote.
 * @param {string} line
 * @returns {{words: string[], op: string|null}[]|null}
 */
export function shellCommands(line) {
  const s = String(line);
  /** @type {{words: string[], op: string|null}[]} */
  const cmds = [];
  /** @type {string[]} */
  let words = [];
  /** @type {string|null} */
  let word = null; // null = no word in progress, so an empty quoted "" is still a word
  let quoted = false;
  let redirect = false; // the next word is a redirection target, not an argument
  const endWord = () => {
    if (word === null) return true;
    const w = word;
    word = null;
    if (!quoted && (w === "{" || w === "}")) return false; // a `{ …; }` group
    quoted = false;
    if (redirect) redirect = false;
    else words.push(w);
    return true;
  };
  const endCommand = (op) => {
    if (!endWord() || redirect) return false; // `>` with no target
    if (!words.length) return op === ";" || op === "\n" || op === null; // blank line / trailing `;`
    cmds.push({ words, op: op === "\n" ? ";" : op });
    words = [];
    return true;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      word = (word ?? "") + s.slice(i + 1, j);
      quoted = true;
      i = j;
    } else if (c === '"') {
      let out = "";
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "$" || s[j] === "`") return null;
        if (s[j] === "\\" && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1])) out += s[++j];
        else out += s[j];
      }
      if (j >= s.length) return null;
      word = (word ?? "") + out;
      quoted = true;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= s.length) return null;
      if (s[i + 1] !== "\n") {
        word = (word ?? "") + s[i + 1];
        quoted = true;
      }
      i += 1;
    } else if (c === "$" || c === "`" || c === "(" || c === ")") return null;
    else if (c === "#" && word === null) {
      while (i + 1 < s.length && s[i + 1] !== "\n") i += 1; // a comment runs to end of line
    } else if (c === "\n") {
      if (!endCommand("\n")) return null;
    } else if (c === " " || c === "\t" || c === "\r") {
      if (!endWord()) return null;
    } else if (c === "<" || c === ">") {
      // Redirection. A pending all-digit word is its fd (`2>`), not an argument.
      if (word !== null && /^\d+$/.test(word) && !quoted) word = null;
      else if (!endWord()) return null;
      if (redirect) return null;
      if (c === "<" && s[i + 1] === "<") return null; // here-doc
      if (s[i + 1] === ">" || s[i + 1] === "&" || s[i + 1] === "|") i += 1;
      redirect = true;
    } else if (c === "&" || c === "|" || c === ";") {
      const two = s.slice(i, i + 2);
      if (c === "&" && s[i + 1] === ">") {
        if (!endWord()) return null; // `&>file` — a redirection, not an operator
        i += s[i + 2] === ">" ? 2 : 1;
        redirect = true;
        continue;
      }
      if (two === ";;") return null;
      const op = two === "&&" || two === "||" ? two : two === "|&" ? "|" : c;
      if (op.length === 2 || two === "|&") i += 1;
      if (!endCommand(op)) return null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (!endCommand(null)) return null;
  const last = cmds[cmds.length - 1];
  if (last && (last.op === "&&" || last.op === "||" || last.op === "|")) return null; // dangling
  if (last?.op === ";") last.op = null;
  return cmds;
}

/**
 * The commands whose exit status reaches the whole line's (no `set -e` modelled): those in
 * the FINAL list (after the last `;`/`&`), last in their pipeline (no `pipefail`), with no
 * `||` right before them (they might be skipped on success) or anywhere after them (their
 * failure would be absorbed). A backgrounded final command reaches nothing.
 * @param {{words: string[], op: string|null}[]} cmds
 */
function statusCarriers(cmds) {
  if (!cmds.length || cmds[cmds.length - 1].op === "&") return [];
  let start = 0;
  for (let i = 0; i < cmds.length - 1; i++)
    if (cmds[i].op === ";" || cmds[i].op === "&") start = i + 1;
  const list = cmds.slice(start);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].op === "|") continue; // not the last command of its pipeline
    let first = i;
    while (first > 0 && list[first - 1].op === "|") first -= 1;
    if (first > 0 && list[first - 1].op === "||") continue;
    if (list.slice(i).some((x) => x.op === "||")) continue;
    out.push(list[i]);
  }
  return out;
}

const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
// A variable in a package tool's namespace can narrow or redirect a run
// (`npm_config_workspace=packages/good npm test --workspaces` runs one workspace — review N03
// round 2); none may be set on a recognized command, except the two that DISABLE a cache.
const TOOL_ENV = /^(?:npm_config_|yarn_|pnpm_|nx_|lerna_|turbo_|bun_)/i;
const CACHE_BYPASS_ENV = new Map([
  ["TURBO_FORCE", "turbo"],
  ["NX_SKIP_NX_CACHE", "nx"],
]);
// Variables a recognized command line may set — an ALLOWLIST, like the options (review Q02).
// Any other can change which program a name runs (PATH), what it loads (LD_PRELOAD,
// NODE_OPTIONS=--require), where it reads its configuration (HOME), or which members it runs.
const INERT_ENV = new Set([
  "CI",
  "NODE_ENV",
  "FORCE_COLOR",
  "NO_COLOR",
  "TZ",
  "LANG",
  "LC_ALL",
  "DEBUG",
  "DO_NOT_TRACK",
  "NX_DAEMON",
  "NX_NO_CLOUD",
  "TURBO_TELEMETRY_DISABLED",
]);
// NODE_OPTIONS flags that neither load code nor soften a failure.
const INERT_NODE_OPTION =
  /^--(?:(?:max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size|stack[-_]trace[-_]limit)=\d+|experimental-vm-modules|no-warnings|no-deprecation|trace-warnings|trace-deprecation|trace-uncaught|enable-source-maps|unhandled-rejections=(?:strict|throw))$/;
const TRUTHY = new Set(["1", "true"]);

/** Whether a NODE_OPTIONS value holds only inert flags. */
const inertNodeOptions = (value) =>
  String(value)
    .split(/\s+/)
    .every((o) => !o || INERT_NODE_OPTION.test(o));

/** Why a variable set on the command line keeps a run from being established, or null. */
function envProblem(name, value) {
  if (INERT_ENV.has(name) || CACHE_BYPASS_ENV.has(name)) return null;
  if (name === "NODE_OPTIONS" && inertNodeOptions(value)) return null;
  if (/^path(?:ext)?$/i.test(name)) return `sets ${name}, which changes the program a name runs`;
  if (TOOL_ENV.test(name)) return `sets ${name}, which can narrow or redirect the run`;
  return `sets ${name}, which is not a variable known to leave the run unchanged`;
}
// Shell builtins that change what LATER commands do — the directory (`cd packages/good && npm
// test --workspaces` runs one workspace), the exit status (`trap 'exit 0' EXIT`, `… && exit
// 0; …`), the environment, the meaning of a name. A script holding any is not a recognized
// run: its effect on the recursive command is not modelled.
const STATEFUL_BUILTINS = new Set(
  (
    "cd pushd popd exit return exec trap export set unset alias unalias . source eval shopt " +
    "ulimit umask readonly declare typeset local builtin command enable hash shift wait"
  ).split(" "),
);
// Wrappers whose job is to find and run another binary.
const TOOL_BINS = new Set(["turbo", "lerna", "nx"]);
// npx/bunx/npm exec options that change nothing about which binary runs. `-p`/`--package`
// is not one: it picks the package that provides the binary (review Q02).
const NPX_OK = new Set([
  "--yes",
  "-y",
  "--no",
  "--no-install",
  "--quiet",
  "-q",
  "--prefer-offline",
]);
// Programs a project installs as a dependency, and the package whose binary each must be. A
// bare name finds them through the script's PATH (node_modules/.bin first); the same install
// may be spelled out as `node_modules/.bin/<name>`. Package managers and system programs are
// never project binaries (runProblem refuses a copy in node_modules/.bin).
const INSTALLED_BINS = new Map([
  ["turbo", "turbo"],
  ["nx", "nx"],
  ["lerna", "lerna"],
  ["cross-env", "cross-env"],
  ["bun", "bun"],
  ["bunx", "bun"],
]);

/**
 * The program a command word names, as far as recognition may rely on it (review Q02). A bare
 * name is the program of that name the script's PATH resolves — runProblem checks that nothing
 * in the project shadows it. `node_modules/.bin/<tool>` (optionally `./`-prefixed, or its
 * Windows `.cmd`/`.ps1` shim) is that same installed tool spelled out. Any other path —
 * `./tools/npm`, `./scripts/pnpm.js`, `/usr/bin/env` — is a program whose behaviour is
 * unknown, whatever its basename: null.
 * @param {string} word
 * @returns {string|null}
 */
function commandIdentity(word) {
  const w = String(word);
  if (!/[\\/]/.test(w)) return w;
  const m = /^(?:\.[\\/])?node_modules[\\/]\.bin[\\/]([^\\/]+?)(?:\.cmd|\.ps1)?$/i.exec(w);
  return m && INSTALLED_BINS.has(m[1]) ? m[1] : null;
}

/** The name a word's basename suggests (`./tools/npm.cmd` → `npm`) — used only to explain a
 *  refusal, never to recognize a program. */
const suggestedName = (w) =>
  String(w)
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:cmd|exe|ps1|bat|js|cjs|mjs)$/i, "") ?? "";

/**
 * Strip env assignments and runner wrappers (env, cross-env, npx, bunx, npm exec, pnpm/yarn
 * exec|dlx, `yarn turbo`) down to the program that does the work: its identity (`bin`), its
 * arguments, the variables the command line sets, and `bins` — every program the line relies
 * on, wrappers first, for runProblem's shadow checks. `null` when a wrapper is used in a way
 * that could change what runs (`npx -c`, `npx -p pkg`, `env -C dir`, `npm exec
 * --workspaces`…), a word names an unknown program (commandIdentity), or a variable outside
 * the allowlist is set. `explain` relaxes the last two and records the first such reason as
 * `note` instead — for a refusal message only.
 * @param {string[]} words
 * @param {boolean} [explain]
 * @returns {{bin: string, args: string[], words: string[], env: Map<string, string>, bins: string[], note: string|null}|null}
 */
function unwrapCommand(words, explain = false) {
  const w = [...words];
  /** @type {Map<string, string>} */
  const env = new Map();
  /** @type {string[]} */
  const bins = [];
  /** @type {string|null} */
  let note = null;
  const assign = () => {
    while (w.length && ENV_ASSIGN.test(w[0])) {
      const word = /** @type {string} */ (w.shift());
      const eq = word.indexOf("=");
      env.set(word.slice(0, eq), word.slice(eq + 1));
    }
  };
  /** @param {string} word */
  const identify = (word) => {
    const id = commandIdentity(word);
    if (id !== null || !explain) return id;
    const name = suggestedName(word);
    note ??= `\`${word}\` is a program named by its path, not ${name} itself: only a bare name or a node_modules/.bin install is recognized`;
    return name;
  };
  for (let hop = 0; hop < 6; hop++) {
    assign();
    if (!w.length || w[0] === "!") return null; // `! cmd` inverts the status
    const bin = identify(w[0]);
    if (bin === null) return null;
    bins.push(bin);
    const next = w[1];
    if (bin === "env" || bin === "cross-env") {
      w.shift();
      // `env -u NAME` only removes a variable; `-i`, `-C`/`--chdir`, `-S`… change the
      // environment or the directory the command runs in. cross-env takes no options.
      while (w.length && w[0].startsWith("-")) {
        if (bin === "env" && (w[0] === "-u" || w[0] === "--unset") && w.length > 1) w.splice(0, 2);
        else if (bin === "env" && w[0].startsWith("--unset=")) w.shift();
        else return null;
      }
      continue;
    }
    if (bin === "npx" || bin === "bunx" || (bin === "bun" && next === "x")) {
      w.shift();
      if (bin === "bun") w.shift();
      while (w.length && w[0].startsWith("-")) {
        const o = /** @type {string} */ (w.shift());
        if (o === "--") break;
        if (!NPX_OK.has(o)) return null;
      }
      continue;
    }
    if (bin === "npm" && (next === "exec" || next === "x")) {
      w.splice(0, 2);
      while (w.length && w[0].startsWith("-")) {
        const o = /** @type {string} */ (w.shift());
        if (o === "--") break;
        if (!NPX_OK.has(o)) return null;
      }
      continue;
    }
    if ((bin === "pnpm" || bin === "yarn") && (next === "exec" || next === "dlx")) {
      w.splice(0, 2);
      if (w[0] === "--") w.shift();
      if (w[0]?.startsWith("-")) return null;
      continue;
    }
    // `yarn turbo run test`: the package manager runs the installed tool, named bare.
    if (
      (bin === "pnpm" || bin === "yarn") &&
      next !== undefined &&
      TOOL_BINS.has(explain ? suggestedName(next) : next)
    ) {
      w.shift();
      continue;
    }
    for (const [name, value] of env) {
      const why = envProblem(name, value);
      if (!why) continue;
      if (!explain) return null;
      note ??= `the command line ${why}`;
    }
    return { bin, args: w.slice(1), words: w, env, bins, note };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Options, by ALLOWLIST (review N03 round 2). Each tool may carry only the options known to
// neither narrow the run, skip executing it, forward arguments into the scripts, nor replay a
// cached result. A denylist let through `--help`, `--prefi=other` (npm expands it to
// `--prefix`), `--tag test` (npm reads `test` as the tag's VALUE and runs `lint`), `--dry-run`
// and `--cache-dir test`. `flags` stand alone; `values` take one (`--opt v` or `--opt=v`);
// `eq` are accepted only as `--opt=value`. Anything else — and `--`, which forwards words to
// every member's script — means the run is not established.
// ---------------------------------------------------------------------------------------

const optionSet = (flags, values = "", eq = "") => ({
  flags: new Set(flags.split(" ").filter(Boolean)),
  values: new Set(values.split(" ").filter(Boolean)),
  eq: new Set(eq.split(" ").filter(Boolean)),
});
const NPM_OPTS = optionSet(
  "--workspaces -ws --workspaces=true --if-present --include-workspace-root --silent -s --quiet -q --no-progress --color --no-color --foreground-scripts",
  "--loglevel",
  "--color --progress",
);
const PNPM_OPTS = optionSet(
  "-r --recursive --stream --parallel --sort --no-sort --silent -s --color --no-color --aggregate-output --no-bail --bail --include-workspace-root --report-summary --if-present --use-stderr",
  "--reporter --loglevel --workspace-concurrency",
);
const YARN1_OPTS = optionSet("--silent -s --no-progress --verbose");
const YARN_FOREACH_OPTS = optionSet(
  "-A --all -p --parallel -v --verbose -t --topological --topological-dev -i --interlaced -W --worktree",
  "-j --jobs",
);
const YARN_FOREACH_BUNDLE = /^-[ApvtiW]{2,}$/;
const TURBO_OPTS = optionSet(
  "--force --force=true --continue --color --no-color --summarize --no-daemon --daemon --no-cache --parallel",
  "--concurrency --output-logs --log-order --log-prefix --ui --verbosity",
  "--continue --summarize",
);
const LERNA_OPTS = optionSet(
  "--stream --parallel --no-bail --bail --skip-nx-cache --no-prefix --prefix --no-sort --sort --reject-cycles",
  "--concurrency --loglevel",
);
const NX_OPTS = optionSet(
  "--skip-nx-cache --skipNxCache --parallel --verbose --nx-bail --nxBail --no-cloud --all",
  "-t --target --targets --output-style --outputStyle",
  "--parallel",
);
const BUN_RUN_OPTS = optionSet("--silent");

/**
 * Split argv into options (checked against `allowed`) and positionals. Returns null on an
 * unknown option, on `--`, or on a value-taking option with no value.
 * @param {string[]} args
 * @param {ReturnType<typeof optionSet>} allowed
 * @returns {{options: {name: string, value?: string}[], positionals: string[]}|null}
 */
function parseArgs(args, allowed) {
  const options = [];
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return null;
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    if (allowed.flags.has(a)) {
      options.push({ name: a });
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      const name = a.slice(0, eq);
      if (allowed.values.has(name) || allowed.eq.has(name)) {
        options.push({ name, value: a.slice(eq + 1) });
        continue;
      }
      return null;
    }
    if (allowed.values.has(a) && i + 1 < args.length && args[i + 1] !== "--") {
      options.push({ name: a, value: args[++i] });
      continue;
    }
    return null;
  }
  return { options, positionals };
}

const TEST_ALIASES = new Set(["test", "t", "tst"]);
const RUN_ALIASES = new Set(["run", "run-script", "rum", "urn"]);
// pnpm builtins that are not script names (`pnpm <script>` runs a root script otherwise).
const PNPM_BUILTINS = new Set(
  "add install i update up remove rm link unlink import rebuild prune fetch patch audit list ls outdated why exec dlx create publish pack store root bin setup init env deploy config start recursive multi m".split(
    " ",
  ),
);
const YARN_BUILTINS = new Set(
  "workspace workspaces install add remove upgrade up info init link unlink pack publish config cache bin why dlx exec set plugin version constraints npm node".split(
    " ",
  ),
);

/**
 * One command → a recognized recursive test run, a root-script hop to follow, or null. A hop
 * (`npm run test:ws`) is followed only when it passes NOTHING to the script it names: words
 * after it are appended to that script's command line (`npm run test:ws -- -w packages/good`
 * runs one workspace).
 * @param {{bin: string, args: string[], env?: Map<string, string>}} cmd
 * @returns {{tool: string, bypass: boolean}|{follow: string}|null}
 */
function recognizeCommand({ bin, args, env = new Map() }) {
  const envBypass = (tool) =>
    [...env].some(([k, v]) => CACHE_BYPASS_ENV.get(k) === tool && TRUTHY.has(v.toLowerCase()));
  if (bin === "npm") {
    const p = parseArgs(args, NPM_OPTS);
    if (!p) return null;
    const recursive = p.options.some(
      (o) => o.name === "--workspaces" || o.name === "-ws" || o.name === "--workspaces=true",
    );
    const [sub, script, ...extra] = p.positionals;
    if (extra.length) return null;
    if (TEST_ALIASES.has(sub) && !script) return recursive ? { tool: "npm", bypass: false } : null;
    if (RUN_ALIASES.has(sub) && script)
      return recursive
        ? script === "test"
          ? { tool: "npm", bypass: false }
          : null
        : { follow: script };
    return null;
  }
  if (bin === "pnpm") {
    const p = parseArgs(args, PNPM_OPTS);
    if (!p) return null;
    let pos = p.positionals;
    let recursive = p.options.some((o) => o.name === "-r" || o.name === "--recursive");
    if (["recursive", "multi", "m"].includes(pos[0])) {
      recursive = true;
      pos = pos.slice(1);
    }
    // Words after the script name are FORWARDED to it (pnpm ≥7) — never a whole run.
    const [sub, script, ...extra] = pos;
    if (TEST_ALIASES.has(sub) && !script && !extra.length)
      return recursive ? { tool: "pnpm", bypass: false } : null;
    if ((sub === "run" || sub === "run-script") && script && !extra.length)
      return recursive
        ? script === "test"
          ? { tool: "pnpm", bypass: false }
          : null
        : { follow: script };
    if (!recursive && sub && !script && !PNPM_BUILTINS.has(sub)) return { follow: sub };
    return null;
  }
  if (bin === "yarn") {
    let i = 0;
    while (i < args.length && YARN1_OPTS.flags.has(args[i])) i += 1;
    const rest = args.slice(i);
    // yarn 1: every workspace, no filters, nothing after the script name
    if (rest[0] === "workspaces" && rest[1] === "run")
      return rest[2] === "test" && rest.length === 3 ? { tool: "yarn", bypass: false } : null;
    if (rest[0] === "workspaces" && rest[1] === "foreach") {
      let k = 2;
      for (; k < rest.length && rest[k].startsWith("-"); k++) {
        const a = rest[k];
        if (YARN_FOREACH_OPTS.flags.has(a) || YARN_FOREACH_BUNDLE.test(a)) continue;
        if (YARN_FOREACH_OPTS.values.has(a) && k + 1 < rest.length) {
          k += 1;
          continue;
        }
        if (/^--jobs=\S+$/.test(a)) continue;
        return null;
      }
      const tail = rest[k] === "run" ? rest.slice(k + 1) : rest.slice(k);
      return tail.length === 1 && tail[0] === "test" ? { tool: "yarn", bypass: false } : null;
    }
    if (rest[0] === "run" && rest[1] && rest.length === 2) return { follow: rest[1] };
    if (rest.length === 1 && !rest[0].startsWith("-") && !YARN_BUILTINS.has(rest[0]))
      return { follow: rest[0] };
    return null;
  }
  if (bin === "bun") {
    const p = parseArgs(args, BUN_RUN_OPTS);
    if (p?.positionals[0] === "run" && p.positionals.length === 2)
      return { follow: p.positionals[1] };
    return null;
  }
  if (bin === "turbo") {
    const p = parseArgs(args, TURBO_OPTS);
    if (!p) return null;
    const tasks = p.positionals[0] === "run" ? p.positionals.slice(1) : p.positionals;
    if (!tasks.includes("test")) return null;
    const force = p.options.some((o) => o.name === "--force" || o.name === "--force=true");
    return { tool: "turbo", bypass: force || envBypass("turbo") };
  }
  if (bin === "lerna") {
    const p = parseArgs(args, LERNA_OPTS);
    if (!p) return null;
    if (p.positionals.length !== 2) return null;
    if (p.positionals[0] !== "run" || p.positionals[1] !== "test") return null;
    const skip = p.options.some((o) => o.name === "--skip-nx-cache");
    return { tool: "lerna", bypass: skip || envBypass("nx") };
  }
  if (bin === "nx") {
    const p = parseArgs(args, NX_OPTS);
    if (!p) return null;
    if (p.positionals.length !== 1 || p.positionals[0] !== "run-many") return null;
    const targets = p.options
      .filter((o) => o.name === "-t" || o.name === "--target" || o.name === "--targets")
      .flatMap((o) => String(o.value ?? "").split(","))
      .map((t) => t.trim());
    if (!targets.includes("test")) return null;
    const skip = p.options.some((o) => o.name === "--skip-nx-cache" || o.name === "--skipNxCache");
    return { tool: "nx", bypass: skip || envBypass("nx") };
  }
  return null;
}

const MAX_SCRIPT_HOPS = 4;
const firstWord = (c) => c.words.find((w) => !ENV_ASSIGN.test(w)) ?? "";

/**
 * Walk a root `test` script for a recognized recursive run (see recursiveTestInvocation).
 * `explain` walks it with commandIdentity and the variable allowlist relaxed, carrying the
 * first reason they would have refused as `note` — so a script that is NOT established can
 * still say why (review Q02).
 * @param {string} script
 * @param {Record<string, unknown>} scripts
 * @param {boolean} explain
 * @returns {{tool: string, command: string, bypass: boolean, bins: string[], note: string|null}|null}
 */
function walkTestScript(script, scripts, explain) {
  const seen = new Set(["test"]);
  /**
   * @param {string} line
   * @param {number} hops
   * @param {string[]} trail  programs relied on by the hops that led here
   * @param {string|null} why
   * @returns {{tool: string, command: string, bypass: boolean, bins: string[], note: string|null}|null}
   */
  const walk = (line, hops, trail, why) => {
    const cmds = shellCommands(line);
    if (!cmds) return null;
    if (cmds.some((c) => STATEFUL_BUILTINS.has(firstWord(c)))) return null;
    for (const c of statusCarriers(cmds)) {
      const cmd = unwrapCommand(c.words, explain);
      if (!cmd) continue;
      const r = recognizeCommand(cmd);
      const bins = [...trail, ...cmd.bins];
      const note = why ?? cmd.note;
      if (r && "tool" in r)
        return {
          tool: r.tool,
          command: cmd.words.join(" "),
          bypass: r.bypass,
          bins: [...new Set(bins)],
          note,
        };
      if (r && "follow" in r) {
        const next = scripts?.[r.follow];
        if (typeof next !== "string" || seen.has(r.follow) || hops >= MAX_SCRIPT_HOPS) continue;
        seen.add(r.follow);
        const inner = walk(next, hops + 1, bins, note);
        if (inner) return inner;
      }
    }
    return null;
  };
  return typeof script === "string" ? walk(script, 0, [], null) : null;
}

/**
 * The recursive workspace test run a root `test` script performs, if one is ESTABLISHED:
 * `{tool, command, bypass, bins}` for the recognized invocation (`command` is its words,
 * re-joined; `bypass` — the command itself disables the tool's result cache: `turbo --force`,
 * `--skip-nx-cache`, `TURBO_FORCE=1`; `bins` — every program the line relies on, wrappers and
 * hops included, each named bare or as its node_modules/.bin install), else null. A program
 * named by any other path (`./tools/npm`) is unknown whatever its basename (review Q02). Pure —
 * `scripts` is the root package.json's `scripts`, used to follow `npm run <script>` hops (at
 * most four, cycles refused).
 * @param {string} script
 * @param {{scripts?: Record<string, unknown>}} [opts]
 * @returns {{tool: string, command: string, bypass: boolean, bins: string[]}|null}
 */
export function recursiveTestInvocation(script, { scripts = {} } = {}) {
  const run = walkTestScript(script, scripts, false);
  return run && { tool: run.tool, command: run.command, bypass: run.bypass, bins: run.bins };
}

/** JSON with comments and trailing commas (turbo.json, nx.json), read by a linear scanner. */
function readJsonc(root, rel) {
  const t = read(root, rel);
  if (t == null) return null;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"') j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j;
    } else if (c === "/" && t[i + 1] === "/") {
      while (i < t.length && t[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && t[i + 1] === "*") {
      const e = t.indexOf("*/", i + 2);
      i = e < 0 ? t.length : e + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/** Keys of an `.npmrc` (project), normalized: lower case, `_` → `-`, `[]` dropped. */
function npmrcKeys(root) {
  const text = read(root, ".npmrc");
  if (text == null) return new Map();
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase().replaceAll("_", "-").replace(/\[\]$/, "");
    out.set(key, line.slice(eq + 1).trim());
  }
  return out;
}

// npm/pnpm configuration that selects a SUBSET of the workspaces or another root, or runs the
// script through another shell — set in the project `.npmrc` or the environment, it narrows a
// run whose command line looks whole.
const NARROWING_NPM_CONFIG = new Set([
  "workspace",
  "filter",
  "filter-prod",
  "dir",
  "script-shell",
  "test-pattern",
  "resume-from",
  "changed-files-ignore-pattern",
]);

/** The package manager in use: `packageManager`, else a single kind of lockfile; null when
 *  it cannot be told. */
function packageManagerOf(root) {
  const declared = readJson(root, "package.json")?.packageManager;
  if (typeof declared === "string" && /^[a-z]+@/.test(declared)) return declared.split("@")[0];
  const kinds = new Set(
    [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
      ["bun.lockb", "bun"],
      ["bun.lock", "bun"],
    ]
      .filter(([f]) => existsSync(join(root, f)))
      .map(([, pm]) => pm),
  );
  return kinds.size === 1 ? [...kinds][0] : null;
}

/**
 * The workspace lists a tool iterates — a package is reached only if EVERY list includes it
 * (review N03 round 2). npm and yarn read package.json `workspaces`, pnpm reads
 * pnpm-workspace.yaml, lerna its own `packages` when set; turbo, nx and lerna otherwise follow
 * the package manager IN USE — and when that cannot be told, both lists must agree (a leftover
 * pnpm-workspace.yaml in an npm repo named packages turbo never ran).
 * @returns {string[][]}
 */
function toolWorkspaceLists(root, tool) {
  const pkg = readJson(root, "package.json");
  const ws = pkg?.workspaces;
  const pkgGlobs = (Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : []).filter(
    (g) => typeof g === "string",
  );
  const yaml = read(root, "pnpm-workspace.yaml");
  const pnpmGlobs = yaml == null ? null : parsePnpmPackages(yaml, { negations: true });
  if (tool === "npm" || tool === "yarn") return [pkgGlobs];
  if (tool === "pnpm") return [pnpmGlobs ?? []];
  if (tool === "lerna") {
    const lerna = readJson(root, "lerna.json");
    if (Array.isArray(lerna?.packages) && lerna.packages.length)
      return [lerna.packages.filter((g) => typeof g === "string")];
  }
  const pm = packageManagerOf(root);
  if (pm === "pnpm") return [pnpmGlobs ?? []];
  if (pm) return [pkgGlobs];
  return pnpmGlobs ? [pkgGlobs, pnpmGlobs] : [pkgGlobs];
}

// cmd.exe — npm's script shell on Windows — looks in the working directory before PATH,
// trying each PATHEXT extension: an `npm.cmd` in the package root runs instead of npm.
const WINDOWS_EXEC_EXT = [
  ".com",
  ".exe",
  ".bat",
  ".cmd",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".msc",
];
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn"]);

/**
 * Why the program a bare name runs in the root's scripts may not be that tool (review Q02), or
 * null: a same-named executable in the package root (Windows runs it first), or the first
 * node_modules/.bin entry on the script's PATH — npm puts the package's own and every parent
 * directory's there, in that order — that is not the binary of the tool's own installed
 * package. Package managers and system programs are never project binaries, so any copy there
 * shadows them.
 * @param {string} root
 * @param {string} bin
 * @returns {string|null}
 */
function shadowProblem(root, bin) {
  for (const ext of WINDOWS_EXEC_EXT)
    if (existsSync(join(root, `${bin}${ext}`)))
      return `${bin}${ext} in the package root shadows ${bin} (Windows runs the working directory's copy first)`;
  for (let dir = resolve(root); ; ) {
    const shim = ["", ".cmd", ".ps1"]
      .map((suffix) => join(dir, "node_modules", ".bin", `${bin}${suffix}`))
      .find((file) => existsSync(file));
    if (shim) {
      const shown = relative(root, shim).split(sep).join("/");
      const pkg = INSTALLED_BINS.get(bin);
      if (!pkg)
        return `${shown} shadows ${PACKAGE_MANAGERS.has(bin) ? "the package manager" : bin}`;
      const manifest = readJson(dir, `node_modules/${pkg}/package.json`);
      const declared = typeof manifest?.bin === "string" ? { [pkg]: manifest.bin } : manifest?.bin;
      const own = manifest?.name === pkg && typeof declared?.[bin] === "string";
      return own && linksInto(shim, join(dir, "node_modules", pkg))
        ? null
        : `${shown} is not the ${pkg} package's own binary`;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The value on the first line `key` starts (a yarn config file): comment, whitespace and
 *  surrounding quotes removed. */
function configValue(text, key) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = key.exec(line);
    if (!m) continue;
    const value = line.slice(m[0].length).split(/\s#/)[0].trim();
    return value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return null;
}

/** Whether a node_modules/.bin entry that is a symlink resolves inside `pkgDir` (a shim
 *  script — pnpm's, or a Windows .cmd — is not a link, and is taken as installed). */
function linksInto(shim, pkgDir) {
  try {
    if (!lstatSync(shim).isSymbolicLink()) return true;
    const base = realpathSync(pkgDir);
    return realpathSync(shim).startsWith(base + sep);
  } catch {
    return false;
  }
}

/**
 * Why a package manager the run relies on may not be a released one (review Q02), or null:
 * yarn pointed at a file other than a release `yarn set version` installs (`.yarnrc.yml`
 * `yarnPath`, yarn 1's `.yarnrc` `yarn-path`), or `packageManager` fetching the manager from a
 * URL instead of the registry.
 * @param {string} root
 * @param {string[]} bins
 * @returns {string|null}
 */
function managerSourceProblem(root, bins) {
  if (bins.includes("yarn")) {
    const configured = [
      { file: ".yarnrc.yml", key: /^yarnPath:/ },
      { file: ".yarnrc", key: /^yarn-path[ \t]/ },
    ]
      .map(({ file, key }) => ({ file, path: configValue(read(root, file), key) }))
      .find((c) => c.path);
    if (configured && !/^(?:\.\/)?\.yarn\/releases\/yarn-[\w.+-]+\.c?js$/.test(configured.path))
      return `${configured.file} points yarn at ${configured.path}, not a release in .yarn/releases`;
  }
  const declared = readJson(root, "package.json")?.packageManager;
  const m =
    typeof declared === "string" ? /^([a-z]+)@([a-z][a-z0-9+.-]*:.*)$/i.exec(declared) : null;
  if (m && bins.includes(m[1]))
    return `packageManager fetches ${m[1]} from ${m[2].split("#")[0]}, not a registry release`;
  return null;
}

/**
 * Why a recognized recursive run is still not a whole, fresh run, or null (review N03 round
 * 2): a program it relies on that a project file shadows or a configured source replaces
 * (review Q02), configuration or environment that narrows it, and tool caches that REPLAY an
 * earlier result (turbo caches `test` by default; nx and lerna may) unless disabled.
 * @param {string} root
 * @param {{tool: string, bypass: boolean, bins?: string[]}} run
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function runProblem(root, run, env) {
  const bins = run.bins ?? [run.tool];
  for (const bin of bins) {
    const shadow = shadowProblem(root, bin);
    if (shadow) return shadow;
  }
  const source = managerSourceProblem(root, bins);
  if (source) return source;
  for (const [k, v] of Object.entries(env)) {
    const m = /^npm_config_(.+)$/i.exec(k);
    const key = m?.[1].toLowerCase().replaceAll("_", "-");
    if (m && v != null && key && NARROWING_NPM_CONFIG.has(key))
      return `the environment sets ${k}, which can narrow the run`;
    if (key === "node-options" && v != null && !inertNodeOptions(v))
      return `the environment sets ${k}, which can load code into every script the run starts`;
  }
  const npmrc = npmrcKeys(root);
  for (const key of npmrc.keys())
    if (NARROWING_NPM_CONFIG.has(key)) return `.npmrc sets ${key}, which can narrow the run`;
  if (!inertNodeOptions(npmrc.get("node-options") ?? ""))
    return ".npmrc sets node-options, which can load code into every script the run starts";
  if (run.tool === "turbo") {
    const turbo = readJsonc(root, "turbo.json");
    const tasks = turbo?.tasks ?? turbo?.pipeline;
    if (!tasks || typeof tasks !== "object") return "no readable turbo.json defines the test task";
    if (!tasks.test) return "turbo.json defines no `test` task";
    if (Object.keys(tasks).some((k) => k.endsWith("#test")))
      return "turbo.json configures `test` for single packages (`<pkg>#test`)";
    if (!run.bypass && tasks.test?.cache !== false)
      return "turbo may replay a cached test result: pass --force (or set tasks.test.cache to false)";
  }
  if (run.tool === "nx" || run.tool === "lerna") {
    if (existsSync(join(root, ".nxignore"))) return ".nxignore hides projects from nx";
    const nx = readJsonc(root, "nx.json");
    // Nx plugins infer targets: `test` may then run a plugin's command, not the member's script.
    if (Array.isArray(nx?.plugins) && nx.plugins.length)
      return "nx.json plugins can define each project's test target";
    const td = nx?.targetDefaults?.test;
    if (td && Object.keys(td).some((k) => !["dependsOn", "inputs", "outputs", "cache"].includes(k)))
      return "nx.json redefines the test target (targetDefaults.test)";
    const lerna = run.tool === "lerna" ? readJson(root, "lerna.json") : null;
    const runConfig = lerna?.command?.run;
    if (runConfig && typeof runConfig === "object") {
      const ok = new Set([
        "stream",
        "parallel",
        "bail",
        "noBail",
        "concurrency",
        "sort",
        "noSort",
        "prefix",
        "noPrefix",
        "loglevel",
        "skipNxCache",
        "rejectCycles",
      ]);
      const bad = Object.keys(runConfig).find((k) => !ok.has(k));
      if (bad) return `lerna.json command.run.${bad} can narrow the run`;
    }
    const cacheFree =
      td?.cache === false || lerna?.useNx === false || runConfig?.skipNxCache === true;
    if (!run.bypass && !cacheFree)
      return `${run.tool} may replay a cached test result: pass --skip-nx-cache`;
  }
  return null;
}

/**
 * The root's recursive workspace test run, when one is ESTABLISHED from its declared `test`
 * script (see recursiveTestInvocation) and nothing narrows it or replays a cached result
 * (runProblem): the tool, the recognized command, and the workspace lists that tool iterates
 * (`lists`, every one must include a package; `globs` is the first — check membership with
 * reachesWorkspace). `refused` names why a recognized run was not established.
 * @param {string} root
 * @param {{env?: Record<string, string|undefined>}} [opts]
 * @returns {{tool: string, command: string, globs: string[], lists: string[][]}|{refused: string, tool: string, command: string}|null}
 */
export function analyzeRecursiveTestRun(root, { env = process.env } = {}) {
  const pkg = readJson(root, "package.json");
  const script = declaredTestScript(pkg);
  if (!script) return null;
  const scripts = pkg?.scripts ?? {};
  const run = recursiveTestInvocation(script, { scripts });
  if (!run) {
    // Not established. When it would be but for a program named by its path or a variable set
    // on the command line, say so (review Q02) — the members then run on their own.
    const near = walkTestScript(script, scripts, true);
    return near?.note ? { refused: near.note, tool: near.tool, command: near.command } : null;
  }
  const problem = runProblem(root, run, env);
  if (problem) return { refused: problem, tool: run.tool, command: run.command };
  const lists = toolWorkspaceLists(root, run.tool);
  return { tool: run.tool, command: run.command, globs: lists[0] ?? [], lists };
}

/** The established recursive run (analyzeRecursiveTestRun), or null — refused runs included. */
export function recursiveTestRun(root, opts) {
  const r = analyzeRecursiveTestRun(root, opts);
  return r && !("refused" in r) ? r : null;
}

/**
 * Whether an established recursive run reaches the package at `rel`: every workspace list the
 * tool iterates includes it, and the tool would actually run its `test` script there — yarn 1
 * skips a member with no `version`, nx runs a project's own target (a `project.json` or an
 * `nx` key can redefine or drop `test`).
 * @param {string} root
 * @param {{tool: string, globs: string[], lists?: string[][]}} run
 * @param {string} rel
 */
export function reachesWorkspace(root, run, rel) {
  const lists = run.lists ?? [run.globs];
  if (!lists.every((l) => isWorkspaceMember(l, rel))) return false;
  const pkg = readJson(root, `${rel}/package.json`);
  if (run.tool === "yarn" && typeof pkg?.version !== "string") return false;
  if (run.tool === "nx" && (pkg?.nx !== undefined || existsSync(join(root, rel, "project.json"))))
    return false;
  return true;
}

/** Whether the root's declared test script is an ESTABLISHED recursive run of every
 *  workspace's tests (back-compat boolean over recursiveTestRun). */
export function rootTestCoversWorkspaces(root) {
  return recursiveTestRun(root) !== null;
}

// A shell that runs a script as written. `script-shell` set to anything else (`/bin/true`)
// makes every npm/pnpm script a no-op that exits 0.
const KNOWN_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "cmd",
  "powershell",
  "pwsh",
]);

/**
 * Why npm/pnpm would not run a package script as written, or null: a `script-shell` in the
 * project `.npmrc` or the environment that is not a known shell (review N03 round 2).
 * @param {string} root
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function scriptShellProblem(root, env = process.env) {
  const fromEnv = Object.entries(env).find(([k]) => /^npm_config_script_shell$/i.test(k))?.[1];
  const shell = fromEnv ?? npmrcKeys(root).get("script-shell");
  if (!shell) return null;
  const first = shell.trim().split(/\s+/)[0];
  const base = (first.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
  // A shell's name on a project file is not a shell (review Q02): a relative path, or an
  // absolute one inside the project, names a program the project supplies.
  const pathed = /[\\/]/.test(first);
  const inProject = pathed && (!/^(?:[A-Za-z]:)?[\\/]/.test(first) || isWithin(root, first));
  if (KNOWN_SHELLS.has(base) && !inProject) return null;
  const why = inProject
    ? "a program inside the project"
    : "not a shell that runs the script as written";
  return `script-shell is ${shell} (${fromEnv ? "environment" : ".npmrc"}) — ${why}`;
}

/** Whether an absolute path (on this platform) lies inside `root`. */
function isWithin(root, path) {
  if (!isAbsolute(path)) return false;
  const base = resolve(root);
  const target = resolve(path);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
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
