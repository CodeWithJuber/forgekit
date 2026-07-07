import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dashData, serve } from "../src/dash.js";
import { mintClaim, outcomeRecord } from "../src/ledger.js";
import { appendEvidence, putClaim, repoLedger, tombstone } from "../src/ledger_store.js";
import { record } from "../src/metrics.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-dash-"));
const NOW = 100;

const mint = (dir, name, text, author = "alice") => {
  const c = mintClaim({ kind: "fact", body: { name, text }, provenance: { author }, t: NOW }).claim;
  putClaim(dir, c);
  return c;
};
const ev = (dir, id, result, ref) =>
  appendEvidence(dir, id, outcomeRecord({ oracle: "test.run", result, ref, t: NOW }).outcome);

/** A fixture repo: 3 claims (one contested, one tombstoned) + 2 metrics lines. */
function fixture() {
  const root = tmp();
  const dir = repoLedger(root);
  const trusted = mint(dir, "style", "tabs are actually spaces here");
  ev(dir, trusted.id, "confirm", "run-1");
  const contested = mint(dir, "port", "the dev server listens on 4242");
  ev(dir, contested.id, "confirm", "run-2"); // 1 confirm + 1 contradict → val = 0.5
  ev(dir, contested.id, "contradict", "run-3");
  const retracted = mint(dir, "old", "we deploy from the ops box");
  tombstone(dir, retracted.id, { author: "alice", reason: "obsolete", t: NOW });
  record(root, { stage: "cache", outcome: "exact", savedEstimate: 1200 });
  record(root, { stage: "gate", outcome: "pass" });
  return { root, trusted, contested, retracted };
}

test("dashData: one payload with ledger, metrics, and atlas sections in shape", () => {
  const { root, contested, retracted } = fixture();
  const d = dashData(root, { nowDay: NOW });

  assert.equal(d.repo, root.split("/").pop());
  assert.equal(d.nowDay, NOW);
  assert.equal(d.ledger.stats.total, 3);
  assert.equal(d.ledger.stats.tombstoned, 1);
  assert.equal(d.ledger.stats.byKind.fact, 3);

  assert.equal(d.ledger.claims.length, 3);
  for (const c of d.ledger.claims) {
    assert.equal(c.id8.length, 8, "id8 is the blame handle");
    assert.equal(c.kind, "fact");
    assert.equal(typeof c.val, "number");
    assert.equal(typeof c.evidenceCount, "number");
    assert.equal(c.author, "alice");
    assert.equal(typeof c.tombstoned, "boolean");
    assert.equal(typeof c.text, "string");
    assert.ok(c.text.length > 0, "text comes from claimText, never empty for a fact");
  }
  const tomb = d.ledger.claims.find((c) => c.id8 === retracted.id.slice(0, 8));
  assert.equal(tomb.tombstoned, true);

  // Contested = val ∈ [0.4, 0.6] AND ≥1 contradiction — exactly the mixed-evidence claim.
  assert.deepEqual(
    d.ledger.contested.map((c) => c.id8),
    [contested.id.slice(0, 8)],
  );
  assert.equal(d.ledger.contested[0].val, 0.5);

  assert.equal(typeof d.ledger.trust.alice, "number", "authorTrust map keyed by author");

  assert.equal(d.metrics.stages.cache.savedEstimate, 1200);
  assert.equal(d.metrics.stages.gate.byOutcome.pass, 1);
  assert.equal(d.metrics.recent.length, 2);
  assert.equal(d.metrics.recent[0].stage, "cache");

  assert.deepEqual(d.atlas, { built: false, symbols: 0, files: 0 });
});

test("dashData: atlas section reports a built atlas", () => {
  const { root } = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "atlas.json"),
    JSON.stringify({ version: 2, files: 3, symbols: [{ name: "a" }, { name: "b" }] }),
  );
  assert.deepEqual(dashData(root, { nowDay: NOW }).atlas, { built: true, symbols: 2, files: 3 });
});

test("dashData: corrupt/missing stores degrade to empty sections, never throw", () => {
  const empty = dashData(tmp(), { nowDay: NOW });
  assert.equal(empty.ledger.stats.total, 0);
  assert.deepEqual(empty.ledger.claims, []);
  assert.deepEqual(empty.metrics, { stages: {}, recent: [] });

  const root = tmp();
  mkdirSync(join(root, ".forge", "ledger"), { recursive: true });
  writeFileSync(join(root, ".forge", "ledger", "claims"), "not a directory"); // readdir throws
  writeFileSync(join(root, ".forge", "metrics.jsonl"), "{nope\n{{also nope\n");
  writeFileSync(join(root, ".forge", "atlas.json"), "{corrupt");
  const d = dashData(root, { nowDay: NOW });
  assert.deepEqual(d.ledger.claims, [], "broken ledger → empty section");
  assert.deepEqual(d.metrics.recent, [], "corrupt metrics lines are skipped");
  assert.deepEqual(d.atlas, { built: false, symbols: 0, files: 0 });
});

test("dashData: claims list is capped at 200 while stats keep the true total", () => {
  const root = tmp();
  const dir = repoLedger(root);
  for (let i = 0; i < 205; i++) mint(dir, `n${i}`, `fact number ${i}`);
  const d = dashData(root, { nowDay: NOW });
  assert.equal(d.ledger.claims.length, 200);
  assert.equal(d.ledger.stats.total, 205);
});

test("serve: / is the page, /api/data is the payload, unknown routes 404, GET-only", async () => {
  const { root } = fixture();
  const server = serve(root, { port: 0 }); // ephemeral port, localhost-only default
  await new Promise((resolve) => server.on("listening", resolve));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    assert.match(html, /forge/);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/, "self-contained — no CDN, no remote");

    const data = await fetch(`${base}/api/data`);
    assert.equal(data.status, 200);
    const d = await data.json();
    assert.equal(d.ledger.stats.total, 3);

    assert.equal((await fetch(`${base}/api/impact`)).status, 400, "missing target");
    assert.equal((await fetch(`${base}/api/impact?target=x`)).status, 404, "no atlas yet");
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/data`, { method: "POST" })).status,
      404,
      "no writes in this phase",
    );
  } finally {
    server.close();
  }
});

test("serve: /api/impact traces blast radius once an atlas exists", async () => {
  const root = tmp();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), "export function core() { return 1; }\n");
  writeFileSync(join(root, "src", "b.js"), 'import { core } from "./a.js";\ncore();\n');
  const { build } = await import("../src/atlas.js");
  build({ root });
  const server = serve(root, { port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/impact?target=core`);
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.found, true);
    assert.ok(r.impactedFiles.includes("src/b.js"), "dependent file is in the radius");
  } finally {
    server.close();
  }
});
