import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { val } from "../src/ledger.js";
import { loadClaims, readEvidence, repoLedger } from "../src/ledger_store.js";
import { read as readMetrics, record, summarize } from "../src/metrics.js";
import {
  artifactClaim,
  bandKeys,
  describeFile,
  fingerprint,
  lookup,
  mintArtifact,
  normalizeSpec,
  reuseQuery,
  revalidate,
} from "../src/reuse.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-reuse-"));

// --- normalization -------------------------------------------------------------------

test("normalizeSpec: volatile literals become typed placeholders; prose lowercases", () => {
  assert.equal(
    normalizeSpec("Add pagination to listUsers with pageSize 25 in src/api/users.ts"),
    "add pagination to ⟨ident⟩ with ⟨ident⟩ ⟨num⟩ in ⟨path⟩",
  );
  assert.equal(normalizeSpec('sort by "created_at" DESC'), "sort by ⟨str⟩ desc");
  assert.equal(normalizeSpec("use MAX_RETRIES from config.limits"), "use ⟨ident⟩ from ⟨ident⟩");
});

test("normalizeSpec: the same task worded across teammates fingerprints identically", () => {
  const a = normalizeSpec("Add pagination to listUsers with pageSize 25");
  const b = normalizeSpec("add   pagination to listOrders with maxItems 100");
  assert.equal(a, b, "identifier/number shape matches — same near-neighborhood");
});

test("fingerprint: exact key is context-sensitive (slice), sketch is stable", () => {
  const f1 = fingerprint("build a rate limiter", "slice-a");
  const f2 = fingerprint("build a rate limiter", "slice-b");
  const f3 = fingerprint("build a  RATE limiter", "slice-a");
  assert.notEqual(f1.exact, f2.exact, "different graph context → different exact key");
  assert.equal(f1.exact, f3.exact, "whitespace/case never fork the key");
  assert.deepEqual(f1.sketch, f2.sketch);
});

test("bandKeys: 16 deterministic bands; near-duplicates share at least one", () => {
  const long =
    "implement a token bucket rate limiter for the public api gateway with configurable " +
    "burst size and a redis backing store for distributed counters across instances";
  const k1 = bandKeys(fingerprint(long).sketch);
  const k2 = bandKeys(fingerprint(`${long} please`).sketch);
  assert.equal(k1.length, 16);
  assert.deepEqual(k1, bandKeys(fingerprint(long).sketch), "deterministic");
  assert.ok(
    k1.some((k) => k2.includes(k)),
    "near-duplicates collide in some band",
  );
});

// --- the lookup ladder (pure) ----------------------------------------------------------

const SPEC =
  "implement a token bucket rate limiter for the public api gateway with configurable " +
  "burst size and sliding window fallback";
const verified = (spec, { slice = "", deps = [], evidence = 2 } = {}) => {
  const c = artifactClaim(
    { spec, slice, deps, code: { path: "src/limit.js", sha256: "x".repeat(64) } },
    0,
  ).claim;
  c.evidence = Array.from({ length: evidence }, (_, i) => ({
    oracle: "test.run",
    result: "confirm",
    ref: `run:${i}`,
    author: "ci",
    t: 0,
    w: 0.8,
    h: `${i}`.repeat(64).slice(0, 64),
  }));
  return c;
};

test("lookup: exact tier — same normalized spec and slice, proof attached", () => {
  const r = lookup([verified(SPEC)], SPEC.replace("implement", "IMPLEMENT"), { nowDay: 0 });
  assert.equal(r.tier, "exact");
  assert.equal(r.jaccard, 1);
});

test("lookup: the proof floor — an unverified artifact NEVER serves", () => {
  const fresh = { ...verified(SPEC), evidence: [] };
  const r = lookup([fresh], SPEC, { nowDay: 0 });
  assert.equal(r.tier, "miss");
  assert.ok(r.reasons.some((x) => /below proof floor/.test(x)));
});

test("lookup: near tier for a reworded spec; adapt tier for a related one; miss for unrelated", () => {
  const cache = [verified(SPEC)];
  const near = lookup(cache, SPEC.replace("sliding window fallback", "sliding window backup"), {
    nowDay: 0,
  });
  assert.equal(near.tier, "near");
  assert.ok(near.jaccard >= 0.8);
  const adapt = lookup(
    cache,
    SPEC.replace("and sliding window fallback", "plus prometheus metrics exporters"),
    { nowDay: 0 },
  );
  assert.equal(adapt.tier, "adapt");
  assert.ok(adapt.jaccard >= 0.6 && adapt.jaccard < 0.8);
  assert.equal(lookup(cache, "write a css dark mode toggle", { nowDay: 0 }).tier, "miss");
});

test("lookup: exact hits are slice-scoped — a different graph context falls through to near", () => {
  const cache = [verified(SPEC, { slice: "ctx-A" })];
  const r = lookup(cache, SPEC, { slice: "ctx-B", nowDay: 0 });
  assert.equal(r.tier, "near", "same text, different context: serve-with-diff, not exact");
});

test("revalidate: a vanished dependency blocks serving (stale cache can't ship)", () => {
  const atlas = { symbols: [{ name: "validateInput" }] };
  const okArt = verified(SPEC, { deps: ["validateInput"] });
  const staleArt = verified(SPEC, { deps: ["validateInput", "removedHelper"] });
  assert.equal(revalidate(okArt, atlas).ok, true);
  const rv = revalidate(staleArt, atlas);
  assert.deepEqual({ ok: rv.ok, missing: rv.missing }, { ok: false, missing: ["removedHelper"] });
  const r = lookup([staleArt], SPEC, { atlas, nowDay: 0 });
  assert.equal(r.tier, "miss");
  assert.ok(r.reasons.some((x) => /failed revalidation: missing removedHelper/.test(x)));
});

// --- store level: fill → hit → demote --------------------------------------------------

test("mintArtifact + reuseQuery: verified fill serves; the serve refreshes structural evidence", () => {
  const root = tmp();
  const dir = repoLedger(root);
  const m = mintArtifact(
    dir,
    { spec: SPEC, code: { path: "src/limit.js", sha256: "a".repeat(64) } },
    { evidence: { oracle: "test.run", result: "confirm", ref: "run:42" }, t: 0 },
  );
  assert.equal(m.ok, true);
  assert.equal(m.serves, true);
  const atlas = { symbols: [] };
  const r = reuseQuery(root, SPEC, { atlas, nowDay: 1 });
  assert.equal(r.tier, "exact");
  const ev = readEvidence(dir, m.id);
  assert.ok(
    ev.some((e) => e.oracle === "graph.reval" && e.result === "confirm"),
    "serving appended a structural confirmation",
  );
  const metric = readMetrics(root, { stage: "cache" }).pop();
  assert.equal(metric.outcome, "hit_exact");
  assert.ok(metric.savedEstimate > 0);
});

test("reuseQuery: failed revalidation demotes the artifact in the ledger — for everyone", () => {
  const root = tmp();
  const dir = repoLedger(root);
  const m = mintArtifact(
    dir,
    { spec: SPEC, deps: ["goneHelper"], code: { path: "src/limit.js", sha256: "b".repeat(64) } },
    { evidence: { oracle: "test.run", result: "confirm", ref: "run:1" }, t: 0 },
  );
  const before = val(loadClaims(dir)[0], 0);
  const r = reuseQuery(root, SPEC, { atlas: { symbols: [] }, nowDay: 0 });
  assert.equal(r.tier, "miss");
  const after = loadClaims(dir).find((c) => c.id === m.id);
  assert.ok(
    after.evidence.some((e) => e.oracle === "graph.reval" && e.result === "contradict"),
    "the missing dep became a contradiction",
  );
  assert.ok(val(after, 0) < before, "the cache pruned itself by ground truth");
  assert.equal(readMetrics(root, { stage: "cache" }).pop().outcome, "miss");
});

test("mint without evidence is honest: stored but flagged as not serving", () => {
  const root = tmp();
  const m = mintArtifact(repoLedger(root), { spec: SPEC, code: {} }, { t: 0 });
  assert.equal(m.ok, true);
  assert.equal(m.serves, false);
  assert.equal(reuseQuery(root, SPEC, { nowDay: 0 }).tier, "miss");
});

// --- helpers ----------------------------------------------------------------------------

test("describeFile: extracts exports, relative-import deps, and a verifiable content hash", () => {
  const root = tmp();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "mod.js"),
    [
      'import { helperA, helperB as hb } from "./util.js";',
      'import fs from "node:fs";',
      "export function main() {}",
      "export const CONFIG = 1;",
      "function internal() {}",
    ].join("\n"),
  );
  const d = describeFile(root, "src/mod.js");
  assert.deepEqual(d.iface.sort(), ["CONFIG", "main"]);
  assert.deepEqual(d.deps.sort(), ["helperA", "helperB"]);
  assert.match(d.code.sha256, /^[0-9a-f]{64}$/);
  assert.equal(d.code.path, "src/mod.js");
});

test("metrics: record/read/summarize roundtrip; corrupt lines skipped", () => {
  const root = tmp();
  record(root, { stage: "cache", outcome: "hit_exact", savedEstimate: 100 });
  record(root, { stage: "cache", outcome: "miss", savedEstimate: 0 });
  record(root, { stage: "route", outcome: "cheap" });
  writeFileSync(join(root, ".forge", "metrics.jsonl"), "not json\n", { flag: "a" });
  assert.equal(readMetrics(root).length, 3);
  assert.equal(readMetrics(root, { stage: "cache" }).length, 2);
  const s = summarize(root);
  assert.equal(s.cache.events, 2);
  assert.equal(s.cache.byOutcome.hit_exact, 1);
  assert.equal(s.cache.savedEstimate, 100);
});
