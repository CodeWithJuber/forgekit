import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookResponse, MENTIONS_PACKAGE_MANAGER } from "../global/guards/dep-gate.mjs";
import { GUARD_POLICY } from "../global/guards/run.mjs";
import {
  customRegistries,
  DEPGATE_THRESHOLDS,
  DEPGATE_WEIGHTS,
  depgateDecision,
  ECOSYSTEMS,
  EXISTS_URLS,
  isAllowed,
  judge,
  MAX_PACKAGES,
  parseInstalls,
  parseVetArg,
  probePackage,
  SPEC_PARSERS,
  YOUTH_HALF_LIFE_DAYS,
} from "../src/depgate.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 13);
const noBins = { exists: () => false, readText: () => null };
/** `customRegistries` when nothing points away from the public registries. */
const OFF = {
  ...Object.fromEntries(Object.keys(ECOSYSTEMS).map((eco) => [eco, false])),
  npmScopes: [],
};

/** `eco:name[@version]` for every package a command line would fetch. */
const pkgs = (command, opts = noBins) =>
  parseInstalls(command, opts).packages.map(
    (p) => `${p.eco}:${p.name}${p.version ? `@${p.version}` : ""}`,
  );

// A fake internet: dispatches on URL, records what it saw so a test can prove a probe did
// (or did NOT) happen. `registry[name]` is the HTTP status its own registry answers with,
// `depsdev[name]` a deps.dev document (absent = 404), `osv` a function (name, version) → vulns.
function fakeFetch({ registry = {}, depsdev = {}, osv = () => [], seen = [], fail = [] } = {}) {
  return async (url, init = {}) => {
    seen.push(`${init.method ?? "GET"} ${url}`);
    if (fail.some((f) => url.includes(f))) throw new Error("ECONNREFUSED");
    if (url.startsWith("https://api.osv.dev/")) {
      const q = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ vulns: osv(q.package.name, q.version) }),
      };
    }
    if (url.startsWith("https://api.deps.dev/")) {
      const name = decodeURIComponent(url.split("/packages/")[1]);
      const doc = depsdev[name];
      return doc
        ? { ok: true, status: 200, json: async () => doc }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    const name = url.startsWith("https://index.crates.io/")
      ? url.split("/").pop()
      : decodeURIComponent(
          url
            .replace(/\/json$/, "")
            .split("/")
            .pop(),
        );
    const status = registry[name] ?? 404;
    return { ok: status === 200, status };
  };
}

/** A deps.dev document: `ages` are days-before-NOW per version, oldest first; last is default. */
const history = (name, ages) => ({
  versions: ages.map((d, i) => ({
    versionKey: { name, version: `1.${i}.0` },
    publishedAt: new Date(NOW - d * DAY).toISOString(),
    isDefault: i === ages.length - 1,
  })),
});

// ── parsing ────────────────────────────────────────────────────────────────────────────────

test("parseInstalls: the npm family — install spellings, flags, scopes, pins, aliases", () => {
  assert.deepEqual(pkgs("npm install left-pad@1.3.0 @scope/pkg --save-dev"), [
    "npm:left-pad@1.3.0",
    "npm:@scope/pkg",
  ]);
  assert.deepEqual(pkgs("npm i -g typescript@latest"), ["npm:typescript"]);
  assert.deepEqual(pkgs("npm isntall lodash"), ["npm:lodash"]);
  assert.deepEqual(pkgs("npm --prefix ./web install react"), ["npm:react"]);
  assert.deepEqual(pkgs("pnpm add -D vitest@^2 zod"), ["npm:vitest", "npm:zod"]);
  assert.deepEqual(pkgs("yarn add react react-dom"), ["npm:react", "npm:react-dom"]);
  assert.deepEqual(pkgs("yarn global add serve"), ["npm:serve"]);
  assert.deepEqual(pkgs("bun add hono"), ["npm:hono"]);
  assert.deepEqual(pkgs("npm install my-alias@npm:real-pkg@2.0.0"), ["npm:real-pkg@2.0.0"]);
  // A flag's VALUE is never a package.
  assert.deepEqual(pkgs("npm install --workspace packages/app --tag next express"), [
    "npm:express",
  ]);
});

test("parseInstalls: nothing to vet — no names, scripts, non-registry sources", () => {
  for (const cmd of [
    "npm install",
    "npm ci",
    "npm run build",
    "npm test",
    "pnpm install --frozen-lockfile",
    "npm install ./local ../sibling /abs/path ~/home-pkg",
    "npm install user/repo github:user/repo git+https://github.com/u/r.git",
    "npm install https://example.com/pkg.tgz ./pkg-1.0.0.tgz file:../x",
    "pip install -r requirements.txt -e . -c constraints.txt",
    "pip install ./dist/pkg-1.0-py3-none-any.whl git+https://github.com/u/r",
    "pip install 'thing @ https://example.com/thing.zip'",
    "cargo build --release",
    "echo npm install left-pad",
    "ls -la && git status",
    "",
  ])
    assert.deepEqual(pkgs(cmd), [], cmd);
});

test("parseInstalls: a name the shell must compute is never guessed", () => {
  assert.deepEqual(pkgs('npm install $PKG "$(cat name.txt)" `whoami` pre*fix'), []);
  assert.deepEqual(pkgs('npm install "$PKG" real-one'), ["npm:real-one"]);
});

test("parseInstalls: wrappers, env assignments and compound lines", () => {
  assert.deepEqual(pkgs("CI=1 sudo npm install express"), ["npm:express"]);
  assert.deepEqual(pkgs("env -i npm install express"), ["npm:express"]);
  assert.deepEqual(pkgs("/usr/local/bin/npm install express"), ["npm:express"]);
  assert.deepEqual(pkgs("cd app && npm install a-pkg; pip install b-pkg | tee log"), [
    "npm:a-pkg",
    "pypi:b-pkg",
  ]);
  // The same package named twice is vetted once.
  assert.deepEqual(pkgs("npm install express && npm install express"), ["npm:express"]);
});

test("parseInstalls: fetch-and-run — only the package, never its own arguments", () => {
  assert.deepEqual(pkgs("npx -y create-vite@latest my-app --template react"), ["npm:create-vite"]);
  assert.deepEqual(pkgs("pnpm dlx shadcn@latest add button"), ["npm:shadcn"]);
  assert.deepEqual(pkgs("bunx cowsay hello"), ["npm:cowsay"]);
  assert.deepEqual(pkgs("npm exec -- prettier --write ."), ["npm:prettier"]);
  // `-p pkg cmd`: the flag names the package, the positional is the command inside it.
  assert.deepEqual(pkgs("npx -p typescript tsc --noEmit"), ["npm:typescript"]);
  assert.deepEqual(pkgs("uvx ruff check ."), ["pypi:ruff"]);
  assert.deepEqual(pkgs("uvx --from httpie http GET example.com"), ["pypi:httpie"]);
  assert.deepEqual(pkgs("pipx run cowsay moo"), ["pypi:cowsay"]);
});

test("parseInstalls: npx of a binary the project already has never touches the registry", () => {
  const exists = (p) => p.replaceAll("\\", "/").endsWith("/repo/node_modules/.bin/biome");
  assert.deepEqual(pkgs("npx biome check .", { cwd: "/repo/packages/app", exists }), []);
  assert.deepEqual(pkgs("npx biome check .", { cwd: "/elsewhere", exists }), ["npm:biome"]);
});

test("parseInstalls: create / init name an initializer package", () => {
  assert.deepEqual(pkgs("npm create vite@latest my-app"), ["npm:create-vite"]);
  assert.deepEqual(pkgs("npm init @scope/app"), ["npm:@scope/create-app"]);
  assert.deepEqual(pkgs("pnpm create @acme"), ["npm:@acme/create"]);
  assert.deepEqual(pkgs("npm init -y"), []);
  assert.deepEqual(pkgs("bun create ./my-template app"), []);
});

test("parseInstalls: the Python family", () => {
  assert.deepEqual(pkgs("pip install requests 'flask[async]==3.0.0' \"urllib3>=2,<3\""), [
    "pypi:requests",
    "pypi:flask@3.0.0",
    "pypi:urllib3",
  ]);
  assert.deepEqual(pkgs("python3 -m pip install --upgrade pip setuptools"), [
    "pypi:pip",
    "pypi:setuptools",
  ]);
  assert.deepEqual(pkgs("pip3 install --target ./vendor Django"), ["pypi:django"]);
  assert.deepEqual(pkgs("uv add httpx --dev"), ["pypi:httpx"]);
  assert.deepEqual(pkgs("uv pip install numpy==2.1.0"), ["pypi:numpy@2.1.0"]);
  assert.deepEqual(pkgs("uv tool install ruff"), ["pypi:ruff"]);
  assert.deepEqual(pkgs("poetry add --group dev pytest"), ["pypi:pytest"]);
  assert.deepEqual(pkgs("pipx install black"), ["pypi:black"]);
  assert.deepEqual(pkgs("pip download requests"), []);
});

test("parseInstalls: cargo — add, install, a --version pin", () => {
  assert.deepEqual(pkgs("cargo add serde --features derive"), ["cargo:serde"]);
  assert.deepEqual(pkgs("cargo add tokio@1.40.0 anyhow"), ["cargo:tokio@1.40.0", "cargo:anyhow"]);
  assert.deepEqual(pkgs("cargo install ripgrep --version 14.1.0"), ["cargo:ripgrep@14.1.0"]);
});

test("parseInstalls: a flag that points away from the public registry is reported, not vetted", () => {
  const pip = parseInstalls("pip install --index-url https://corp.example/simple internal-lib");
  assert.deepEqual(pip, { packages: [], custom: ["pypi"] });
  const npm = parseInstalls("npm install --registry=https://npm.corp.example @corp/ui");
  assert.deepEqual(npm, { packages: [], custom: ["npm"] });
  const cargo = parseInstalls("cargo add my-crate --git https://github.com/u/my-crate");
  assert.deepEqual(cargo, { packages: [], custom: ["cargo"] });
});

test("SPEC_PARSERS: PEP 503 folding, extras, pins; npm name grammar", () => {
  assert.deepEqual(SPEC_PARSERS.pypi("Typing_Extensions"), {
    name: "typing-extensions",
    version: null,
  });
  assert.deepEqual(SPEC_PARSERS.pypi("zope.interface==6.0"), {
    name: "zope-interface",
    version: "6.0",
  });
  assert.deepEqual(SPEC_PARSERS.pypi("requests==2.*"), { name: "requests", version: null });
  assert.deepEqual(SPEC_PARSERS.pypi('pywin32; sys_platform == "win32"'), {
    name: "pywin32",
    version: null,
  });
  assert.equal(SPEC_PARSERS.npm("Not_A_Valid Name"), null);
  assert.deepEqual(SPEC_PARSERS.npm("@types/node@22.1.0"), {
    name: "@types/node",
    version: "22.1.0",
  });
  assert.deepEqual(SPEC_PARSERS.npm("react@^19"), { name: "react", version: null });
});

test("parseVetArg: the `forge vet` argument form; a bare name is npm", () => {
  assert.deepEqual(
    [
      parseVetArg("left-pad"),
      parseVetArg("pypi:Requests==2.31.0"),
      parseVetArg("crates:serde"),
    ].map((p) => p && `${p.eco}:${p.name}${p.version ? `@${p.version}` : ""}`),
    ["npm:left-pad", "pypi:requests@2.31.0", "cargo:serde"],
  );
  assert.equal(parseVetArg("./local"), null);
});

// ── registry overrides ─────────────────────────────────────────────────────────────────────

test("customRegistries: env and .npmrc registry lines; the default registry is not custom", () => {
  const none = customRegistries({ cwd: "/r", env: {}, home: "/h", readText: () => null });
  assert.deepEqual(none, OFF);

  const files = {
    "/r/.npmrc": "@acme:registry=https://npm.acme.example/\n//npm.acme.example/:always-auth=true\n",
    "/h/.npmrc": "registry=https://registry.npmjs.org/\n",
  };
  const scoped = customRegistries({
    cwd: "/r/packages/app",
    env: {},
    home: "/h",
    readText: (p) => files[p.replaceAll("\\", "/")] ?? null,
  });
  assert.deepEqual(scoped, { ...OFF, npmScopes: ["@acme"] });

  const env = {
    NPM_CONFIG_REGISTRY: "https://mirror.example/npm/",
    PIP_INDEX_URL: "https://m/simple",
  };
  const all = customRegistries({ cwd: "/r", env, home: "", readText: () => null });
  assert.deepEqual(all, { ...OFF, npm: true, pypi: true });

  const defaults = {
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    PIP_INDEX_URL: "https://pypi.org/simple",
  };
  assert.deepEqual(
    customRegistries({ cwd: "/r", env: defaults, home: "", readText: () => null }),
    OFF,
  );
});

test("customRegistries: the config files that choose a registry, project and user level", () => {
  const at = (files, extra = {}) =>
    customRegistries({
      cwd: "/r/app",
      env: {},
      home: "/h",
      readText: (p) => files[p.replaceAll("\\", "/")] ?? null,
      ...extra,
    });
  const off = OFF;
  assert.deepEqual(at({ "/r/.yarnrc.yml": "npmRegistryServer: https://npm.corp\n" }), {
    ...off,
    npm: true,
  });
  assert.deepEqual(at({ "/r/app/bunfig.toml": '[install]\nregistry = "https://npm.corp"\n' }), {
    ...off,
    npm: true,
  });
  assert.deepEqual(
    at({
      "/r/app/pyproject.toml": '[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp"\n',
    }),
    { ...off, pypi: true },
  );
  assert.deepEqual(at({ "/h/.config/pip/pip.conf": "[global]\nindex-url = https://pypi.corp\n" }), {
    ...off,
    pypi: true,
  });
  assert.deepEqual(
    at(
      { "/etc/pip.conf": "extra-index-url = https://x\n" },
      { env: { PIP_CONFIG_FILE: "/etc/pip.conf" } },
    ),
    { ...off, pypi: true },
  );
  assert.deepEqual(at({ "/r/.cargo/config.toml": '[source.crates-io]\nreplace-with = "corp"\n' }), {
    ...off,
    cargo: true,
  });
  // A config file that chooses no registry changes nothing.
  assert.deepEqual(
    at({
      "/r/.yarnrc.yml": "nodeLinker: node-modules\n",
      "/r/app/pyproject.toml": '[project]\nname = "app"\n',
      "/r/.cargo/config.toml": "[build]\njobs = 4\n",
    }),
    off,
  );
});

// ── evidence ───────────────────────────────────────────────────────────────────────────────

test("probePackage: a name its registry lacks is told to NOBODY else (privacy, not just speed)", async () => {
  const seen = [];
  const ev = await probePackage(
    { eco: "npm", name: "invented-utils", version: null, via: "t" },
    { fetchImpl: fakeFetch({ seen }) },
  );
  assert.equal(ev.exists, false);
  assert.equal(ev.indexed, null, "deps.dev was never asked");
  // A typo, an invention or a private package name: only its own registry ever hears it.
  assert.deepEqual(seen, ["HEAD https://registry.npmjs.org/invented-utils"]);

  const offline = [];
  await probePackage(
    { eco: "pypi", name: "internal-thing", version: null, via: "t" },
    { fetchImpl: fakeFetch({ seen: offline, registry: { "internal-thing": 503 } }) },
  );
  assert.deepEqual(offline, ["HEAD https://pypi.org/pypi/internal-thing/json"]);
});

test("probePackage: history from deps.dev, advisories from OSV for the pinned version", async () => {
  const asked = [];
  const ev = await probePackage(
    { eco: "pypi", name: "requests", version: "1.0.0", via: "t" },
    {
      fetchImpl: fakeFetch({
        registry: { requests: 200 },
        depsdev: { requests: history("requests", [4000, 900, 30]) },
        osv: (name, version) => {
          asked.push(`${name}@${version}`);
          return [
            { id: "GHSA-aaaa", summary: "leak", database_specific: { severity: "MODERATE" } },
            { id: "PYSEC-1", summary: "no label" },
          ];
        },
      }),
    },
  );
  assert.equal(ev.exists, true);
  assert.equal(ev.indexed, true);
  assert.equal(ev.versions, 3);
  assert.equal(ev.latest, "1.2.0");
  assert.equal(ev.firstPublishedAt, NOW - 4000 * DAY);
  assert.deepEqual(asked, ["requests@1.0.0"]);
  assert.deepEqual(ev.malicious, []);
  assert.deepEqual(
    ev.advisories.map((a) => [a.id, a.severity]),
    [
      ["GHSA-aaaa", "moderate"],
      ["PYSEC-1", null],
    ],
  );
});

test("probePackage: with no version to ask about, only a MALICIOUS record is conclusive", async () => {
  const ev = await probePackage(
    { eco: "npm", name: "evil-pkg", version: null, via: "t" },
    {
      fetchImpl: fakeFetch({
        registry: { "evil-pkg": 200 },
        osv: () => [
          { id: "MAL-2026-1234", summary: "Malicious code in evil-pkg" },
          { id: "GHSA-old", summary: "fixed long ago", database_specific: { severity: "HIGH" } },
        ],
      }),
    },
  );
  assert.equal(ev.exists, true);
  assert.equal(ev.indexed, false);
  assert.deepEqual(ev.malicious, [{ id: "MAL-2026-1234", summary: "Malicious code in evil-pkg" }]);
  assert.equal(ev.advisories, null, "an unversioned advisory list says nothing about this install");
});

test("probePackage: cargo treats - and _ as one name; scoped npm names are encoded", async () => {
  const urls = (eco, name) => EXISTS_URLS[eco](name).map((c) => c.url);
  assert.deepEqual(urls("cargo", "serde-json"), [
    "https://index.crates.io/se/rd/serde-json",
    "https://index.crates.io/se/rd/serde_json",
  ]);
  assert.deepEqual(urls("cargo", "syn"), ["https://index.crates.io/3/s/syn"]);
  assert.deepEqual(urls("cargo", "cc"), ["https://index.crates.io/2/cc"]);
  assert.deepEqual(urls("npm", "@types/node"), ["https://registry.npmjs.org/%40types%2Fnode"]);
  const ev = await probePackage(
    { eco: "cargo", name: "serde-json", version: null, via: "t" },
    { fetchImpl: fakeFetch({ registry: { serde_json: 200 } }) },
  );
  assert.equal(ev.exists, true);
  // The spelling the registry answered to is the one deps.dev and OSV are asked about.
  assert.equal(ev.canonical, "serde_json");
});

test("probePackage: every source that fails leaves UNKNOWN, never a clean bill of health", async () => {
  const down = await probePackage(
    { eco: "npm", name: "express", version: null, via: "t" },
    { fetchImpl: fakeFetch({ fail: ["registry.npmjs.org", "deps.dev", "osv.dev"] }) },
  );
  assert.deepEqual(down, {
    exists: null,
    canonical: null,
    indexed: null,
    firstPublishedAt: null,
    versions: null,
    latest: null,
    malicious: null,
    advisories: null,
  });
  // 403 / 429 / 5xx from the registry is not a 404.
  const limited = await probePackage(
    { eco: "npm", name: "express", version: null, via: "t" },
    { fetchImpl: fakeFetch({ registry: { express: 429 } }) },
  );
  assert.equal(limited.exists, null);
});

// ── judgment ───────────────────────────────────────────────────────────────────────────────

const npmPkg = { eco: "npm", name: "p", version: null, via: "t" };
const blank = {
  exists: true,
  canonical: "p",
  indexed: true,
  firstPublishedAt: null,
  versions: null,
  latest: null,
  malicious: [],
  advisories: null,
};

test("judge: the two hard gates deny, whatever else the evidence says", () => {
  const missing = judge(npmPkg, { ...blank, exists: false, indexed: false }, NOW);
  assert.equal(missing.level, "deny");
  assert.match(missing.reasons[0], /is not on the npm registry/);
  const evil = judge(
    npmPkg,
    {
      ...blank,
      firstPublishedAt: NOW - 3000 * DAY,
      versions: 200,
      malicious: [{ id: "MAL-2026-9", summary: "" }],
    },
    NOW,
  );
  assert.equal(evil.level, "deny");
  assert.match(evil.reasons[0], /MALICIOUS.*MAL-2026-9/);
});

test("judge: youth halves every half-life; new and thin asks, established is silent", () => {
  const at = (days, versions) =>
    judge(npmPkg, { ...blank, firstPublishedAt: NOW - days * DAY, versions }, NOW);
  const fresh = at(6, 1);
  assert.equal(fresh.level, "ask");
  assert.ok(Math.abs(fresh.signals.youth - 2 ** (-6 / YOUTH_HALF_LIFE_DAYS)) < 1e-9);
  assert.match(fresh.reasons.join("; "), /first published 6 days ago; only 1 version published/);
  // Exactly one half-life old: youth is 0.5.
  assert.ok(Math.abs(at(YOUTH_HALF_LIFE_DAYS, 50).signals.youth - 0.5) < 1e-9);
  assert.equal(at(45, 3).level, "note");
  assert.equal(at(400, 40).level, "ok");
  // An OLD package with a single version is not a finding on its own.
  assert.equal(at(3000, 1).level, "ok");
  assert.ok(DEPGATE_WEIGHTS.thin < DEPGATE_THRESHOLDS.note);
});

test("judge: on its registry but unknown to the public index is as new as it gets", () => {
  const j = judge(npmPkg, { ...blank, indexed: false }, NOW);
  assert.equal(j.signals.youth, 1);
  assert.equal(j.level, "ask");
  assert.match(j.reasons[0], /too new/);
});

test("judge: advisories on the version being installed — critical asks, high notes", () => {
  const withSeverity = (severity) =>
    judge(
      { ...npmPkg, version: "1.0.0" },
      {
        ...blank,
        firstPublishedAt: NOW - 3000 * DAY,
        versions: 90,
        advisories: [{ id: "GHSA-x", severity, summary: "" }],
      },
      NOW,
    );
  assert.equal(withSeverity("critical").level, "ask");
  assert.equal(withSeverity("high").level, "note");
  assert.equal(withSeverity("low").level, "ok");
  assert.match(
    withSeverity("high").reasons.join(),
    /1 known advisory on 1\.0\.0 \(worst: GHSA-x\)/,
  );
  // No advisories is a clean signal: it contributes nothing and dilutes nothing.
  const clean = judge(
    npmPkg,
    { ...blank, firstPublishedAt: NOW - 6 * DAY, versions: 1, advisories: [] },
    NOW,
  );
  assert.equal(clean.level, "ask");
});

test("judge: nothing verifiable is UNKNOWN, not ok", () => {
  const j = judge(npmPkg, { ...blank, exists: null, indexed: null, malicious: null }, NOW);
  assert.equal(j.level, "unknown");
});

// ── the gate ───────────────────────────────────────────────────────────────────────────────

const gate = (command, net, extra = {}) =>
  depgateDecision({
    command,
    cwd: "/repo",
    env: {},
    home: "",
    allow: [],
    nowMs: NOW,
    exists: () => false,
    readText: () => null,
    cache: null,
    fetchImpl: fakeFetch(net),
    ...extra,
  });

test("depgateDecision: an invented name is denied, with what to do next", async () => {
  const d = await gate("npm install express fast-json-utils-pro", {
    registry: { express: 200 },
    depsdev: { express: history("express", [5000, 2000, 10]) },
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /^dep-gate: fast-json-utils-pro \(npm\) is not on the npm registry/);
  assert.match(d.reason, /depgate\.allow/);
  assert.match(d.reason, /FORGE_DEPGATE=0/);
  assert.ok(!d.reason.includes("express"), "the clean package is not named in the block");
});

test("depgateDecision: a malicious listing is denied even for an old, popular-looking name", async () => {
  const d = await gate("pip install colourama", {
    registry: { colourama: 200 },
    depsdev: { colourama: history("colourama", [900, 800]) },
    osv: () => [{ id: "MAL-2025-77", summary: "typosquat of colorama" }],
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /MALICIOUS by OSV \(MAL-2025-77\)/);
});

test("depgateDecision: new and thin asks the human; a known advisory leaves a note", async () => {
  const ask = await gate("npm install shiny-new-thing", {
    registry: { "shiny-new-thing": 200 },
    depsdev: { "shiny-new-thing": history("shiny-new-thing", [4]) },
  });
  assert.equal(ask.decision, "ask");
  assert.match(ask.reason, /shiny-new-thing \(npm\) first published 4 days ago/);

  const note = await gate("pip install requests==2.19.0", {
    registry: { requests: 200 },
    depsdev: { requests: history("requests", [4000, 100]) },
    osv: (_n, version) =>
      version === "2.19.0"
        ? [{ id: "GHSA-h", summary: "", database_specific: { severity: "HIGH" } }]
        : [],
  });
  assert.equal(note.decision, "note");
  assert.equal(
    note.reason,
    "dep-gate: requests@2.19.0 (pypi) 1 known advisory on 2.19.0 (worst: GHSA-h).",
  );
});

test("depgateDecision: established packages pass in silence", async () => {
  const d = await gate("npm install express", {
    registry: { express: 200 },
    depsdev: { express: history("express", [5000, 2000, 10]) },
  });
  assert.deepEqual([d.decision, d.reason], ["allow", ""]);
  assert.equal(d.results.length, 1);
});

test("depgateDecision: FAIL OPEN — an unreachable internet never blocks an install", async () => {
  const d = await gate("npm install express", {
    fail: ["registry.npmjs.org", "deps.dev", "osv.dev"],
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.results[0].judgment.level, "unknown");
  const throwing = await gate(
    "npm install express",
    {},
    {
      fetchImpl: () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(throwing.decision, "allow");
});

test("depgateDecision: the kill switch, the allow list, and private registries skip the probe", async () => {
  const seen = [];
  const off = await gate("npm install nope-not-real", { seen }, { env: { FORGE_DEPGATE: "0" } });
  assert.equal(off.decision, "allow");

  const allowed = await gate(
    "npm install @acme/ui acme-internal-tool",
    { seen },
    {
      allow: ["@acme/*", "acme-internal-tool"],
    },
  );
  assert.equal(allowed.decision, "allow");

  const scoped = await gate(
    "npm install @corp/secret-lib",
    { seen },
    {
      readText: (p) =>
        p.replaceAll("\\", "/") === "/repo/.npmrc" ? "@corp:registry=https://npm.corp/\n" : null,
    },
  );
  assert.equal(scoped.decision, "allow");
  assert.match(scoped.skipped[0], /@corp\/secret-lib \(npm\): a custom registry is configured/);

  const crates = await gate(
    "cargo add corp-internal-crate",
    { seen },
    {
      readText: (p) =>
        p.replaceAll("\\", "/") === "/repo/.cargo/config.toml"
          ? '[registries.corp]\nindex = "x"\n'
          : null,
    },
  );
  assert.equal(crates.decision, "allow");

  const mirrored = await gate(
    "pip install internal-lib",
    { seen },
    {
      env: { PIP_INDEX_URL: "https://pypi.corp/simple" },
    },
  );
  assert.equal(mirrored.decision, "allow");
  assert.deepEqual(seen, [], "none of these touched the network");
});

test("depgateDecision: no install in the command, no work at all", async () => {
  const seen = [];
  for (const command of ["git status", "npm run build", "npm ci", ""]) {
    const d = await gate(command, { seen });
    assert.equal(d.decision, "allow");
  }
  assert.deepEqual(seen, []);
});

test("depgateDecision: a long install line is vetted up to the cap, and says so", async () => {
  const names = Array.from({ length: MAX_PACKAGES + 3 }, (_, i) => `pkg-${i}`);
  const registry = Object.fromEntries(names.map((n) => [n, 200]));
  const depsdev = Object.fromEntries(names.map((n) => [n, history(n, [3000, 2000, 1000])]));
  const d = await gate(`npm install ${names.join(" ")}`, { registry, depsdev });
  assert.equal(d.results.length, MAX_PACKAGES);
  assert.match(d.skipped.join(), /3 more package\(s\) past the cap/);
});

test("isAllowed: exact names, a scope, a prefix — case-insensitive; a non-list allows nothing", () => {
  assert.equal(isAllowed("@Acme/UI", ["@acme/*"]), true);
  assert.equal(isAllowed("acme-tool", ["acme-*"]), true);
  assert.equal(isAllowed("acme", ["acme-*"]), false);
  assert.equal(isAllowed("left-pad", ["left-pad"]), true);
  assert.equal(isAllowed("left-pad", undefined), false);
  assert.equal(isAllowed("left-pad", "left-pad"), false);
});

// ── the guard ──────────────────────────────────────────────────────────────────────────────

test("guard: the hook protocol — deny blocks, ask pauses, note advises, allow is silent", () => {
  const deny = hookResponse({ decision: "deny", reason: "dep-gate: x is not on the npm registry" });
  assert.equal(deny.exit, 2);
  assert.match(deny.stderr, /^BLOCKED by dep-gate guard: dep-gate: x/);
  assert.deepEqual(JSON.parse(deny.stdout).hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "dep-gate: x is not on the npm registry",
  });
  const ask = hookResponse({ decision: "ask", reason: "r" });
  assert.equal(ask.exit, 0);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, "ask");
  const note = hookResponse({ decision: "note", reason: "r" });
  assert.equal(note.exit, 0);
  assert.equal(JSON.parse(note.stdout).hookSpecificOutput.additionalContext, "r");
  assert.deepEqual(hookResponse({ decision: "allow", reason: "" }), {
    stdout: "",
    stderr: "",
    exit: 0,
  });
});

test("guard: the pre-filter only wakes for a package manager", () => {
  for (const cmd of [
    "npm install x",
    "cd app && pnpm add x",
    "sudo pip3 install x",
    "python3.12 -m pip install x",
    "C:\\tools\\npm.cmd i x",
    "uvx ruff",
    "cargo add serde",
  ])
    assert.ok(MENTIONS_PACKAGE_MANAGER.test(cmd), cmd);
  for (const cmd of [
    "git status",
    "ls node_modules/npm-run-all",
    "cat cargo-notes.txt",
    "make test",
  ])
    assert.ok(!MENTIONS_PACKAGE_MANAGER.test(cmd), cmd);
});

test("guard: runs on a Node twin and fails OPEN (never fail-closed)", () => {
  assert.deepEqual(GUARD_POLICY["dep-gate.sh"], { node: "dep-gate.mjs" });
});

test("guard: end to end without the network — non-installs, junk payloads and the kill switch pass", () => {
  const guard = fileURLToPath(new URL("../global/guards/dep-gate.mjs", import.meta.url));
  const run = (payload, env = {}) =>
    spawnSync(process.execPath, [guard], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  const bash = (command) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/" });
  for (const payload of [
    bash("git status"),
    bash("npm run build"),
    JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "package.json" } }),
    "not json at all",
    "",
  ]) {
    const r = run(payload);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], payload);
  }
  const off = run(bash("npm install surely-not-a-real-package-zzq"), { FORGE_DEPGATE: "0" });
  assert.deepEqual([off.status, off.stdout], [0, ""]);
});

test("forge vet: no arguments is a usage error; a path is not a package", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, "vet", ...args], { encoding: "utf8" });
  const bare = run();
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: forge vet/);
  const path = run("./local-thing");
  assert.equal(path.status, 1);
  assert.match(path.stderr, /not a registry package: \.\/local-thing/);
});
