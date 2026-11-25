import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { vetLockfile } from "../src/lockfile_vet.js";

function lock(t, object) {
  const dir = mkdtempSync(join(tmpdir(), "forge-advisory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "package-lock.json");
  writeFileSync(path, JSON.stringify(object));
  return { path, dir };
}
const installed = (name, version) => ({
  version,
  license: "MIT",
  resolved: `https://registry.npmjs.org/${name}/-/file.tgz`,
});

test("inventory ties transitive findings and branch fixes to exact releases, preserving incomplete coverage", async (t) => {
  const { path, dir } = lock(t, {
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/lib": installed("lib", "2.1.3"),
      "node_modules/lib/node_modules/core": installed("core", "3.0.0"),
      "node_modules/alias": installed("core", "3.0.0"),
      "node_modules/work": { link: true, resolved: "packages/work" },
    },
  });
  const calls = [];
  const records = [
    {
      id: "EXAMPLE-001",
      aliases: ["CVE-2099-0001"],
      affected: [
        {
          package: { ecosystem: "npm", name: "lib" },
          ranges: [
            {
              type: "SEMVER",
              events: [
                { introduced: "0" },
                { fixed: "1.2.0" },
                { introduced: "2.0.0" },
                { fixed: "2.1.4" },
              ],
            },
          ],
        },
      ],
    },
  ];
  const fetchImpl = async (url, init) => {
    if (init.method === "HEAD") return new Response(null, { status: 200 });
    assert.equal(String(url), "https://api.osv.dev/v1/query");
    const body = JSON.parse(init.body);
    calls.push([body.package.name, body.version]);
    return Response.json({ vulns: body.package.name === "lib" ? records : [] });
  };
  const report = await vetLockfile(path, { env: {}, home: dir, fetchImpl });
  assert.equal(report.status, "affected");
  assert.deepEqual(report.coverage, { assessed: 2, affected: 1, unknown: 1 });
  assert.deepEqual(calls.sort(), [
    ["core", "3.0.0"],
    ["lib", "2.1.3"],
  ]);
  const affected = report.packages.find((p) => p.name === "lib");
  assert.equal(affected.license, "MIT");
  assert.deepEqual(affected.advisories[0].fixedVersions, ["2.1.4"]);
  assert.deepEqual(affected.advisories[0].aliases, ["CVE-2099-0001"]);
  assert.equal(affected.advisories[0].url, "https://osv.dev/vulnerability/EXAMPLE-001");
});

test("registry and schema uncertainties produce unknown; empty successful OSV results produce clear", async (t) => {
  const { path, dir } = lock(t, {
    lockfileVersion: 1,
    dependencies: { demo: installed("demo", "1.0.0") },
  });
  let called = 0;
  const result = (factory) =>
    vetLockfile(path, {
      env: {},
      home: dir,
      fetchImpl: async (_url, init) =>
        init.method === "HEAD" ? new Response(null, { status: 200 }) : factory(),
    });
  assert.equal((await result(() => Response.json({}))).status, "clear");
  assert.equal((await result(() => Response.json({ vulns: "unexpected" }))).status, "unknown");
  assert.equal((await result(() => new Response(null, { status: 503 }))).status, "unknown");
  const noPublic = await vetLockfile(path, {
    env: {},
    home: dir,
    fetchImpl: async (_url, init) => {
      called++;
      assert.equal(init.method, "HEAD");
      return new Response(null, { status: 404 });
    },
  });
  assert.equal(noPublic.status, "unknown");
  assert.equal(called, 1);
  writeFileSync(join(dir, ".npmrc"), "registry=https://registry.example.invalid\n");
  const closed = await vetLockfile(path, {
    env: {},
    home: dir,
    fetchImpl: () => assert.fail("custom registries stay local"),
  });
  assert.equal(closed.status, "unknown");
});

test("CLI reports unsupported inputs as unknown JSON without contacting any provider", (t) => {
  const { path } = lock(t, { lockfileVersion: 90 });
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "vet", "--lockfile", path, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stdout).status, "unknown");
});
