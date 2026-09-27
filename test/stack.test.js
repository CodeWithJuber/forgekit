import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeRecursiveTestRun,
  detectStack,
  isWorkspaceMember,
  recursiveTestInvocation,
  recursiveTestRun,
  scriptShellProblem,
  shellCommands,
} from "../src/stack.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "forge-stack-"));

test("node + Next.js: language, framework, pkg manager, test command", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { next: "16", react: "19" },
      devDependencies: { vitest: "2" },
    }),
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const s = detectStack(root);
  assert.ok(s.languages.includes("JavaScript/TypeScript"));
  assert.ok(s.frameworks.includes("Next.js"), JSON.stringify(s.frameworks));
  assert.ok(s.frameworks.includes("React"));
  assert.ok(s.packageManagers.includes("pnpm"));
  assert.ok(s.testCommands.includes("npx vitest"));
});

test("Node signatures: scoped-prefix (Remix) matches; exact avoids preact→React", () => {
  const remix = tmp();
  writeFileSync(
    join(remix, "package.json"),
    JSON.stringify({
      dependencies: { "@remix-run/react": "2", "@remix-run/node": "2" },
    }),
  );
  assert.ok(detectStack(remix).frameworks.includes("Remix"), "scoped @remix-run/ prefix matches");

  const preact = tmp();
  writeFileSync(join(preact, "package.json"), JSON.stringify({ dependencies: { preact: "10" } }));
  const s = detectStack(preact);
  assert.ok(
    !s.frameworks.includes("React"),
    "preact must NOT be misreported as React (exact match)",
  );
});

test("python + Django: pytest + framework from requirements", () => {
  const root = tmp();
  writeFileSync(join(root, "requirements.txt"), "Django==5.0\npytest==8\n");
  const s = detectStack(root);
  assert.ok(s.languages.includes("Python"));
  assert.ok(s.frameworks.includes("Django"));
  assert.ok(s.testCommands.includes("pytest -q"));
  assert.ok(s.packageManagers.includes("pip"));
});

test("go, rust, ruby+rails, php+laravel, dotnet each detect", () => {
  const go = tmp();
  writeFileSync(join(go, "go.mod"), "module example.com/app\n\ngo 1.22\n");
  assert.deepEqual(detectStack(go).languages, ["Go"]);
  assert.ok(detectStack(go).testCommands.includes("go test ./..."));

  const rs = tmp();
  writeFileSync(join(rs, "Cargo.toml"), "[package]\nname='a'\n[dependencies]\naxum='0.7'\n");
  const rsS = detectStack(rs);
  assert.ok(rsS.languages.includes("Rust") && rsS.frameworks.includes("Axum"));

  const rb = tmp();
  writeFileSync(join(rb, "Gemfile"), "gem 'rails'\ngem 'rspec'\n");
  const rbS = detectStack(rb);
  assert.ok(rbS.languages.includes("Ruby") && rbS.frameworks.includes("Rails"));
  assert.ok(rbS.testCommands.includes("bundle exec rspec"));

  const php = tmp();
  writeFileSync(
    join(php, "composer.json"),
    JSON.stringify({ require: { "laravel/framework": "11" } }),
  );
  assert.ok(detectStack(php).frameworks.includes("Laravel"));

  const cs = tmp();
  writeFileSync(join(cs, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
  const csS = detectStack(cs);
  assert.ok(csS.languages.includes("C#") && csS.testCommands.includes("dotnet test"));
});

test("empty repo → empty but safe; corrupt manifest never throws", () => {
  const root = tmp();
  const s = detectStack(root);
  assert.deepEqual(s.languages, []);
  assert.deepEqual(s.testCommands, []);
  writeFileSync(join(root, "package.json"), "{ this is not json ");
  assert.doesNotThrow(() => detectStack(root));
});

test("testRunners: an explicit test script is the suite; a runner dependency is inventory (F09)", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "2" },
    }),
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const s = detectStack(root);
  // The declared script already runs vitest: the dependency is NOT a second obligation.
  assert.deepEqual(s.testCommands, ["pnpm test"]);
  assert.deepEqual(s.testInventory, ["npx vitest", "pnpm test"], "still visible as inventory");
  // descriptors: the DETECTED package manager, structured for a shell-free spawn
  assert.deepEqual(
    s.testRunners.find((r) => r.label === "pnpm test"),
    { bin: "pnpm", args: ["test"], label: "pnpm test" },
  );
  assert.equal(
    s.testRunners.find((r) => r.label === "npx vitest"),
    undefined,
  );

  // With NO declared script, the installed runner stands in as the (report-only) suite.
  const bare = tmp();
  writeFileSync(join(bare, "package.json"), JSON.stringify({ devDependencies: { vitest: "2" } }));
  const b = detectStack(bare);
  const npx = b.testRunners.find((r) => r.label === "npx vitest");
  assert.ok(npx && !npx.bin, "npx detections stay label-only — forge never executes npx");

  // npm's `npm init` placeholder is not a suite.
  const placeholder = tmp();
  writeFileSync(
    join(placeholder, "package.json"),
    JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
  );
  assert.deepEqual(detectStack(placeholder).testCommands, []);

  const go = tmp();
  writeFileSync(join(go, "go.mod"), "module x\n\ngo 1.22\n");
  const gs = detectStack(go);
  assert.deepEqual(gs.testCommands, ["go test ./..."]);
  assert.deepEqual(gs.testRunners, [
    { bin: "go", args: ["test", "./..."], label: "go test ./..." },
  ]);
});

test("ME-03: npm workspaces + nested packages → workspaces + packageRoots surfaced", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "monorepo",
      private: true,
      workspaces: ["packages/*", "apps/*"],
    }),
  );
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  writeFileSync(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  writeFileSync(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
  // A nested Python package under the same tree must also be surfaced.
  mkdirSync(join(root, "services", "api"), { recursive: true });
  writeFileSync(join(root, "services", "api", "pyproject.toml"), "[project]\nname='api'\n");

  const s = detectStack(root);
  assert.deepEqual(s.workspaces, ["apps/*", "packages/*"], JSON.stringify(s.workspaces));
  assert.ok(s.packageRoots.includes("packages/core"), JSON.stringify(s.packageRoots));
  assert.ok(s.packageRoots.includes("apps/web"));
  assert.ok(
    s.packageRoots.includes("services/api"),
    "nested non-root suites (even outside the globs) must not be silently ignored",
  );
});

test("ME-03: pnpm-workspace.yaml globs are parsed (zero-dep) and negations ignored", () => {
  const root = tmp();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pnpm-mono" }));
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n  - "!**/__tests__/**"\n',
  );
  mkdirSync(join(root, "packages", "lib"), { recursive: true });
  writeFileSync(join(root, "packages", "lib", "package.json"), JSON.stringify({ name: "lib" }));
  const s = detectStack(root);
  assert.deepEqual(s.workspaces, ["packages/*"], "negation entry dropped");
  assert.ok(s.packageRoots.includes("packages/lib"));
});

test("ME-03: a plain single-root repo has empty workspaces/packageRoots (shape unchanged)", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { next: "16" },
      scripts: { test: "vitest" },
    }),
  );
  const s = detectStack(root);
  assert.deepEqual(s.workspaces, [], "no workspace config → no globs");
  assert.deepEqual(s.packageRoots, [], "no nested manifests → no extra roots");
  // Pre-existing surface is untouched.
  assert.ok(s.frameworks.includes("Next.js"));
});

test("CLI: forge stack --json emits the detected stack", () => {
  const root = tmp();
  writeFileSync(join(root, "go.mod"), "module x\n\ngo 1.22\n");
  const r = spawnSync("node", [CLI, "stack", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.languages, ["Go"]);
});

// ---------------------------------------------------------------------------
// N03: a root script covers the workspaces only when it is an ESTABLISHED recursive run.
// ---------------------------------------------------------------------------

const RECURSIVE = [
  ["npm test --workspaces", "npm"],
  ["npm test --workspaces --if-present", "npm"],
  ["npm run test -ws", "npm"],
  ["npm --workspaces test", "npm"],
  ["pnpm -r test", "pnpm"],
  ["pnpm --recursive run test", "pnpm"],
  ["pnpm recursive test", "pnpm"],
  ["yarn workspaces run test", "yarn"],
  ["yarn workspaces foreach -A run test", "yarn"],
  ["yarn workspaces foreach --all -pt run test", "yarn"],
  ["yarn workspaces foreach -j 4 -A test", "yarn"],
  ["turbo run test", "turbo"],
  ["turbo run lint test", "turbo"],
  ["npx --yes turbo run test", "turbo"],
  ["./node_modules/.bin/turbo run test", "turbo"],
  ["lerna run test --stream", "lerna"],
  ["nx run-many -t test", "nx"],
  ["nx run-many --target=test --all", "nx"],
  ["npm run build && npm test --workspaces", "npm"],
  ["cross-env CI=1 turbo run test", "turbo"],
  ["CI=1 npm test -ws > log.txt 2>&1", "npm"],
  // Q02: the tool's installed binary may be spelled out; inert variables and `env -u` are fine
  ["node_modules/.bin/nx run-many -t test", "nx"],
  [String.raw`'.\node_modules\.bin\lerna.cmd' run test`, "lerna"],
  ["yarn turbo run test", "turbo"],
  ["pnpm exec turbo run test", "turbo"],
  ["NODE_OPTIONS='--max-old-space-size=4096 --experimental-vm-modules' turbo run test", "turbo"],
  ["env -u DEBUG NODE_ENV=test npm test --workspaces", "npm"],
  // round 2: options known to change nothing about which members run, or whether they fail
  ["pnpm -r --no-bail test", "pnpm"],
  ["turbo run test --force --continue", "turbo"],
  ["TURBO_FORCE=1 turbo run test", "turbo"],
  ["lerna run test --no-bail --skip-nx-cache", "lerna"],
  ["nx run-many -t test --skip-nx-cache --parallel=3", "nx"],
];

const NOT_RECURSIVE = [
  // Node's preload flag, and the same letter for other tools — the review's counterexample
  "node -r ./setup.cjs --test root.test.cjs",
  "mocha -r ts-node/register 'test/**/*.spec.ts'",
  // flag text that is only an argument (quoted or not)
  'node --test --test-name-pattern="--workspaces"',
  'echo "npm test --workspaces"',
  "echo npm test --workspaces",
  // filtered runs: a subset is not every member
  "npm test --workspace=a",
  "npm test -w packages/a -ws",
  // round 2 — options are ALLOWLISTED: anything unknown, and anything after `--` (forwarded
  // into every member's script), is not a whole run
  "npm test --workspaces -- --workspace=a",
  "npm test --workspaces --help",
  "npm test --workspaces --version",
  "npm test --workspaces --script-shell=true",
  "npm test --workspaces --prefi=other", // npm expands it to --prefix
  "npm run --workspaces --if-present --tag test lint", // `test` is --tag's value
  "pnpm --help -r test",
  "pnpm -r test --filter web", // forwarded to the scripts
  "yarn workspaces run test --grep x",
  "yarn workspaces foreach -A --dry-run run test",
  "yarn workspaces foreach -An run test",
  "nx run-many -t test --graph=stdout",
  "turbo run --cache-dir test lint", // runs `lint`
  "lerna run --profile-location test lint",
  // round 2 — a builtin changes what later commands do; a tool variable narrows the run
  "cd packages/good && npm test --workspaces",
  "trap 'exit 0' EXIT; npm test --workspaces",
  "node --test root.test.cjs && exit 0; npm test --workspaces",
  "export npm_config_workspace=packages/good && npm test --workspaces",
  "npm_config_workspace=packages/good npm test --workspaces",
  "npm_config_filter=good pnpm -r test",
  "pnpm -r --filter web test",
  "pnpm -r -F web test",
  "pnpm --filter=web -r test",
  "yarn workspaces foreach --include web run test",
  "yarn workspaces foreach -Rpt run test",
  "yarn workspace web test",
  "turbo run test --filter=web",
  "turbo run test -F web",
  "turbo run test --affected",
  "lerna run test --scope web",
  "nx run-many -t test -p web",
  "nx affected -t test",
  // runs that do not run the members' `test` script
  "turbo run build",
  "turbo run test:unit",
  "lerna run lint",
  "nx run-many -t lint",
  "npm run lint --workspaces && node --test",
  // runs whose failure never reaches the script's exit status
  "npm test --workspaces || true",
  "npm test --workspaces; node --test",
  "npm test --workspaces | tee log",
  "npm test --workspaces &",
  "node --test || npm test --workspaces",
  "! npm test -ws",
  // constructs the reader does not model are not established
  "npm test --workspaces $EXTRA",
  "(npm test -ws)",
  'npx -c "turbo run test"',
  // Q02 — a program named by a path is unknown, whatever its basename: the review's fixture,
  // other project files, system paths, another package's node_modules, and shims of package
  // managers (never project binaries)
  "./tools/npm test --workspaces",
  "tools/npm test --workspaces",
  "./scripts/pnpm.js -r test",
  "/usr/local/bin/npm test --workspaces",
  "'C:\\tools\\npm.cmd' test --workspaces",
  "npm.cmd test --workspaces",
  "./node_modules/.bin/npm test --workspaces",
  "packages/app/node_modules/.bin/turbo run test",
  "../node_modules/.bin/turbo run test",
  "./tools/cross-env CI=1 npm test --workspaces",
  "/usr/bin/env npm test --workspaces",
  "npx ./tools/turbo run test",
  "yarn ./tools/turbo run test",
  // Q02 — variables are ALLOWLISTED: PATH and anything that loads code or moves config
  "PATH=./tools:/usr/bin npm test --workspaces",
  "env PATH=./tools npm test --workspaces",
  "cross-env PATH=./tools npm test --workspaces",
  "LD_PRELOAD=./exit0.so npm test --workspaces",
  "NODE_OPTIONS=--require=./exit0.cjs npm test --workspaces",
  "NODE_OPTIONS='-r ./exit0.cjs' turbo run test",
  "NODE_OPTIONS=--unhandled-rejections=none npm test --workspaces",
  "HOME=./cfg npm test --workspaces",
  "FOO=1 npm test -ws",
  // Q02 — wrapper options that pick the binary, the directory or the environment
  "npx -p fake-turbo turbo run test",
  "npx --package=./tools/turbo turbo run test",
  "env -i npm test --workspaces",
  "env -C packages/good npm test --workspaces",
  "env --chdir=packages/good npm test --workspaces",
];

test("N03: known unfiltered recursive runs are recognized, with their tool", () => {
  for (const [script, tool] of RECURSIVE)
    assert.equal(recursiveTestInvocation(script)?.tool, tool, script);
});

test("N03: preload flags, quoted flag text, filters and masked runs are NOT recursive", () => {
  for (const script of NOT_RECURSIVE)
    assert.equal(recursiveTestInvocation(script), null, `${script} must not cover workspaces`);
});

test("N03: `npm run <script>` hops are followed (bounded, cycles refused)", () => {
  const scripts = {
    test: "npm run test:all",
    "test:all": "npm run test:ws",
    "test:ws": "turbo run test",
    a: "npm run b",
    b: "npm run a",
  };
  assert.deepEqual(recursiveTestInvocation(scripts.test, { scripts }), {
    tool: "turbo",
    command: "turbo run test",
    bypass: false,
    bins: ["npm", "turbo"],
  });
  // Q02: a hop through a program named by its path is not followed.
  const local = { test: "./tools/npm run test:ws", "test:ws": "npm test -ws" };
  assert.equal(recursiveTestInvocation(local.test, { scripts: local }), null);
  // A hop that passes arguments appends them to the followed script: never followed.
  const narrowed = { test: "npm run test:ws -- -w packages/good", "test:ws": "npm test -ws" };
  assert.equal(recursiveTestInvocation(narrowed.test, { scripts: narrowed }), null);
  const yarnHop = { test: "yarn test:ws --workspace=packages/good", "test:ws": "npm test -ws" };
  assert.equal(recursiveTestInvocation(yarnHop.test, { scripts: yarnHop }), null);
  assert.equal(recursiveTestInvocation("npm run a", { scripts }), null, "a cycle");
  const deep = { test: "npm run h1", h1: "npm run h2", h2: "npm run h3", h3: "npm run h4" };
  deep.h4 = "npm run h5";
  deep.h5 = "npm test -ws";
  assert.equal(recursiveTestInvocation(deep.test, { scripts: deep }), null, "over 4 hops");
});

test("N03: the shell reader resolves quotes and refuses what it cannot model", () => {
  assert.deepEqual(shellCommands(String.raw`a 'b c' "d\"e" && f | g; h`), [
    { words: ["a", "b c", 'd"e'], op: "&&" },
    { words: ["f"], op: "|" },
    { words: ["g"], op: ";" },
    { words: ["h"], op: null },
  ]);
  for (const bad of ["a $(b)", "a `b`", 'a "$HOME"', "a 'b", "a <<EOF", "{ a; }", "a &&"])
    assert.equal(shellCommands(bad), null, bad);
});

test("N03: membership honours the tool's own list and its negations", () => {
  assert.equal(isWorkspaceMember(["packages/*", "!packages/legacy"], "packages/web"), true);
  assert.equal(isWorkspaceMember(["packages/*", "!packages/legacy"], "packages/legacy"), false);
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["apps/*"], scripts: { test: "pnpm -r test" } }),
  );
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n  - '!packages/legacy'\n",
  );
  const run = recursiveTestRun(root);
  assert.equal(run?.tool, "pnpm");
  assert.deepEqual(
    run?.globs,
    ["packages/*", "!packages/legacy"],
    "pnpm reads its yaml, not package.json",
  );
});

// ---------------------------------------------------------------------------
// Q02: a run is credited to a tool only when the program that runs IS that tool.
// ---------------------------------------------------------------------------

/** A workspace root whose test script is `script`, with `files` beside it. */
const workspaceRoot = (script, files = {}) => {
  const root = tmp();
  const pkg = files["package.json"] ?? { workspaces: ["packages/*"], scripts: { test: script } };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  for (const [rel, text] of Object.entries(files)) {
    if (rel === "package.json") continue;
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};

test("Q02: a program named by its path is explained as not credited, never recognized", () => {
  const r = analyzeRecursiveTestRun(workspaceRoot("./tools/npm test --workspaces"));
  assert.equal(r?.tool, "npm");
  assert.equal(r?.command, "./tools/npm test --workspaces");
  assert.match(r?.refused ?? "", /`\.\/tools\/npm` is a program named by its path, not npm itself/);
  const hop = analyzeRecursiveTestRun(
    workspaceRoot("", {
      "package.json": {
        workspaces: ["packages/*"],
        scripts: { test: "./scripts/pnpm.js run all", all: "pnpm -r test" },
      },
    }),
  );
  assert.match(
    hop?.refused ?? "",
    /`\.\/scripts\/pnpm\.js` is a program named by its path, not pnpm itself/,
  );
  const path = analyzeRecursiveTestRun(workspaceRoot("PATH=./tools:/usr/bin npm test -ws"));
  assert.match(path?.refused ?? "", /the command line sets PATH, which changes the program/);
  const tool = analyzeRecursiveTestRun(workspaceRoot("npm_config_workspace=a npm test -ws"));
  assert.match(tool?.refused ?? "", /sets npm_config_workspace, which can narrow/);
  // what is no run at all stays unexplained
  assert.equal(analyzeRecursiveTestRun(workspaceRoot("./tools/check --all")), null);
  assert.equal(analyzeRecursiveTestRun(workspaceRoot("node --test")), null);
});

test("Q02: a bare name must not be shadowed by a project file", () => {
  const refused = (script, files) => analyzeRecursiveTestRun(workspaceRoot(script, files))?.refused;
  assert.equal(refused("npm test --workspaces", {}), undefined, "the baseline is established");
  // cmd.exe runs the package root's copy before the PATH's
  assert.match(
    refused("npm test --workspaces", { "npm.cmd": "@exit /b 0" }),
    /npm\.cmd in the package root shadows npm/,
  );
  assert.match(refused("cross-env CI=1 npm test -ws", { "cross-env.bat": "" }), /cross-env\.bat/);
  // package managers and system programs are never project binaries
  assert.match(
    refused("npx --yes npm test -ws", { "node_modules/.bin/npx": "" }),
    /shadows the package manager/,
  );
  assert.match(
    refused("env CI=1 npm test -ws", { "node_modules/.bin/env": "" }),
    /node_modules\/\.bin\/env shadows env/,
  );
  // an installed tool's binary must be its own package's
  const turbo = {
    "turbo.json": JSON.stringify({ tasks: { test: { cache: false } } }),
    "node_modules/.bin/turbo": "#!/bin/sh\nexit 0\n",
  };
  assert.match(
    refused("turbo run test", turbo),
    /node_modules\/\.bin\/turbo is not the turbo package's own binary/,
  );
  const fake = {
    "node_modules/turbo/package.json": JSON.stringify({ name: "not-turbo", bin: { turbo: "x" } }),
  };
  assert.match(
    refused("turbo run test", { ...turbo, ...fake }),
    /not the turbo package's own binary/,
  );
  const real = {
    "node_modules/turbo/package.json": JSON.stringify({
      name: "turbo",
      bin: { turbo: "bin/turbo" },
    }),
  };
  assert.equal(refused("turbo run test", { ...turbo, ...real }), undefined);
  assert.equal(refused("./node_modules/.bin/turbo run test", { ...turbo, ...real }), undefined);
  // a link must resolve into the package: one into a project file is not the tool
  const linked = (target) => {
    const root = workspaceRoot("turbo run test --force", {
      "turbo.json": turbo["turbo.json"],
      ...real,
      "node_modules/turbo/bin/turbo": "",
      "tools/fake-turbo": "#!/bin/sh\nexit 0\n",
    });
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    symlinkSync(target, join(root, "node_modules", ".bin", "turbo"));
    return analyzeRecursiveTestRun(root, { env: {} })?.refused;
  };
  assert.equal(linked("../turbo/bin/turbo"), undefined, "npm's own link");
  assert.match(linked("../../tools/fake-turbo") ?? "", /not the turbo package's own binary/);
});

test("Q02: nx plugins can redefine the test target — the members run on their own", () => {
  const refused = (nx) =>
    analyzeRecursiveTestRun(
      workspaceRoot("nx run-many -t test --skip-nx-cache", { "nx.json": JSON.stringify(nx) }),
      { env: {} },
    )?.refused;
  assert.equal(refused({}), undefined);
  assert.match(refused({ plugins: ["@nx/jest/plugin"] }) ?? "", /nx\.json plugins/);
});

test("Q02: the script PATH's parent directories are checked, and node-options must be inert", () => {
  // npm puts every parent directory's node_modules/.bin on a script's PATH, after the package's
  const outer = tmp();
  const root = join(outer, "repo");
  mkdirSync(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"], scripts: { test: "npm test --workspaces" } }),
  );
  mkdirSync(join(outer, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(outer, "node_modules", ".bin", "npm"), "#!/bin/sh\nexit 0\n");
  assert.match(
    analyzeRecursiveTestRun(root, { env: {} })?.refused ?? "",
    /\.\.\/node_modules\/\.bin\/npm shadows the package manager/,
  );
  // a tool hoisted to a parent is fine when it is that tool's own package
  const turbo = { "turbo.json": JSON.stringify({ tasks: { test: { cache: false } } }) };
  writeFileSync(join(root, "turbo.json"), turbo["turbo.json"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"], scripts: { test: "turbo run test" } }),
  );
  writeFileSync(join(outer, "node_modules", ".bin", "turbo"), "");
  assert.match(
    analyzeRecursiveTestRun(root, { env: {} })?.refused ?? "",
    /not the turbo package's/,
  );
  mkdirSync(join(outer, "node_modules", "turbo"));
  writeFileSync(
    join(outer, "node_modules", "turbo", "package.json"),
    JSON.stringify({ name: "turbo", bin: { turbo: "bin/turbo" } }),
  );
  assert.equal(analyzeRecursiveTestRun(root, { env: {} })?.refused, undefined);
  // node-options preloads code into every script npm starts: only inert flags are allowed
  const refused = (npmrc, env = {}) =>
    analyzeRecursiveTestRun(workspaceRoot("npm test --workspaces", { ".npmrc": npmrc }), { env })
      ?.refused;
  assert.equal(refused("node-options=--max-old-space-size=4096\n"), undefined);
  assert.match(refused("node-options=--require ./exit0.cjs\n"), /\.npmrc sets node-options/);
  assert.match(
    refused("", { npm_config_node_options: "--import=./exit0.mjs" }),
    /environment sets npm_config_node_options/,
  );
});

test("Q02: yarn must be a release — yarnPath elsewhere, or a packageManager URL, is refused", () => {
  const refused = (files) =>
    analyzeRecursiveTestRun(workspaceRoot("yarn workspaces foreach -A run test", files))?.refused;
  assert.equal(refused({}), undefined);
  assert.equal(refused({ ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.5.0.cjs\n" }), undefined);
  assert.equal(refused({ ".yarnrc": 'yarn-path ".yarn/releases/yarn-1.22.22.cjs"\n' }), undefined);
  assert.match(
    refused({ ".yarnrc.yml": "yarnPath: tools/yarn.cjs # pinned\n" }),
    /\.yarnrc\.yml points yarn at tools\/yarn\.cjs, not a release/,
  );
  const url = {
    "package.json": {
      workspaces: ["packages/*"],
      packageManager: "yarn@https://example.invalid/yarn.tgz#sha1.x",
      scripts: { test: "yarn workspaces foreach -A run test" },
    },
  };
  assert.match(
    refused(url),
    /packageManager fetches yarn from https:\/\/example\.invalid\/yarn\.tgz/,
  );
  // a pinned registry release with its integrity hash is fine
  const pinned = {
    ...url,
    "package.json": { ...url["package.json"], packageManager: "yarn@4.5.0+sha512.abc" },
  };
  assert.equal(refused(pinned), undefined);
});

test("Q02: a script-shell that is a project file is not a shell", () => {
  const root = tmp();
  const shell = (value) => {
    writeFileSync(join(root, ".npmrc"), `script-shell=${value}\n`);
    return scriptShellProblem(root, {});
  };
  assert.equal(shell("/bin/bash"), null);
  assert.equal(shell("bash"), null);
  assert.match(shell("./tools/bash") ?? "", /a program inside the project/);
  assert.match(shell(join(root, "tools", "sh")) ?? "", /a program inside the project/);
  assert.match(shell("/bin/true") ?? "", /not a shell that runs the script as written/);
});
