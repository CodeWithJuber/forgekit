import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import { mintClaim, outcomeRecord } from "../src/ledger.js";
import { appendEvidence, putClaim, repoLedger, tombstone } from "../src/ledger_store.js";
import { record } from "../src/metrics.js";
import {
  historyByDay,
  readRadar,
  renderReport,
  reportPath,
  sparkline,
  writeReport,
} from "../src/report.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-report-"));
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
  ev(dir, contested.id, "confirm", "run-2");
  ev(dir, contested.id, "contradict", "run-3");
  const retracted = mint(dir, "old", "we deploy from the ops box");
  tombstone(dir, retracted.id, { author: "alice", reason: "obsolete", t: NOW });
  record(root, { stage: "cache", outcome: "exact", savedEstimate: 1200 });
  record(root, { stage: "gate", outcome: "pass" });
  return { root, trusted, contested, retracted };
}

test("renderReport: self-contained — no external http references", () => {
  const { root } = fixture();
  const html = renderReport(root);
  assert.match(html, /^<!doctype html>/);
  // The core self-containment guarantee: nothing to fetch over the network.
  assert.ok(!/https?:\/\//.test(html), "report must carry zero external http(s) references");
  assert.ok(!/<script/i.test(html), "static report ships no JavaScript");
  assert.ok(!/src=|href=/.test(html), "no external asset links");
});

test("renderReport: embeds the brand token block from rootTokensCss", () => {
  const { root } = fixture();
  const html = renderReport(root);
  // rootTokensCss emits a :root{...} block plus a light-scheme media override.
  assert.match(html, /:root\{color-scheme:dark;/);
  assert.match(html, /--brand:#/);
  assert.match(html, /@media\(prefers-color-scheme:light\)/);
  // Brand string comes from the token, not a literal.
  assert.ok(html.includes(BRAND.brand));
});

test("renderReport: surfaces ledger claims and metric stages", () => {
  const { root } = fixture();
  const html = renderReport(root);
  assert.ok(html.includes("tabs are actually spaces here"), "claim text rendered");
  assert.ok(html.includes("cache") && html.includes("gate"), "stage rows rendered");
  assert.ok(html.includes("1200"), "summed savedEstimate rendered");
});

test("renderReport: escapes dynamic claim text", () => {
  const root = tmp();
  const dir = repoLedger(root);
  mint(dir, "xss", "<img> & 'quote' \"dq\"");
  const html = renderReport(root);
  assert.ok(html.includes("&lt;img&gt;"), "angle brackets escaped");
  assert.ok(!html.includes("<img>"), "raw markup never emitted");
});

test("renderReport: empty repo degrades to a valid page, never throws", () => {
  const root = tmp();
  const html = renderReport(root);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes("no claims yet"));
});

test("readRadar: absent cache → null (section omitted)", () => {
  const root = tmp();
  assert.equal(readRadar(root), null);
  const html = renderReport(root);
  assert.ok(!html.includes("Tech radar"), "radar section omitted when no cache");
});

test("readRadar: reads .forge/radar.json defensively and renders", () => {
  const root = tmp();
  const dir = join(root, ".forge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "radar.json"),
    JSON.stringify({
      generatedAt: "2026-07-01",
      entries: [
        { name: "left-pad", ring: "hold", note: "abandoned" },
        { dep: "undici", status: "adopt" },
      ],
    }),
  );
  const radar = readRadar(root);
  assert.equal(radar.entries.length, 2);
  assert.equal(radar.entries[0].name, "left-pad");
  assert.equal(radar.entries[1].name, "undici");
  assert.equal(radar.entries[1].ring, "adopt");
  const html = renderReport(root);
  assert.ok(html.includes("Tech radar"));
  assert.ok(html.includes("left-pad"));
});

test("readRadar: bare array and corrupt JSON both handled", () => {
  const root = tmp();
  const dir = join(root, ".forge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "radar.json"), "{ not json");
  assert.equal(readRadar(root), null, "corrupt → null");
  writeFileSync(join(dir, "radar.json"), JSON.stringify([{ name: "a", ring: "trial" }]));
  assert.equal(readRadar(root).entries.length, 1, "bare array accepted");
});

test("historyByDay: buckets metrics into the day window", () => {
  const { root } = fixture();
  const h = historyByDay(root);
  assert.equal(h.days, 90);
  assert.equal(h.counts.length, 90);
  assert.equal(h.total, 2, "two metric lines in the window");
  assert.equal(h.byStage.cache.events, 1);
  assert.equal(h.byStage.cache.saved, 1200);
  // today's bucket (last slot) holds both fresh events
  assert.equal(h.counts[h.counts.length - 1], 2);
});

test("sparkline: inline SVG with no xmlns / external ref", () => {
  const svg = sparkline([1, 2, 3, 0, 5]);
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes("xmlns"), "inline SVG carries no namespace URL");
  assert.ok(!/https?:/.test(svg));
  assert.match(svg, /<polyline /);
  // empty series still yields a baseline
  assert.match(sparkline([]), /<polyline /);
});

test("writeReport: writes .forge/report.html and returns its path", () => {
  const { root } = fixture();
  const path = writeReport(root);
  assert.equal(path, reportPath(root));
  const onDisk = readFileSync(path, "utf8");
  assert.match(onDisk, /^<!doctype html>/);
  assert.ok(onDisk.includes("tabs are actually spaces here"));
});
