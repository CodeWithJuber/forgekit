// dep-gate, the generic half: every ecosystem, every way a dependency arrives (an install
// command, a manifest edit, an install that reads a manifest), private sources, and the cache.
// Hermetic: the network, the filesystem and the clock are all injected.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE, MENTIONS_PACKAGE_MANAGER, route } from "../global/guards/dep-gate.mjs";
import {
  COMMANDS,
  depgateDecision,
  depgateEditDecision,
  ECOSYSTEMS,
  EXISTS_URLS,
  editAdditions,
  FLAGS,
  fileCache,
  judge,
  MANIFESTS,
  manifestDeps,
  parseInstalls,
  parseVetArg,
  probePackage,
  SPEC_PARSERS,
  VET_PREFIXES,
} from "../src/depgate.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 13);
const ECOS = Object.keys(ECOSYSTEMS);
const posix = (p) => p.replaceAll("\\", "/");
const label = (p) => `${p.eco}:${p.name}${p.version ? `@${p.version}` : ""}`;

/** A project on a fake disk: `files` maps a POSIX path to its text. */
const disk = (files = {}, present = []) => ({
  cwd: "/r",
  exists: (p) => present.includes(posix(p)),
  readText: (p) => files[posix(p)] ?? null,
});
const pkgs = (command, fs = disk()) => parseInstalls(command, fs).packages.map(label);

/** A fake internet keyed by URL substring: `registry` → HTTP status (absent = 404), `depsdev`
 *  → a document (absent = 404), `osv` → the vulns list. Records every request in `seen`. */
function net({ registry = {}, depsdev = {}, osv = () => [], seen = [] } = {}) {
  return async (url, init = {}) => {
    seen.push(`${init.method ?? "GET"} ${url}`);
    if (url.startsWith("https://api.osv.dev/")) {
      const q = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ vulns: osv(q.package, q.version) }) };
    }
    if (url.startsWith("https://api.deps.dev/")) {
      const key = Object.keys(depsdev).find((k) => decodeURIComponent(url).includes(k));
      return key
        ? { ok: true, status: 200, json: async () => depsdev[key] }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    const key = Object.keys(registry).find((k) => url.includes(k));
    const status = key ? registry[key] : 404;
    return { ok: status === 200, status };
  };
}

/** A deps.dev document with one release per entry of `ages` (days before NOW, oldest first). */
const history = (name, ages) => ({
  versions: ages.map((d, i) => ({
    versionKey: { name, version: `1.${i}.0` },
    publishedAt: new Date(NOW - d * DAY).toISOString(),
    isDefault: i === ages.length - 1,
  })),
});
const OLD = [4000, 3000, 2000, 1000, 500, 200];
/** A Maven property reference, spelled so no linter reads it as a JS template placeholder. */
const PROPERTY_REF = ["$", "{x.version}"].join("");
const ctx = (fs = disk()) => ({ ...fs, env: {}, home: "", allow: [], nowMs: NOW, cache: null });

// ── one table per concern, and the tables agree ────────────────────────────────────────────

test("every ecosystem is complete: a spec parser, flags, a registry probe, a vet prefix", () => {
  assert.deepEqual(ECOS.sort(), [
    "cargo",
    "go",
    "maven",
    "npm",
    "nuget",
    "packagist",
    "pub",
    "pypi",
    "rubygems",
  ]);
  for (const eco of ECOS) {
    assert.equal(typeof SPEC_PARSERS[eco], "function", `${eco}: spec parser`);
    assert.ok(FLAGS[eco]?.value instanceof Set, `${eco}: flags`);
    assert.equal(typeof EXISTS_URLS[eco], "function", `${eco}: registry probe`);
    assert.ok(Object.values(VET_PREFIXES).includes(eco), `${eco}: a vet prefix`);
    assert.equal(typeof ECOSYSTEMS[eco].authoritative, "boolean", `${eco}: authoritative flag`);
  }
  // Every command rule and every manifest names an ecosystem the tables know.
  for (const r of COMMANDS) assert.ok(ECOS.includes(r.eco), `command rule → ${r.eco}`);
  for (const m of MANIFESTS) assert.ok(ECOS.includes(m.eco), `manifest → ${m.eco}`);
  // …and every ecosystem can arrive by a command or by a manifest (most by both).
  for (const eco of ECOS)
    assert.ok(
      COMMANDS.some((r) => r.eco === eco) || MANIFESTS.some((m) => m.eco === eco),
      `${eco}: reachable`,
    );
});

// ── install commands, every package manager ────────────────────────────────────────────────

test("parseInstalls: Go, Ruby, PHP, .NET and Dart name their packages", () => {
  const cases = {
    "go get github.com/spf13/cobra@v1.8.0": ["go:github.com/spf13/cobra@v1.8.0"],
    "go install golang.org/x/tools/gopls@latest": ["go:golang.org/x/tools/gopls"],
    "gem install rails -v 7.1.0": ["rubygems:rails@7.1.0"],
    "bundle add sidekiq --version '~> 7.0'": ["rubygems:sidekiq"],
    "composer require monolog/monolog:^3.0 symfony/console": [
      "packagist:monolog/monolog",
      "packagist:symfony/console",
    ],
    "dotnet add package Newtonsoft.Json --version 13.0.3": ["nuget:Newtonsoft.Json@13.0.3"],
    "dotnet add src/App.csproj package Serilog": ["nuget:Serilog"],
    "nuget install NUnit -Version 4.0.0": ["nuget:NUnit@4.0.0"],
    "dart pub add http:^1.2.0": ["pub:http"],
    "flutter pub add provider": ["pub:provider"],
    "python3 -m pip install fastapi": ["pypi:fastapi"],
    "uv add httpx": ["pypi:httpx"],
    "poetry add 'pydantic>=2'": ["pypi:pydantic"],
    "pipx install black": ["pypi:black"],
    "uvx ruff check": ["pypi:ruff"],
    "pnpm dlx create-vite": ["npm:create-vite"],
    "bunx cowsay hi": ["npm:cowsay"],
  };
  for (const [command, want] of Object.entries(cases))
    assert.deepEqual(pkgs(command), want, command);
});

test("parseInstalls: the label says what was typed, so a verdict can be traced to its command", () => {
  const via = (command) => parseInstalls(command, disk()).packages.map((p) => p.via);
  assert.deepEqual(via("go install golang.org/x/tools/gopls@latest"), ["go install"]);
  assert.deepEqual(via("dotnet add src/App.csproj package Serilog"), ["dotnet add package"]);
  assert.deepEqual(via("python3 -m pip install fastapi"), ["pip install"]);
});

test("parseInstalls: a lockfile sync or a local pattern names nothing new", () => {
  for (const command of [
    "go mod tidy",
    "go get -u ./...",
    "go build ./cmd/app",
    "bundle install",
    "composer install",
    "dart pub get",
    "dotnet restore",
    "dotnet build",
  ])
    assert.deepEqual(pkgs(command), [], command);
});

test("parseInstalls: a flag that points at a private source is reported, per ecosystem", () => {
  const custom = (command) => parseInstalls(command, disk());
  for (const [command, eco] of [
    ["npm i --registry https://npm.corp x", "npm"],
    ["pip install --index-url https://m/simple y", "pypi"],
    ["cargo add serde --git https://example.com/serde", "cargo"],
    ["gem install foo --source https://gems.corp", "rubygems"],
  ]) {
    const r = custom(command);
    assert.deepEqual(r.packages, [], command);
    assert.deepEqual(r.custom, [eco], command);
  }
});

// ── installs that read a manifest ──────────────────────────────────────────────────────────

test("parseInstalls: `npm install` with no names vets what package.json declares and is not installed", () => {
  const files = {
    "/r/package.json": JSON.stringify({
      dependencies: { express: "^4.19.0", "left-pad": "1.3.0" },
      devDependencies: { vitest: "^2" },
    }),
  };
  const fs = disk(files, ["/r/node_modules/express/package.json"]);
  const want = ["npm:left-pad@1.3.0", "npm:vitest"];
  for (const command of ["npm install", "npm ci", "yarn", "pnpm install --frozen-lockfile"])
    assert.deepEqual(pkgs(command, fs), want, command);
  // A named install vets the names, not the whole manifest.
  assert.deepEqual(pkgs("npm install zod", fs), ["npm:zod"]);
  // No manifest to read: nothing to say, never a guess.
  assert.deepEqual(pkgs("npm install"), []);
});

test("parseInstalls: `pip install -r` reads the file, and the files it includes", () => {
  const files = {
    "/r/requirements.txt": "requests==2.31.0\n# pinned\nflask>=2\n-r extra/more.txt\n",
    "/r/extra/more.txt": "numpy\n-r ../requirements.txt\n-r deeper.txt\n",
    "/r/extra/deeper.txt": "scipy==1.13.0\n",
  };
  assert.deepEqual(pkgs("pip install -r requirements.txt", disk(files)), [
    "pypi:requests@2.31.0",
    "pypi:flask",
    "pypi:numpy",
    "pypi:scipy@1.13.0",
  ]);
  // A missing file is nothing to vet; a file that names its own index is not public.
  assert.deepEqual(pkgs("pip install -r requirements.txt"), []);
  const corp = { "/r/requirements.txt": "--index-url https://pypi.corp/simple\ninternal-lib\n" };
  assert.deepEqual(pkgs("pip install -r requirements.txt", disk(corp)), []);
});

// ── manifests ──────────────────────────────────────────────────────────────────────────────

test("manifestDeps: each manifest format yields its registry dependencies", () => {
  const deps = (file, text) => manifestDeps(file, text)?.map(label);
  assert.deepEqual(
    deps(
      "package.json",
      JSON.stringify({
        dependencies: { a: "^1", b: "file:../b", c: "npm:real@2", "@s/d": "workspace:*" },
        optionalDependencies: { e: "1.2.3" },
      }),
    ),
    ["npm:a", "npm:real", "npm:e@1.2.3"],
  );
  assert.deepEqual(deps("requirements-dev.txt", "requests==2.31.0\nflask>=2 # web\n-e .\n"), [
    "pypi:requests@2.31.0",
    "pypi:flask",
  ]);
  assert.deepEqual(
    deps(
      "pyproject.toml",
      '[project]\ndependencies = [\n  "httpx>=0.27",\n  "rich",\n]\n[project.optional-dependencies]\ndev = ["pytest==8.0.0"]\n[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^5.0"\n',
    ),
    ["pypi:httpx", "pypi:rich", "pypi:pytest@8.0.0", "pypi:django"],
  );
  assert.deepEqual(
    deps(
      "Cargo.toml",
      '[dependencies]\nserde = "1.0"\ntokio = { version = "1.38", features = ["full"] }\nlocal = { path = "../l" }\n[dev-dependencies]\ncriterion = "0.5"\n',
    ),
    ["cargo:serde", "cargo:tokio", "cargo:criterion"],
  );
  assert.deepEqual(
    deps(
      "go.mod",
      "module example.com/m\n\ngo 1.23\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n\tgolang.org/x/sync v0.7.0 // indirect\n)\nrequire github.com/a/b v1.0.0\n",
    ),
    ["go:github.com/spf13/cobra@v1.8.0", "go:golang.org/x/sync@v0.7.0", "go:github.com/a/b@v1.0.0"],
  );
  assert.deepEqual(
    deps(
      "Gemfile",
      'source "https://rubygems.org"\ngem "rails", "~> 7.1"\ngem \'pg\'\ngem "mine", path: "../mine"\n',
    ),
    ["rubygems:rails", "rubygems:pg"],
  );
  assert.deepEqual(
    deps(
      "composer.json",
      JSON.stringify({
        require: { php: ">=8.1", "ext-json": "*", "monolog/monolog": "^3.0" },
        "require-dev": { "phpunit/phpunit": "^11" },
      }),
    ),
    ["packagist:monolog/monolog", "packagist:phpunit/phpunit"],
  );
  assert.deepEqual(
    deps(
      "pubspec.yaml",
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.2.0\n  provider: 6.1.2\ndev_dependencies:\n  lints: ^4.0.0\n",
    ),
    ["pub:http", "pub:provider@6.1.2", "pub:lints"],
  );
  assert.deepEqual(
    deps(
      "pom.xml",
      `<project><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.9</version></dependency><dependency><groupId>com.acme</groupId><artifactId>x</artifactId><version>${PROPERTY_REF}</version></dependency></dependencies></project>`,
    ),
    ["maven:org.slf4j:slf4j-api@2.0.9", "maven:com.acme:x"],
  );
  assert.deepEqual(
    deps(
      "build.gradle.kts",
      'dependencies {\n  implementation("com.squareup.okhttp3:okhttp:4.12.0")\n  testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")\n  implementation(project(":core"))\n}\n',
    ),
    ["maven:com.squareup.okhttp3:okhttp@4.12.0", "maven:org.junit.jupiter:junit-jupiter@5.10.2"],
  );
  assert.deepEqual(
    deps(
      "libs.versions.toml",
      '[versions]\nok = "4.12.0"\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "ok" }\nguava = "com.google.guava:guava:33.0.0-jre"\n',
    ),
    ["maven:com.squareup.okhttp3:okhttp", "maven:com.google.guava:guava@33.0.0-jre"],
  );
  assert.deepEqual(
    deps(
      "App.csproj",
      '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /><PackageReference Include="Serilog"><Version>3.1.1</Version></PackageReference></ItemGroup></Project>',
    ),
    ["nuget:Newtonsoft.Json@13.0.3", "nuget:Serilog"],
  );
  assert.deepEqual(
    deps("packages.config", '<packages><package id="NUnit" version="3.14.0" /></packages>'),
    ["nuget:NUnit@3.14.0"],
  );
  // Not a manifest: nothing, not an error.
  assert.deepEqual(deps("README.md", "express"), []);
});

test("manifestDeps: a manifest that names its own package source is not vetted publicly", () => {
  for (const [file, text] of [
    ["requirements.txt", "--extra-index-url https://pypi.corp/simple\ninternal-lib\n"],
    [
      "pyproject.toml",
      '[project]\ndependencies = ["x"]\n[[tool.uv.index]]\nurl = "https://pypi.corp"\n',
    ],
    ["Gemfile", 'source "https://gems.corp"\ngem "internal"\n'],
  ])
    assert.equal(manifestDeps(file, text), null, file);
});

// ── edits ──────────────────────────────────────────────────────────────────────────────────

test("editAdditions: only what the edit ADDS to a manifest, whichever edit tool wrote it", () => {
  const pj = JSON.stringify({ dependencies: { express: "^4.19.0", axios: "1.7.2" } }, null, 2);
  const add = (toolName, toolInput, files = { "/r/package.json": pj }) =>
    editAdditions({ toolName, toolInput, ...disk(files) }).map(label);
  const file_path = "/r/package.json";

  const rewritten = JSON.stringify({
    dependencies: { express: "^4.19.0", axios: "1.7.2", zod: "^3.23.0" },
  });
  assert.deepEqual(add("Write", { file_path, content: rewritten }), ["npm:zod"]);
  assert.deepEqual(
    add("Edit", {
      file_path,
      old_string: '"express": "^4.19.0"',
      new_string: '"express": "^4.19.0",\n    "lodash": "4.17.21"',
    }),
    ["npm:lodash@4.17.21"],
  );
  assert.deepEqual(
    add(
      "MultiEdit",
      {
        file_path: "/r/go.mod",
        edits: [{ old_string: "require (", new_string: "require (\n\tgithub.com/x/y v1.2.3" }],
      },
      { "/r/go.mod": "module m\n\nrequire (\n)\n" },
    ),
    ["go:github.com/x/y@v1.2.3"],
  );
  // A brand-new manifest: everything in it is new.
  assert.deepEqual(
    add("Write", { file_path: "/r/requirements.txt", content: "requests==2.31.0\n" }, {}),
    ["pypi:requests@2.31.0"],
  );
  // A relative path resolves against the working directory.
  assert.deepEqual(add("Write", { file_path: "package.json", content: rewritten }), ["npm:zod"]);

  // A widened range adds no release to look up; a moved exact pin does.
  assert.deepEqual(
    add("Edit", {
      file_path,
      old_string: '"express": "^4.19.0"',
      new_string: '"express": "^4.20.0"',
    }),
    [],
  );
  assert.deepEqual(
    add("Edit", { file_path, old_string: '"axios": "1.7.2"', new_string: '"axios": "1.7.9"' }),
    ["npm:axios@1.7.9"],
  );
  // Removing a dependency, editing another file, or an edit that does not apply: nothing.
  assert.deepEqual(add("Write", { file_path, content: JSON.stringify({ dependencies: {} }) }), []);
  assert.deepEqual(
    add("Write", { file_path: "/r/src/index.js", content: "import x from 'zod'" }),
    [],
  );
  assert.deepEqual(
    add("Edit", { file_path, old_string: "not in the file", new_string: '"zod": "1.0.0"' }),
    [],
  );
  assert.deepEqual(add("Read", { file_path }), []);
});

test("depgateEditDecision: an invented name written into a manifest is denied before the write", async () => {
  const files = {
    "/r/package.json": JSON.stringify({ dependencies: { express: "^4.19.0" } }, null, 2),
  };
  const content = JSON.stringify({
    dependencies: { express: "^4.19.0", "totally-invented-pkg": "^1.0.0" },
  });
  const denied = await depgateEditDecision({
    toolName: "Write",
    toolInput: { file_path: "/r/package.json", content },
    ...ctx(disk(files)),
    fetchImpl: net(),
  });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /totally-invented-pkg \(npm\) is not on the npm registry/);

  const seen = [];
  const fine = await depgateEditDecision({
    toolName: "Edit",
    toolInput: {
      file_path: "/r/package.json",
      old_string: '"express": "^4.19.0"',
      new_string: '"express": "^4.19.0",\n    "lodash": "4.17.21"',
    },
    ...ctx(disk(files)),
    fetchImpl: net({
      registry: { "/lodash": 200 },
      depsdev: { lodash: history("lodash", OLD) },
      seen,
    }),
  });
  assert.equal(fine.decision, "allow");
  assert.deepEqual(
    fine.results.map((r) => [label(r.pkg), r.judgment.level]),
    [["npm:lodash@4.17.21", "ok"]],
  );

  // Not a manifest: no work, no network.
  const quiet = [];
  const other = await depgateEditDecision({
    toolName: "Write",
    toolInput: { file_path: "/r/src/a.js", content: "x" },
    ...ctx(),
    fetchImpl: net({ seen: quiet }),
  });
  assert.equal(other.decision, "allow");
  assert.deepEqual(quiet, []);
  // The kill switch covers edits too.
  const off = await depgateEditDecision({
    toolName: "Write",
    toolInput: { file_path: "/r/package.json", content },
    ...ctx(disk(files)),
    env: { FORGE_DEPGATE: "0" },
    fetchImpl: net({ seen: quiet }),
  });
  assert.equal(off.decision, "allow");
  assert.deepEqual(quiet, []);
});

// ── evidence and judgment across registries ────────────────────────────────────────────────

test("EXISTS_URLS: each registry is asked in its own URL grammar", () => {
  const urls = (eco, name) => EXISTS_URLS[eco](name).map((c) => c.url);
  assert.deepEqual(urls("maven", "org.slf4j:slf4j-api"), [
    "https://repo1.maven.org/maven2/org/slf4j/slf4j-api/maven-metadata.xml",
  ]);
  // NuGet ids are case-insensitive and the flat container is lower-case.
  assert.deepEqual(urls("nuget", "Newtonsoft.Json"), [
    "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json",
  ]);
  assert.deepEqual(urls("rubygems", "rails"), ["https://rubygems.org/api/v1/gems/rails.json"]);
  assert.deepEqual(urls("packagist", "monolog/monolog"), [
    "https://repo.packagist.org/p2/monolog/monolog.json",
  ]);
  assert.deepEqual(urls("pub", "http"), ["https://pub.dev/api/packages/http"]);
  // A Go import path may be a package INSIDE a module: the module root is found by walking up,
  // and the proxy spells an upper-case letter as `!` + lower-case.
  const go = EXISTS_URLS.go("github.com/Azure/azure-sdk-for-go/sdk/azcore");
  assert.deepEqual(
    go.map((c) => c.name),
    [
      "github.com/Azure/azure-sdk-for-go/sdk/azcore",
      "github.com/Azure/azure-sdk-for-go/sdk",
      "github.com/Azure/azure-sdk-for-go",
    ],
  );
  assert.equal(
    go[0].url,
    "https://proxy.golang.org/github.com/!azure/azure-sdk-for-go/sdk/azcore/@v/list",
  );
});

test("probePackage: a Go package path resolves to the module that holds it", async () => {
  const seen = [];
  const ev = await probePackage(
    {
      eco: "go",
      name: "github.com/Azure/azure-sdk-for-go/sdk/azcore/policy",
      version: null,
      via: "t",
    },
    { fetchImpl: net({ registry: { "/sdk/azcore/@v/list": 200 }, seen }) },
  );
  assert.equal(ev.exists, true);
  assert.equal(ev.canonical, "github.com/Azure/azure-sdk-for-go/sdk/azcore");
  // The index is asked about the module that exists, not the path that was typed.
  assert.ok(
    seen.some((u) => u.includes("api.deps.dev") && decodeURIComponent(u).endsWith("/sdk/azcore")),
  );
});

test("judge: a miss on a registry that is not the only source asks; on the only source it denies", () => {
  const miss = {
    exists: false,
    canonical: null,
    indexed: null,
    firstPublishedAt: null,
    versions: null,
    latest: null,
    malicious: null,
    advisories: null,
  };
  for (const eco of ECOS) {
    const j = judge({ eco, name: "some/name", version: null, via: "t" }, miss, NOW);
    assert.equal(j.level, ECOSYSTEMS[eco].authoritative ? "deny" : "ask", eco);
    assert.match(j.reasons[0], new RegExp(`is not on ${ECOSYSTEMS[eco].label}`), eco);
  }
  // Go modules, Maven and NuGet are routinely served from a company proxy: a human decides.
  assert.deepEqual(ECOS.filter((eco) => !ECOSYSTEMS[eco].authoritative).sort(), [
    "go",
    "maven",
    "nuget",
  ]);
});

test("depgateDecision: an unknown Go module pauses for a human instead of blocking", async () => {
  const d = await depgateDecision({
    command: "go get github.com/acme/internal-lib@v1.0.0",
    ...ctx(),
    fetchImpl: net(),
  });
  assert.equal(d.decision, "ask");
  assert.match(
    d.reason,
    /github\.com\/acme\/internal-lib@v1\.0\.0 \(go\) is not on the Go module proxy — invented, or served from a private source\. /,
  );
});

// ── the cache ──────────────────────────────────────────────────────────────────────────────

test("fileCache: remembers a clean verdict for a week, then asks again", () => {
  const path = join(mkdtempSync(join(tmpdir(), "depgate-")), "cache.json");
  const cache = fileCache({ path, nowMs: NOW });
  assert.equal(cache.has("npm:a@1.0.0"), false);
  cache.add(["npm:a@1.0.0"]);
  assert.equal(cache.has("npm:a@1.0.0"), true);
  assert.equal(fileCache({ path, nowMs: NOW + 6 * DAY }).has("npm:a@1.0.0"), true);
  assert.equal(fileCache({ path, nowMs: NOW + 8 * DAY }).has("npm:a@1.0.0"), false);
  // A file that cannot be read or written is an empty cache, never an error.
  const broken = fileCache({ path: join(path, "under-a-file", "c.json"), nowMs: NOW });
  assert.equal(broken.has("npm:a@1.0.0"), false);
  assert.doesNotThrow(() => broken.add(["npm:a@1.0.0"]));
});

test("depgateDecision: a package that passed is not asked about again; a risky one always is", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "depgate-")), "cache.json");
  const cache = fileCache({ path, nowMs: NOW });
  const seen = [];
  const table = {
    registry: { "/express": 200 },
    depsdev: { express: history("express", OLD) },
    seen,
  };
  const first = await depgateDecision({
    command: "npm install express",
    ...ctx(),
    cache,
    fetchImpl: net(table),
  });
  assert.equal(first.decision, "allow");
  const asked = seen.length;
  assert.ok(asked > 0);
  const second = await depgateDecision({
    command: "npm install express",
    ...ctx(),
    cache,
    fetchImpl: net(table),
  });
  assert.equal(second.decision, "allow");
  assert.equal(seen.length, asked, "the second run made no request");
  assert.equal(second.results[0].cached, true);

  // A denial is never cached: the name may be registered tomorrow, by anyone.
  const calls = [];
  for (let i = 0; i < 2; i++) {
    const d = await depgateDecision({
      command: "npm install not-a-real-package",
      ...ctx(),
      cache,
      fetchImpl: net({ seen: calls }),
    });
    assert.equal(d.decision, "deny");
  }
  assert.equal(calls.length, 2, "asked both times");
});

// ── the guard wiring ───────────────────────────────────────────────────────────────────────

test("guard: routes a shell install to the command gate and a manifest edit to the edit gate", () => {
  const r = (tool_name, tool_input) => route({ tool_name, tool_input });
  assert.equal(r("Bash", { command: "npm install x" }), "command");
  assert.equal(r("Bash", { command: "go get github.com/a/b" }), "command");
  assert.equal(r("Bash", { command: "ls -la" }), null);
  assert.equal(r("Edit", { file_path: "/r/package.json" }), "edit");
  assert.equal(r("Write", { file_path: "/r/services/api/requirements-dev.txt" }), "edit");
  assert.equal(r("MultiEdit", { file_path: "C:\\r\\App.csproj" }), "edit");
  assert.equal(r("Write", { file_path: "/r/src/a.ts" }), null);
  assert.equal(r("Read", { file_path: "/r/package.json" }), null);
  assert.equal(route({}), null);
});

test("guard: the cheap pre-filters agree with the tables they stand in for", () => {
  // Every manifest the extractor knows wakes the guard (a miss here is a silent hole).
  for (const name of [
    "package.json",
    "requirements.txt",
    "constraints.in",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "gems.rb",
    "composer.json",
    "pubspec.yaml",
    "pom.xml",
    "build.gradle",
    "settings.gradle.kts",
    "libs.versions.toml",
    "App.csproj",
    "Lib.fsproj",
    "Directory.Packages.props",
    "packages.config",
  ]) {
    assert.ok(
      MANIFESTS.some((m) => m.match.test(name)),
      `${name}: a known manifest`,
    );
    assert.ok(MANIFEST_FILE.test(`/r/${name}`), `${name}: wakes the guard`);
  }
  for (const name of ["index.js", "README.md", "package-lock.json", "go.sum"])
    assert.equal(MANIFEST_FILE.test(`/r/${name}`), false, name);
  // Every tool a command rule matches is a word the command pre-filter wakes for.
  for (const tool of [
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "npx",
    "pip",
    "uv",
    "poetry",
    "cargo",
    "go",
    "gem",
    "bundle",
    "composer",
    "dotnet",
    "nuget",
    "dart",
    "flutter",
  ]) {
    assert.ok(
      COMMANDS.some((r) => r.tool.test(tool)),
      `${tool}: has a command rule`,
    );
    assert.ok(MENTIONS_PACKAGE_MANAGER.test(`${tool} something`), `${tool}: wakes the guard`);
  }
});

test("hook manifests: dep-gate runs before shell commands AND before file edits", () => {
  for (const rel of ["../hooks/hooks.json", "../global/settings.template.json"]) {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
    const group = manifest.hooks.PreToolUse.find((g) =>
      g.hooks.some((h) => JSON.stringify(h).includes("dep-gate.sh")),
    );
    assert.ok(group, `${rel}: dep-gate is wired`);
    for (const tool of ["Bash", "Edit", "Write", "MultiEdit"])
      assert.match(tool, new RegExp(`^(?:${group.matcher})$`), `${rel}: ${tool}`);
  }
});

// ── forge vet ──────────────────────────────────────────────────────────────────────────────

test("parseVetArg: every ecosystem by its prefix, and `name@version` everywhere", () => {
  const vet = (arg) => {
    const p = parseVetArg(arg);
    return p ? label(p) : null;
  };
  assert.equal(vet("go:github.com/spf13/cobra@v1.8.0"), "go:github.com/spf13/cobra@v1.8.0");
  assert.equal(vet("maven:org.slf4j:slf4j-api:2.0.9"), "maven:org.slf4j:slf4j-api@2.0.9");
  assert.equal(vet("gradle:org.slf4j:slf4j-api@2.0.9"), "maven:org.slf4j:slf4j-api@2.0.9");
  assert.equal(vet("nuget:Serilog@3.1.1"), "nuget:Serilog@3.1.1");
  assert.equal(vet("dotnet:Serilog"), "nuget:Serilog");
  assert.equal(vet("gem:rails@7.1.0"), "rubygems:rails@7.1.0");
  assert.equal(vet("composer:monolog/monolog@3.5.0"), "packagist:monolog/monolog@3.5.0");
  assert.equal(vet("pub:http@1.2.0"), "pub:http@1.2.0");
  assert.equal(vet("pip:requests==2.31.0"), "pypi:requests@2.31.0");
  assert.equal(vet("crates:serde@1.0.0"), "cargo:serde@1.0.0");
  assert.equal(vet("@types/node@20.11.0"), "npm:@types/node@20.11.0");
  // A range is not a release: the name is vetted, no version is claimed.
  assert.equal(vet("gem:rails@~>7"), null);
  assert.equal(vet("npm:left-pad@^1.3"), "npm:left-pad");
  assert.equal(vet("./local/path"), null);
});
