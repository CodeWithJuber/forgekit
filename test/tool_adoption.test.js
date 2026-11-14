import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedMcpState, removeIntegration } from "../src/integrations.js";
import {
  adoptionCatalog,
  findAdoption,
  installAdoption,
  matchAdoption,
  matchAdoptions,
  runAdoption,
} from "../src/tool_adoption.js";

const digest = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const manifest = (opts = {}) => ({
  name: "@playwright/mcp",
  version: "2.4.6",
  engines: { node: ">=18" },
  bin: { "playwright-mcp": "cli.js" },
  license: "Apache-2.0",
  repository: { url: "git+https://github.com/microsoft/playwright-mcp.git" },
  dist: {
    tarball: "https://registry.npmjs.org/@playwright/mcp/-/mcp-2.4.6.tgz",
    integrity: digest,
  },
  ...opts,
});
function registry(m, vulns = [], tags = []) {
  return async (input, init) => {
    const url = new URL(String(input));
    tags.push(url.href);
    if (url.hostname === "api.osv.dev") {
      const body = JSON.parse(init.body);
      assert.equal(body.version, m.version);
      assert.equal(body.package.name, m.name);
      return Response.json({ vulns });
    }
    if (url.hostname === "api.deps.dev")
      return Response.json({
        versions: [
          { versionKey: { version: "0.0.1" }, publishedAt: "2021-01-01", isDefault: true },
        ],
      });
    if (init.method === "HEAD") return new Response(null, { status: 200 });
    return Response.json(m);
  };
}
function fixture(t) {
  const d = mkdtempSync(join(tmpdir(), "forge-adoption-")),
    root = join(d, "repo"),
    home = join(d, "state");
  mkdirSync(join(root, ".forge"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, ".forge", "forge.config.json"), JSON.stringify({ tools: ["claude"] }));
  const old = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = old;
    rmSync(d, { recursive: true, force: true });
  });
  return { home, root };
}
function materializer(m) {
  return async (stage, spec) => {
    assert.equal(spec, `${m.name}@${m.version}`);
    const path = `node_modules/${m.name}`;
    mkdirSync(join(stage, path), { recursive: true });
    writeFileSync(join(stage, path, "package.json"), JSON.stringify(m));
    writeFileSync(join(stage, path, "cli.js"), "process.stdout.write('private MCP executable');\n");
    writeFileSync(
      join(stage, "package-lock.json"),
      JSON.stringify({
        packages: {
          [path]: { version: m.version, resolved: m.dist.tarball, integrity: m.dist.integrity },
        },
      }),
    );
  };
}

test("local task matching ranks only relevant packages, with no task text sent to providers", async (t) => {
  const { root } = fixture(t);
  const logs = [];
  assert.equal(matchAdoption("browser automation", { root })[0].id, "playwright");
  assert.equal(matchAdoptions("browser automation", root)[0].reason, "browser automation");
  const report = await findAdoption("Issue SECRET-1234 needs browser automation", {
    root,
    fetchImpl: registry(manifest(), [], logs),
  });
  assert.equal(report.candidates[0].version, "2.4.6");
  assert.equal(report.candidates[0].status, "candidate");
  assert.equal(logs.length, 1);
  assert.ok(!logs.join("").includes("SECRET"));
  const offline = await findAdoption("browser automation", {
    root,
    offline: true,
    fetchImpl: () => assert.fail(),
  });
  assert.equal(offline.candidates[0].status, "review");
  assert.deepEqual(matchAdoption("make coffee", { root }), []);
});
test("checks provenance, stable versions, declared executable, license, integrity and Node engine", async (t) => {
  const { root } = fixture(t);
  for (const m of [
    manifest({ name: "unrelated" }),
    manifest({ version: "2.4.6-beta.1" }),
    manifest({ repository: "https://github.com/evil/repo" }),
    manifest({ bin: { other: "cli.js" } }),
    manifest({ dist: { integrity: "?", tarball: "https://example.org/a.tgz" } }),
    manifest({ license: "UNLICENSED" }),
    manifest({ deprecated: "use another" }),
    manifest({ engines: { node: ">=20.18.1" } }),
  ]) {
    const r = await findAdoption("playwright", {
      root,
      nodeVersion: "20.17.0",
      fetchImpl: registry(m),
    });
    assert.equal(r.candidates[0].status, "review");
  }
  const m = manifest({ engines: { node: ">=20.18.1" } });
  const r = await findAdoption("playwright", {
    root,
    nodeVersion: "20.17.0",
    fetchImpl: registry(m),
  });
  assert.equal(r.candidates[0].version, "2.4.6");
  assert.match(r.candidates[0].warning, /20.18.1/);
});
test("actually materializes and runs a pinned MCP; sync and removal honor owned and foreign configs", async (t) => {
  const { root } = fixture(t),
    m = manifest();
  const opts = { fetchImpl: registry(m), installPackage: materializer(m), version: m.version };
  const r = await installAdoption(root, "playwright", opts);
  assert.equal(r.ok, true, r.reason);
  assert.ok(existsSync(r.packagePath));
  const state = managedMcpState(root).servers.playwright;
  assert.deepEqual(state, {
    command: "forge",
    args: ["integrations", "run", "playwright", m.version],
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".mcp.json"))).mcpServers.playwright, state);
  const url = new URL("../src/tool_adoption.js", import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runAdoption} from ${JSON.stringify(url)};await runAdoption("playwright","2.4.6");`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(output, "private MCP executable");
  await assert.rejects(runAdoption("playwright", "../x"), /exact/);
  const again = await installAdoption(root, "playwright", {
    ...opts,
    installPackage: () => assert.fail(),
  });
  assert.ok(again.ok);
  assert.equal(removeIntegration("playwright", { targetRoot: root }).ok, true);
  assert.equal(managedMcpState(root).servers.playwright, undefined);
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { playwright: { command: "custom" } } }),
  );
  await installAdoption(root, "playwright", opts);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".mcp.json"))).mcpServers.playwright, {
    command: "custom",
  });
});
test("denied advisory or changed tarball cannot materialize an active configuration", async (t) => {
  const { root } = fixture(t),
    m = manifest();
  const denied = await installAdoption(root, "playwright", {
    fetchImpl: registry(m, [{ id: "MAL-9000" }]),
    installPackage: () => assert.fail(),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /MALICIOUS/);
  const tampered = await installAdoption(root, "playwright", {
    fetchImpl: registry(m),
    installPackage: materializer({ ...m, dist: { ...m.dist, integrity: "different" } }),
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /tarball/);
  assert.ok(!existsSync(join(root, ".mcp.json")));
});
test("private extensible catalog accepts scoped names, rejects commands and survives sync", async (t) => {
  const { home, root } = fixture(t);
  const row = {
    id: "pdf-review",
    npm: "@example/reader",
    upstream: "https://github.com/example/reader",
    bin: "reader",
    terms: ["analyze a PDF"],
    cost: "local CPU",
    permissions: "Reads selected files",
  };
  const file = join(home, "tool-catalog.json");
  writeFileSync(file, JSON.stringify({ tools: [row] }));
  assert.equal(adoptionCatalog(root).at(-1).id, row.id);
  const m = manifest({
    name: row.npm,
    repository: { url: row.upstream },
    bin: { reader: "cli.js" },
  });
  const r = await installAdoption(root, row.id, {
    fetchImpl: registry(m),
    installPackage: materializer(m),
  });
  assert.ok(r.ok, r.reason);
  assert.deepEqual(managedMcpState(root).servers[row.id].args, [
    "integrations",
    "run",
    row.id,
    m.version,
  ]);
  assert.equal(removeIntegration(row.id, { targetRoot: root }).ok, true);
  writeFileSync(file, JSON.stringify({ tools: [{ ...row, command: "shell" }] }));
  assert.throws(() => adoptionCatalog(root), /Invalid/);
  if (process.platform !== "win32") {
    const attacker = join(root, "catalog.json");
    writeFileSync(attacker, JSON.stringify({ tools: [row] }));
    rmSync(file);
    symlinkSync(attacker, file);
    assert.throws(() => adoptionCatalog(root), /outside/);
  }
});

test("policy revoked during installation and symlinks into the repository cannot register a tool", async (t) => {
  const { root, home } = fixture(t),
    m = manifest(),
    opts = { fetchImpl: registry(m), installPackage: materializer(m) };
  const cancelled = await installAdoption(root, "playwright", {
    ...opts,
    canRegister: () => false,
  });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.reason, /policy changed/);
  assert.ok(!existsSync(join(root, ".mcp.json")));
  if (process.platform !== "win32") {
    rmSync(join(home, "tool-packages"), { recursive: true, force: true });
    symlinkSync(root, join(home, "tool-packages"));
    const unsafe = await installAdoption(root, "playwright", opts);
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.reason, /outside the repository/);
    assert.ok(!existsSync(join(root, "playwright")));
  }
});
