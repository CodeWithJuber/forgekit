import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  reusePeek,
  reuseQuery,
  revalidate,
  specKey,
} from "../src/reuse.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-reuse-"));
/** A real one-commit repo: store-level evidence must cite a git object that resolves in it
 *  (the only ref type forge re-derives — review C2). Returns {root, head}. */
const gitRepo = () => {
  const root = tmp();
  const g = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  g("init");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(root, "f.txt"), "hello\n");
  g("add", "-A");
  g("commit", "-m", "init");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
};

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

test("fingerprint: exact key is context-sensitive (slice) and lossless but whitespace; sketch is stable", () => {
  const f1 = fingerprint("build a rate limiter", "slice-a");
  const f2 = fingerprint("build a rate limiter", "slice-b");
  const f3 = fingerprint("  build a \n rate   limiter ", "slice-a");
  const f4 = fingerprint("build a RATE limiter", "slice-a");
  assert.notEqual(f1.exact, f2.exact, "different graph context → different exact key");
  assert.equal(f1.exact, f3.exact, "whitespace never forks the key");
  assert.notEqual(f1.exact, f4.exact, "case is identity (F04): only whitespace is normalized");
  assert.deepEqual(f1.sketch, f2.sketch);
});

test("F04: behaviour-changing pairs never share an exact key and never near-serve", () => {
  const pairs = [
    ["accept ages >= 18 at signup", "accept ages <= 18 at signup"],
    ['return "ADMIN" for the owner role', 'return "admin" for the owner role'],
    ["set enabled = true on the feature flag", "set enabled != true on the feature flag"],
    ["call getURL before the redirect", "call getUrl before the redirect"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(specKey(a), specKey(b), `${a} / ${b}`);
    assert.notEqual(fingerprint(a).exact, fingerprint(b).exact);
    const r = lookup([verified(a)], b, { nowDay: 0 });
    assert.ok(r.tier === "adapt" || r.tier === "miss", `${b} got ${r.tier} from ${a}`);
    if (r.tier === "adapt")
      assert.ok(
        r.reasons.some((x) => /held at adapt/.test(x)),
        "the conflict is named",
      );
  }
});

test("bandKeys: 32 deterministic bands; near-duplicates share at least one", () => {
  const long =
    "implement a token bucket rate limiter for the public api gateway with configurable " +
    "burst size and a redis backing store for distributed counters across instances";
  const k1 = bandKeys(fingerprint(long).sketch);
  const k2 = bandKeys(fingerprint(`${long} please`).sketch);
  assert.equal(k1.length, 32);
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
    ref: `git:${String(i).repeat(8)}`,
    author: "ci",
    t: 0,
    w: 0.8,
    h: `${i}`.repeat(64).slice(0, 64),
  }));
  return c;
};

test("lookup: exact tier — same text (whitespace aside) and slice, proof attached", () => {
  const r = lookup([verified(SPEC)], ` ${SPEC.replace(" ", "\n  ")} `, { nowDay: 0 });
  assert.equal(r.tier, "exact");
  assert.equal(r.jaccard, 1);
  // No repo root and no atlas: the hit is returned, but never presented as checked (F05).
  assert.equal(r.revalidation.status, "unknown");
  assert.equal(r.requiresRevalidation, true);
  // Shouting a word is a different text: not exact (F04), and ALLCAPS is identity to the
  // semantic guard, so it is only offered as a starting point.
  const shouted = lookup([verified(SPEC)], SPEC.replace("implement", "IMPLEMENT"), { nowDay: 0 });
  assert.equal(shouted.tier, "adapt");
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
  const inline = (deps) => {
    const c = verified(SPEC, { deps });
    return { ...c, body: { ...c.body, code: { inline: "export const x = 1" } } };
  };
  const okArt = inline(["validateInput"]);
  const staleArt = inline(["validateInput", "removedHelper"]);
  assert.equal(revalidate(okArt, atlas).status, "valid");
  assert.equal(revalidate(okArt, atlas).ok, true);
  const rv = revalidate(staleArt, atlas);
  assert.deepEqual(
    { ok: rv.ok, status: rv.status, missing: rv.missing },
    { ok: false, status: "invalid", missing: ["removedHelper"] },
  );
  const r = lookup([staleArt], SPEC, { atlas, nowDay: 0 });
  assert.equal(r.tier, "miss");
  assert.ok(r.reasons.some((x) => /failed revalidation: missing removedHelper/.test(x)));
  // No atlas is UNKNOWN validation, not success (F05).
  assert.equal(revalidate(okArt, null).status, "unknown");
  assert.equal(revalidate(okArt, null).ok, false);
});

// --- store level: fill → hit → demote --------------------------------------------------

/** A real artifact file in `root` and its verifiable pointer (describeFile). */
const realFile = (root, rel = "src/limit.js", body = "export const limit = 42;\n") => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
  return describeFile(root, rel);
};

test("mintArtifact + reuseQuery: verified fill serves; serving adds NO evidence of its own (C2)", () => {
  const { root, head } = gitRepo();
  const dir = repoLedger(root);
  const m = mintArtifact(
    dir,
    { spec: SPEC, code: realFile(root).code },
    { evidence: { oracle: "test.run", result: "confirm", ref: `git:${head}` }, t: 0 },
  );
  assert.equal(m.ok, true);
  assert.equal(m.serves, true);
  const atlas = { symbols: [] };
  const before = val(loadClaims(dir)[0], 1);
  for (let day = 1; day <= 10; day++) {
    const r = reuseQuery(root, SPEC, { atlas, nowDay: day });
    assert.equal(r.tier, "exact");
  }
  const ev = readEvidence(dir, m.id);
  assert.equal(ev.length, 1, "ten serves appended nothing — a cache hit is not an oracle");
  assert.ok(val(loadClaims(dir)[0], 1) <= before, "serving never raises confidence");
  const metric = readMetrics(root, { stage: "cache" }).pop();
  assert.equal(metric.outcome, "hit_exact");
  assert.ok(metric.savedEstimate > 0);
});

test("reuseQuery: failed revalidation demotes the artifact in the ledger — for everyone", () => {
  const { root, head } = gitRepo();
  const dir = repoLedger(root);
  const m = mintArtifact(
    dir,
    { spec: SPEC, deps: ["goneHelper"], code: { path: "src/limit.js", sha256: "b".repeat(64) } },
    { evidence: { oracle: "test.run", result: "confirm", ref: `git:${head}` }, t: 0 },
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

test("mint with a made-up ref (C2): `--ref lgtm` is stored but honestly reported as not serving", () => {
  for (const ref of ["lgtm", "session:x", "ci:1", "human:claude@yes"]) {
    const root = tmp();
    const m = mintArtifact(
      repoLedger(root),
      { spec: `${SPEC} ${ref}`, code: {} },
      { evidence: { oracle: "test.run", result: "confirm", ref }, t: 0 },
    );
    assert.equal(m.ok, true, ref);
    assert.equal(m.serves, false, `${ref}: an unresolved ref cannot earn the serving floor`);
    assert.equal(reuseQuery(root, `${SPEC} ${ref}`, { nowDay: 0 }).tier, "miss", ref);
  }
});

test("mint without evidence is honest: stored but flagged as not serving", () => {
  const root = tmp();
  const m = mintArtifact(repoLedger(root), { spec: SPEC, code: {} }, { t: 0 });
  assert.equal(m.ok, true);
  assert.equal(m.serves, false);
  assert.equal(reuseQuery(root, SPEC, { nowDay: 0 }).tier, "miss");
});

// --- F05: the proof is about the bytes it saw — revalidated at the serving boundary ------

test("F05: an artifact whose file changed or was deleted is never served", () => {
  const { root, head } = gitRepo();
  const dir = repoLedger(root);
  const desc = realFile(root, "answer.js", "export const answer = 42;\n");
  mintArtifact(
    dir,
    { spec: SPEC, ...desc },
    { evidence: { oracle: "test.run", result: "confirm", ref: `git:${head}` }, t: 0 },
  );
  const atlas = { symbols: [] };
  assert.equal(reuseQuery(root, SPEC, { atlas, nowDay: 0 }).tier, "exact");
  writeFileSync(join(root, "answer.js"), "export const answer = 99;\n");
  const edited = reusePeek(root, SPEC, { atlas, nowDay: 0 });
  assert.equal(edited.tier, "miss");
  assert.ok(
    edited.reasons.some((x) => /changed since it was verified/.test(x)),
    edited.reasons,
  );
  rmSync(join(root, "answer.js"));
  const deleted = reusePeek(root, SPEC, { atlas, nowDay: 0 });
  assert.equal(deleted.tier, "miss");
  assert.ok(
    deleted.reasons.some((x) => /no longer exists/.test(x)),
    deleted.reasons,
  );
  // A changed FILE is not an oracle contradiction: the proof was true of the old bytes.
  assert.ok(!readEvidence(dir, loadClaims(dir)[0].id).some((e) => e.oracle === "graph.reval"));
});

test("F05: a same-name dependency whose signature changed invalidates the artifact", () => {
  const root = tmp();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.js"), "export function helper(a) {\n  return a;\n}\n");
  writeFileSync(
    join(root, "src", "mod.js"),
    'import { helper } from "./util.js";\nexport const run = () => helper(1);\n',
  );
  const atlas = { symbols: [{ name: "helper", kind: "function", file: "src/util.js", line: 1 }] };
  const desc = describeFile(root, "src/mod.js", { atlas });
  assert.ok(desc.depContracts.helper, "the dependency's declaration is fingerprinted at mint");
  const art = artifactClaim({ spec: SPEC, ...desc }, 0).claim;
  assert.equal(revalidate(art, atlas, { root }).status, "valid");
  writeFileSync(
    join(root, "src", "util.js"),
    "export function helper(a, strict) {\n  return a;\n}\n",
  );
  const rv = revalidate(art, atlas, { root });
  assert.equal(rv.status, "invalid");
  assert.deepEqual(rv.changed, ["helper"]);
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

// --- C9: the exact tier must mean "the same task" --------------------------------------

test("lookup (C9): a different identifier is never served as exact or near", () => {
  const cache = [verified("add pagination to listUsers")];
  const same = lookup(cache, "Add pagination to listUsers", { nowDay: 0 });
  assert.equal(same.tier, "near", "a case change is not the same TEXT (F04) — serve-with-diff");
  const other = lookup(cache, "add pagination to listOrders", { nowDay: 0 });
  assert.ok(
    other.tier === "adapt" || other.tier === "miss",
    `listOrders got tier ${other.tier} (similarity ${other.similarity}) from the listUsers artifact`,
  );
  const renamed = lookup(cache, "rename snake_case_var to parseConfig", { nowDay: 0 });
  assert.equal(renamed.tier, "miss");
});

test("lookup (C9): two unrelated non-ASCII specs are not 'exact'", () => {
  const cache = [verified("أضف ترقيم الصفحات إلى قائمة المستخدمين")];
  assert.equal(lookup(cache, "احذف حساب المستخدم", { nowDay: 0 }).tier, "miss");
  assert.equal(
    lookup(cache, "أضف ترقيم الصفحات إلى قائمة المستخدمين", { nowDay: 0 }).tier,
    "exact",
    "the identical Arabic spec still hits",
  );
  assert.notEqual(normalizeSpec("احذف حساب المستخدم"), "", "non-ASCII words survive normalization");
});

test("lookup (C9): the LSH prefilter keeps adapt-tier candidates in a big ledger", () => {
  const BASE =
    "implement a token bucket rate limiter for the public api gateway with configurable " +
    "burst size and sliding window fallback plus prometheus metrics and a redis backing store";
  const query = BASE.replace(
    "and sliding window fallback plus prometheus metrics",
    "plus prometheus metrics",
  );
  const target = verified(BASE);
  const fillers = Array.from({ length: 60 }, (_, i) =>
    verified(`refactor the ${i} unrelated widget renderer module for the storefront theme ${i}`),
  );
  const small = lookup([target, ...fillers.slice(0, 10)], query, { nowDay: 0 });
  assert.equal(small.tier, "adapt", "all-pairs (small pool) finds it");
  const big = lookup([target, ...fillers], query, { nowDay: 0 });
  assert.equal(big.tier, "adapt", "and the banded prefilter must not drop it");
  assert.equal(big.artifact.id, target.id);
});
