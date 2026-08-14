import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadClaims, repoLedger } from "../src/ledger_store.js";
import { read as readMetrics } from "../src/metrics.js";
import {
  classifyDep,
  depsFromManifests,
  probeRegistry,
  radarAdvisory,
  radarScan,
  readRadarCache,
  usageFromAtlas,
} from "../src/radar.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-radar-"));
const DAY = 86400000;
const NOW_DAY = 20000;

// A fake registry: dispatches on URL. metadata GET + bulk advisories POST. Records the
// URLs it saw so tests can prove a scan did (or did NOT) hit the network.
function fakeFetch(catalog, { advisories = {}, seen } = {}) {
  return async (url) => {
    if (seen) seen.push(url);
    if (url.includes("/-/npm/v1/security/advisories/bulk")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return advisories;
        },
      };
    }
    // metadata: last path segment is the (encoded) package name
    const name = decodeURIComponent(url.split("/").pop());
    const entry = catalog[name];
    if (!entry)
      return {
        ok: false,
        status: 404,
        async json() {
          return {};
        },
      };
    return {
      ok: true,
      status: 200,
      async json() {
        return entry;
      },
    };
  };
}

const throwingFetch = () => {
  throw new Error("network touched — cache should have served");
};

// --- classifyDep -----------------------------------------------------------

test("classifyDep: deprecated → hold regardless of freshness", () => {
  const c = classifyDep(
    {
      installed: "5.0.0",
      latest: "5.0.0",
      publishedAt: NOW_DAY * DAY,
      deprecated: true,
      advisories: [],
    },
    NOW_DAY,
  );
  assert.equal(c.ring, "hold");
  assert.match(c.reasons.join(" "), /deprecated/);
});

test("classifyDep: critical advisory → hold even when fresh", () => {
  const c = classifyDep(
    {
      installed: "5.0.0",
      latest: "5.0.0",
      publishedAt: NOW_DAY * DAY,
      deprecated: false,
      advisories: [{ severity: "critical", title: "RCE" }],
    },
    NOW_DAY,
  );
  assert.equal(c.ring, "hold");
});

test("classifyDep: fresh + no advisories + ≥2 evidence kinds → adopt", () => {
  const c = classifyDep(
    {
      installed: "3.0.0",
      latest: "3.0.0",
      publishedAt: NOW_DAY * DAY,
      deprecated: false,
      advisories: [],
    },
    NOW_DAY,
  );
  assert.equal(c.evidenceKinds, 4);
  assert.equal(c.ring, "adopt");
  assert.ok(c.score < 0.25);
});

test("classifyDep: single evidence kind → assess (never adopt on absence)", () => {
  const c = classifyDep(
    {
      installed: null,
      latest: null,
      publishedAt: null,
      deprecated: null,
      advisories: [],
    },
    NOW_DAY,
  );
  assert.equal(c.evidenceKinds, 1);
  assert.equal(c.ring, "assess");
});

test("classifyDep: score bounded [0,1] and monotone in staleness", () => {
  const fresh = classifyDep(
    {
      installed: "1.0.0",
      latest: "1.0.0",
      publishedAt: NOW_DAY * DAY,
      deprecated: false,
      advisories: [],
    },
    NOW_DAY,
  );
  const stale = classifyDep(
    {
      installed: "1.0.0",
      latest: "1.0.0",
      publishedAt: (NOW_DAY - 1000) * DAY,
      deprecated: false,
      advisories: [],
    },
    NOW_DAY,
  );
  for (const c of [fresh, stale]) assert.ok(c.score >= 0 && c.score <= 1);
  assert.ok(stale.score > fresh.score, "older publish → higher staleness → higher score");
});

// --- depsFromManifests -----------------------------------------------------

test("depsFromManifests: package.json + lock v3 → names/ranges/installed", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { got: "^14.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/got": { version: "14.4.5" },
        "node_modules/vitest": { version: "1.6.0" },
      },
    }),
  );
  const { deps, skipped } = depsFromManifests(root);
  assert.equal(deps.got.range, "^14.0.0");
  assert.equal(deps.got.source, "dependencies");
  assert.equal(deps.got.installed, "14.4.5");
  assert.equal(deps.vitest.source, "devDependencies");
  assert.equal(deps.vitest.installed, "1.6.0");
  assert.equal(skipped.length, 0);
});

test("depsFromManifests: workspace/file ranges flagged local (unprobed)", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { a: "workspace:*", b: "file:../b", c: "^1.0.0" },
    }),
  );
  const { deps } = depsFromManifests(root);
  assert.equal(deps.a.local, true);
  assert.equal(deps.b.local, true);
  assert.equal(deps.c.local, false);
});

test("depsFromManifests: non-Node repo → honest skipped entry; corrupt never throws", () => {
  const root = tmp();
  writeFileSync(join(root, "go.mod"), "module example.com/x\n");
  const { deps, skipped } = depsFromManifests(root);
  assert.equal(Object.keys(deps).length, 0);
  assert.ok(skipped.some((s) => s.language === "Go"));
  // corrupt package.json → no throw, empty deps
  writeFileSync(join(root, "package.json"), "{ not json");
  assert.doesNotThrow(() => depsFromManifests(root));
});

// --- probeRegistry ---------------------------------------------------------

test("probeRegistry: metadata + bulk advisories parsed", async () => {
  const seen = [];
  const fetchImpl = fakeFetch(
    {
      got: {
        "dist-tags": { latest: "14.4.5" },
        versions: { "14.4.5": {} },
        time: { "14.4.5": new Date((NOW_DAY - 100) * DAY).toISOString() },
      },
    },
    {
      advisories: { got: [{ severity: "high", title: "SSRF", url: "u" }] },
      seen,
    },
  );
  const r = await probeRegistry(["got"], {
    fetchImpl,
    installed: { got: "9.0.0" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.results.got.latest, "14.4.5");
  assert.equal(r.results.got.deprecated, false);
  assert.equal(r.results.got.advisories[0].severity, "high");
  assert.ok(seen.some((u) => u.includes("advisories/bulk")));
});

test("probeRegistry: advisories endpoint failure → advisory evidence MISSING (degrade to assess)", async () => {
  const base = fakeFetch({
    got: {
      "dist-tags": { latest: "14.0.0" },
      versions: { "14.0.0": {} },
      time: { "14.0.0": new Date((NOW_DAY - 10) * DAY).toISOString() },
    },
  });
  const fetchImpl = async (url, opts) => {
    if (url.includes("advisories/bulk"))
      return {
        ok: false,
        status: 500,
        async json() {
          return {};
        },
      };
    return base(url, opts);
  };
  const r = await probeRegistry(["got"], {
    fetchImpl,
    installed: { got: "14.0.0" },
  });
  assert.equal(r.results.got.advisories, null, "failed advisories probe → null, not []");
  const c = classifyDep(r.results.got, NOW_DAY);
  assert.ok(c.evidenceKinds < 4);
});

// --- usageFromAtlas --------------------------------------------------------

test("usageFromAtlas: counts imports edges by bare + subpath + member; missing atlas → 0s", () => {
  const root = tmp();
  assert.deepEqual(usageFromAtlas(root, ["got"]), { got: 0 });
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "atlas.json"),
    JSON.stringify({
      edges: [
        { kind: "imports", target: "got" },
        { kind: "imports", target: "got/dist/source" },
        { kind: "imports", target: "got.default" },
        { kind: "imports", target: "gotcha" },
        { kind: "calls", target: "got" },
      ],
    }),
  );
  assert.equal(usageFromAtlas(root, ["got"]).got, 3);
});

// --- radarScan cache + I4 --------------------------------------------------

function seedRepo(root, { latest = "14.4.5", installed = "9.0.0" } = {}) {
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { got: "^9.0.0" } }));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/got": { version: installed } },
    }),
  );
  return fakeFetch({
    got: {
      "dist-tags": { latest },
      versions: { [latest]: {} },
      time: { [latest]: new Date((NOW_DAY - 30) * DAY).toISOString() },
    },
  });
}

test("radarScan: writes cache; second scan within TTL serves cache (no fetch); refresh re-probes", async () => {
  const root = tmp();
  const fetchImpl = seedRepo(root);
  const first = await radarScan(root, {
    fetchImpl,
    now: NOW_DAY * DAY,
    nowDay: NOW_DAY,
  });
  assert.equal(first.ok, true);
  assert.equal(first.source, "network");
  assert.ok(readRadarCache(root));

  const cached = await radarScan(root, {
    fetchImpl: throwingFetch,
    now: NOW_DAY * DAY,
    nowDay: NOW_DAY,
  });
  assert.equal(cached.source, "cache", "within TTL → cache, no fetch");

  const refreshed = await radarScan(root, {
    fetchImpl,
    now: NOW_DAY * DAY,
    nowDay: NOW_DAY,
    refresh: true,
  });
  assert.equal(refreshed.source, "network");
});

test("radarScan: offline with no cache → ok:false honest; expired TTL + dead net → stale-served", async () => {
  const root = tmp();
  const off = await radarScan(root, {
    offline: true,
    now: NOW_DAY * DAY,
    nowDay: NOW_DAY,
  });
  assert.equal(off.ok, false);
  assert.match(off.reason, /offline|no cache/i);

  const fetchImpl = seedRepo(root);
  await radarScan(root, { fetchImpl, now: NOW_DAY * DAY, nowDay: NOW_DAY });
  // 48h later with a dead network → stale-served cache
  const later = NOW_DAY * DAY + 48 * 3600000;
  const stale = await radarScan(root, {
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async json() {
        return {};
      },
    }),
    now: later,
    nowDay: NOW_DAY + 2,
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.ok(stale.ageH >= 47);
});

test("radarScan: FORGE_RADAR_TTL_H honored", async () => {
  const root = tmp();
  const fetchImpl = seedRepo(root);
  await radarScan(root, { fetchImpl, now: NOW_DAY * DAY, nowDay: NOW_DAY });
  process.env.FORGE_RADAR_TTL_H = "1";
  try {
    // 2h later, TTL=1h → cache is stale, so a throwing fetch would blow up unless offline.
    const later = NOW_DAY * DAY + 2 * 3600000;
    const r = await radarScan(root, {
      offline: true,
      now: later,
      nowDay: NOW_DAY,
    });
    assert.equal(r.stale, true, "past a 1h TTL the cache is stale");
  } finally {
    delete process.env.FORGE_RADAR_TTL_H;
  }
});

test("radarScan I4: ledger gains a live currency fact; re-scan supersedes; metrics line recorded", async () => {
  const root = tmp();
  process.env.FORGE_AUTHOR = "radar-test <r@t>";
  try {
    const fetchImpl = seedRepo(root, { latest: "9.0.0", installed: "9.0.0" }); // fresh → adopt
    await radarScan(root, { fetchImpl, now: NOW_DAY * DAY, nowDay: NOW_DAY });
    let facts = loadClaims(repoLedger(root)).filter(
      (c) => c.kind === "fact" && !c.tombstone && c.body?.name === "currency:got",
    );
    assert.equal(facts.length, 1, "one live currency fact");
    const firstText = facts[0].body.text;

    // re-scan with a much older latest → ring changes → supersede keeps ONE live fact
    const fetch2 = seedRepo(root, { latest: "99.0.0", installed: "9.0.0" });
    await radarScan(root, {
      fetchImpl: fetch2,
      now: NOW_DAY * DAY,
      nowDay: NOW_DAY,
      refresh: true,
    });
    facts = loadClaims(repoLedger(root)).filter(
      (c) => c.kind === "fact" && !c.tombstone && c.body?.name === "currency:got",
    );
    assert.equal(facts.length, 1, "supersede → still exactly one live currency fact");
    assert.notEqual(facts[0].body.text, firstText, "latest verification replaced the old one");

    const radarMetrics = readMetrics(root, { stage: "radar" });
    assert.ok(radarMetrics.length >= 1, "a stage:radar metrics line was recorded");
  } finally {
    delete process.env.FORGE_AUTHOR;
  }
});

// --- radarAdvisory + hook e2e ---------------------------------------------

function seedHoldCache(root, dep = "left-pad") {
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "radar.json"),
    JSON.stringify({
      t: Date.now(),
      generatedDay: NOW_DAY,
      deps: {
        [dep]: {
          ring: "hold",
          score: 1,
          installed: "1.3.0",
          latest: "1.3.0",
          reasons: ["marked deprecated by its maintainer"],
          evidenceKinds: 4,
          hasAdvisory: false,
        },
      },
      skipped: [],
    }),
  );
}

test("radarAdvisory: names dep + file for an importing file; silent otherwise", () => {
  const root = tmp();
  seedHoldCache(root);
  const f = join(root, "src", "x.js");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(f, "import leftPad from 'left-pad';\n");
  const msg = radarAdvisory(root, f);
  assert.match(msg, /left-pad/);
  assert.match(msg, /x\.js/);

  // FORGE_RADAR=0 kill switch
  process.env.FORGE_RADAR = "0";
  try {
    assert.equal(radarAdvisory(root, f), "");
  } finally {
    delete process.env.FORGE_RADAR;
  }

  // non-importing file → "" (low-nag)
  const g = join(root, "src", "y.js");
  writeFileSync(g, "import { readFileSync } from 'node:fs';\n");
  assert.equal(radarAdvisory(root, g), "");

  // no cache → ""
  assert.equal(radarAdvisory(tmp(), f), "");
});

const HOOK = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));

test("hook e2e: pre-edit surfaces the currency advisory; fail-safe with no cache", () => {
  const root = tmp();
  seedHoldCache(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const f = join(root, "src", "x.js");
  writeFileSync(f, "import leftPad from 'left-pad';\n");
  const r = spawnSync("node", [HOOK, "pre-edit"], {
    input: JSON.stringify({ cwd: root, tool_input: { file_path: f } }),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /left-pad/);

  // no cache → exit 0, no output
  const bare = spawnSync("node", [HOOK, "pre-edit"], {
    input: JSON.stringify({ cwd: tmp(), tool_input: { file_path: f } }),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(bare.status, 0);
});

// --- CLI e2e ---------------------------------------------------------------

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI: `radar --offline` with seeded cache → table with ring; --json parses", () => {
  const root = tmp();
  seedHoldCache(root, "got");
  const r = spawnSync("node", [CLI, "radar", "--offline"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 10000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hold/);
  assert.match(r.stdout, /got/);

  const j = spawnSync("node", [CLI, "radar", "--offline", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.deps.got);
});
