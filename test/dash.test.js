import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimsData, dashData, historyData, radarData, serve, timelineData } from "../src/dash.js";
import { mintClaim, outcomeRecord } from "../src/ledger.js";
import {
  appendEvidence,
  loadClaims,
  putClaim,
  repoLedger,
  tombstone,
} from "../src/ledger_store.js";
import { record } from "../src/metrics.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-dash-"));
const NOW = 100;

const mint = (dir, name, text, author = "alice") => {
  const c = mintClaim({
    kind: "fact",
    body: { name, text },
    provenance: { author },
    t: NOW,
  }).claim;
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
    JSON.stringify({
      version: 2,
      files: 3,
      symbols: [{ name: "a" }, { name: "b" }],
    }),
  );
  assert.deepEqual(dashData(root, { nowDay: NOW }).atlas, {
    built: true,
    symbols: 2,
    files: 3,
  });
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
    // The ONLY writes are POST /api/ratify and /api/retract — POST anywhere else is 404,
    // as is any other method on the write routes.
    assert.equal(
      (await fetch(`${base}/api/data`, { method: "POST" })).status,
      404,
      "POST to a read route stays 404",
    );
    assert.equal((await fetch(`${base}/nope`, { method: "POST" })).status, 404);
    assert.equal(
      (await fetch(`${base}/api/ratify`, { method: "PUT", body: "{}" })).status,
      404,
      "the write routes are POST-only",
    );
  } finally {
    server.close();
  }
});

test("serve: POST /api/ratify and /api/retract are the two append-only writes", async () => {
  process.env.FORGE_AUTHOR = "dash-tester"; // deterministic identity for gitAuthor()
  const { root, trusted, contested } = fixture();
  const server = serve(root, { port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${addr.port}`;
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  try {
    // ratify → a decision claim, minted with the human author, linked by full id.
    const r1 = await post("/api/ratify", { id: trusted.id.slice(0, 8) });
    assert.equal(r1.status, 200);
    const out = await r1.json();
    assert.equal(out.ok, true);
    assert.equal(out.ratifies, trusted.id);
    const decision = loadClaims(repoLedger(root)).find((c) => c.kind === "decision");
    assert.deepEqual(decision.body, { ratifies: trusted.id, note: "" });
    assert.equal(decision.provenance.author, "dash-tester");
    // …and the new decision shows up in the read payload.
    const d = await (await fetch(`${base}/api/data`)).json();
    assert.equal(d.ledger.stats.byKind.decision, 1);
    assert.ok(d.ledger.claims.some((c) => c.kind === "decision"));

    // retract → the claim reads as tombstoned in the payload, reason preserved on disk.
    const r2 = await post("/api/retract", {
      id: contested.id.slice(0, 8),
      reason: "wrong port",
    });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).ok, true);
    const d2 = await (await fetch(`${base}/api/data`)).json();
    const row = d2.ledger.claims.find((c) => c.id8 === contested.id.slice(0, 8));
    assert.equal(row.tombstoned, true);
    const onDisk = loadClaims(repoLedger(root)).find((c) => c.id === contested.id);
    assert.equal(onDisk.tombstone.reason, "wrong port");
    assert.equal(onDisk.tombstone.author, "dash-tester");

    // Bad bodies → 400; unknown prefixes → 404. Nothing else was written.
    assert.equal((await post("/api/ratify", "{nope")).status, 400, "bad JSON");
    assert.equal((await post("/api/ratify", {})).status, 400, "missing id");
    assert.equal((await post("/api/retract", { id: "x" })).status, 400, "1-char prefix refused");
    assert.equal((await post("/api/ratify", { id: "zz" })).status, 404, "unknown prefix");
    assert.equal((await post("/api/retract", { id: "zz", reason: "r" })).status, 404);
  } finally {
    delete process.env.FORGE_AUTHOR;
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

// --- dash v2 lenses --------------------------------------------------------

const DAY_MS = 86400000;

test("historyData: metrics bucketed by day×stage, saved summed", () => {
  const { root } = fixture();
  const h = historyData(root, { nowDay: NOW });
  assert.equal(h.totals.events, 2, "two metric lines");
  assert.equal(h.stages.cache.saved, 1200);
  assert.equal(h.stages.gate.byOutcome.pass, 1);
  assert.ok(h.buckets.length >= 1, "at least one day bucket");
  assert.ok(Array.isArray(h.stages.cache.series), "per-stage daily series for sparklines");
  assert.equal(h.window, 90);
});

test("historyData: events older than the cap window are dropped", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  const now = 20000; // a day number
  writeFileSync(
    join(root, ".forge", "metrics.jsonl"),
    `${JSON.stringify({ t: (now - 5) * DAY_MS, stage: "gate", outcome: "pass" })}\n` +
      `${JSON.stringify({ t: (now - 200) * DAY_MS, stage: "gate", outcome: "fail" })}\n`,
  );
  const h = historyData(root, { nowDay: now, capDays: 90 });
  assert.equal(h.totals.events, 1, "only the in-window event survives");
  assert.equal(h.stages.gate.byOutcome.pass, 1);
  assert.equal(h.stages.gate.byOutcome.fail, undefined);
});

test("historyData: corrupt/missing metrics degrade to an empty payload", () => {
  const empty = historyData(tmp(), { nowDay: NOW });
  assert.deepEqual(empty.buckets, []);
  assert.deepEqual(empty.stages, {});
  assert.equal(empty.totals.events, 0);
});

test("claimsData: no query ranks live claims by val, with fresh + confidence", () => {
  const { root } = fixture();
  const m = claimsData(root, { nowDay: NOW });
  assert.equal(m.total, 3);
  assert.ok(m.rows.length >= 2, "tombstoned claim is excluded, live ones shown");
  assert.ok(!m.rows.some((r) => r.tombstoned), "no-query browse shows only live claims");
  for (const r of m.rows) {
    assert.equal(typeof r.val, "number");
    assert.equal(typeof r.fresh, "number");
    assert.equal(r.score, null, "no score without a query");
    assert.equal(r.id8.length, 8);
  }
});

test("claimsData: a query ranks via retrieve (scores present) and kind filters", () => {
  const { root, contested } = fixture();
  const m = claimsData(root, { q: "dev server port 4242", nowDay: NOW });
  assert.ok(
    m.rows.some((r) => r.id8 === contested.id.slice(0, 8)),
    "the matching claim surfaces",
  );
  assert.ok(
    m.rows.every((r) => typeof r.score === "number"),
    "query rows carry a retrieval score",
  );
  const facts = claimsData(root, { kind: "fact", nowDay: NOW });
  assert.ok(facts.rows.every((r) => r.kind === "fact"));
  const none = claimsData(root, { kind: "nonexistent", nowDay: NOW });
  assert.deepEqual(none.rows, []);
});

test("radarData: reads the cache, tolerates shape drift, degrades when absent", () => {
  assert.deepEqual(radarData(tmp()), {
    present: false,
    t: null,
    deps: [],
    counts: {},
  });

  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "radar.json"), "{ not json");
  assert.equal(radarData(root).present, false, "unparseable cache → empty panel");

  writeFileSync(
    join(root, ".forge", "radar.json"),
    JSON.stringify({
      t: 1700000000000,
      deps: {
        left: { ring: "hold", score: 0.9, version: "1.0.0", latest: "3.0.0" },
        mid: { ring: "trial", score: 0.4 },
        weird: { ring: "??", score: "nope" }, // drift: bad ring, non-numeric score
      },
    }),
  );
  const r = radarData(root);
  assert.equal(r.present, true);
  assert.equal(r.deps.length, 3);
  assert.equal(r.deps[0].ring, "hold", "hold sorts first");
  assert.equal(r.counts.hold, 1);
  assert.equal(r.counts.trial, 1);
  assert.equal(r.counts.assess, 1, "drifted ring falls back to assess");
  const weird = r.deps.find((d) => d.name === "weird");
  assert.equal(weird.score, null, "non-numeric score → null, never NaN");
});

test("timelineData: durable mint + tombstone events, newest first", () => {
  const { root, retracted } = fixture();
  const t = timelineData(root);
  assert.ok(t.events.length >= 4, "3 mints + 1 tombstone");
  assert.ok(
    t.events.some((e) => e.type === "retract" && e.id8 === retracted.id.slice(0, 8)),
    "the tombstone shows as a retract event",
  );
  for (let i = 1; i < t.events.length; i++)
    assert.ok(t.events[i - 1].day >= t.events[i].day, "newest first");
});

test("timelineData: broken ledger degrades to no events", () => {
  assert.deepEqual(timelineData(tmp()), { count: 0, events: [] });
});

test("serve: v2 endpoints answer 200 with their payloads", async () => {
  const { root } = fixture();
  writeFileSync(
    join(root, ".forge", "radar.json"),
    JSON.stringify({ t: 1, deps: { foo: { ring: "adopt", score: 0.1 } } }),
  );
  const server = serve(root, { port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const hist = await (await fetch(`${base}/api/history`)).json();
    assert.equal(hist.totals.events, 2);

    const radar = await (await fetch(`${base}/api/radar`)).json();
    assert.equal(radar.present, true);
    assert.equal(radar.deps[0].name, "foo");

    const tl = await (await fetch(`${base}/api/timeline`)).json();
    assert.ok(tl.events.length >= 3);

    const mem = await (await fetch(`${base}/api/claims?q=port`)).json();
    assert.equal(mem.q, "port");
    assert.ok(mem.rows.every((r) => typeof r.score === "number"));

    const memAll = await (await fetch(`${base}/api/claims`)).json();
    assert.equal(memAll.total, 3);
  } finally {
    server.close();
  }
});
