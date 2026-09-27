import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/atlas.js";
import { val } from "../src/ledger.js";
import { loadClaims, readEvidence, repoLedger } from "../src/ledger_store.js";
import { read as readMetrics, record, summarize } from "../src/metrics.js";
import {
  artifactClaim,
  bandKeys,
  depContract,
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

test("fingerprint: the exact key is byte-exact and context-sensitive; the sketches are layout-blind", () => {
  const f1 = fingerprint("build a rate limiter", "slice-a");
  const f2 = fingerprint("build a rate limiter", "slice-b");
  const f3 = fingerprint("  build a \n rate   limiter ", "slice-a");
  const f4 = fingerprint("build a RATE limiter", "slice-a");
  assert.notEqual(f1.exact, f2.exact, "different graph context → different exact key");
  assert.equal(f1.exact, fingerprint("build a rate limiter", "slice-a").exact, "deterministic");
  assert.notEqual(f1.exact, f3.exact, "N01: whitespace is part of the exact identity");
  assert.notEqual(f1.exact, f4.exact, "case is identity (F04)");
  assert.deepEqual(f1.keySketch, f3.keySketch, "…but retrieval never sees layout");
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

// --- N01: whitespace, escapes and code points are identity at the exact boundary --------

test("N01: literal whitespace, tabs, escapes, indentation and NFC/NFD never exact-hit", () => {
  const pairs = [
    ['return "a  b"', 'return "a b"'], // the review's counterexample
    ['return "a\tb"', 'return "a b"'], // an embedded tab inside the literal
    ['return "a\nb"', 'return "a\\nb"'], // a real newline vs the escape sequence
    [String.raw`say "a\"b"`, String.raw`say "a\\"b"`], // escaped quote vs escaped backslash
    ["if ok:\n    ping()\npong()", "if ok:\n    ping()\n    pong()"], // Python block scope
    ["all:\n\techo hi", "all:\n    echo hi"], // a Makefile recipe needs its tab
    ["match /a  b/ in the log", "match /a b/ in the log"], // a regex's spaces are its pattern
    ['return "\u00e9"', 'return "e\u0301"'], // composed vs decomposed é
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(fingerprint(a).exact, fingerprint(b).exact, `${a} / ${b}`);
    for (const [minted, asked] of [
      [a, b],
      [b, a],
    ]) {
      const r = lookup([verified(minted)], asked, { nowDay: 0 });
      assert.ok(
        r.tier === "adapt" || r.tier === "miss",
        `${JSON.stringify(asked)} must not be served ${JSON.stringify(minted)} as-is (${r.tier})`,
      );
    }
  }
});

test("N01: genuinely identical specs still hit exact — through the ledger's canonical store", () => {
  const { root, head } = gitRepo();
  const specs = [
    'return "a  b" from fmt',
    "if ok:\n    ping()\npong()",
    "line one\r\nline two", // CRLF: the ledger folds claim TEXT to LF, never the digest
    'return "e\u0301"', // NFD: the ledger folds claim TEXT to NFC, never the digest
  ];
  for (const [i, spec] of specs.entries()) {
    const m = mintArtifact(
      repoLedger(root),
      { spec, code: { inline: `export const answer${i} = ${i};` } },
      { evidence: { oracle: "test.run", result: "confirm", ref: `git:${head}` } },
    );
    assert.ok(m.ok, m.reason);
    const r = reusePeek(root, spec, { nowDay: 0 });
    assert.equal(r.tier, "exact", `${JSON.stringify(spec)} → ${r.tier}`);
    assert.equal(r.artifact?.body?.code?.inline, `export const answer${i} = ${i};`);
  }
});

test("N01: inline code the ledger would rewrite (CRLF, non-NFC) is refused, never folded", () => {
  for (const inline of ['const s = "a\r\nb";', 'const s = "e\u0301";']) {
    const r = artifactClaim({ spec: "keep the bytes", code: { inline } }, 0);
    assert.equal(r.ok, false, JSON.stringify(inline));
    assert.match(r.reason, /file pointer/);
  }
  assert.equal(
    artifactClaim({ spec: "fine", code: { inline: 'const s = "\u00e9";' } }, 0).ok,
    true,
  );
});

test("N01: an artifact keyed before v3 never reaches the exact tier", () => {
  const c = verified(SPEC);
  const v2 = { ...c, body: { ...c.body, keyV: 2 } };
  // …nor near: an older key was stored lossy, so the guard cannot compare it (held at adapt)
  const r = lookup([v2], SPEC, { nowDay: 0 });
  assert.equal(r.tier, "adapt");
  assert.match(r.reasons.join("\n"), /recorded by an older version/);
  const unhashed = { ...c, body: { ...c.body, keyHash: undefined } };
  assert.notEqual(lookup([unhashed], SPEC, { nowDay: 0 }).tier, "exact");
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

test("lookup: exact tier — the same text and slice, proof attached", () => {
  const r = lookup([verified(SPEC)], SPEC, { nowDay: 0 });
  assert.equal(r.tier, "exact");
  assert.equal(r.jaccard, 1);
  // N01: the spec's own edge whitespace is not identity to the near tier, so the same text
  // with spaces around it reaches near…
  assert.equal(lookup([verified(SPEC)], ` ${SPEC} `, { nowDay: 0 }).tier, "near");
  // …but whitespace INSIDE it can be data (a line break, an indentation): held at adapt.
  const spaced = lookup([verified(SPEC)], SPEC.replace(" ", "\n  "), { nowDay: 0 });
  assert.equal(spaced.tier, "adapt");
  assert.match(spaced.reasons.join("\n"), /layout/);
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
  const desc = describeFile(root, "src/mod.js", { atlas: build({ root }) });
  assert.ok(desc.depContracts.helper, "the dependency's declaration is fingerprinted at mint");
  assert.equal(
    desc.depSources.helper,
    "src/util.js",
    "…and pinned to the module it is imported from",
  );
  const art = artifactClaim({ spec: SPEC, ...desc }, 0).claim;
  assert.equal(revalidate(art, build({ root }), { root }).status, "valid");
  writeFileSync(
    join(root, "src", "util.js"),
    "export function helper(a, strict) {\n  return a;\n}\n",
  );
  const rv = revalidate(art, build({ root }), { root });
  assert.equal(rv.status, "invalid");
  assert.deepEqual(rv.changed, ["helper"]);
});

// --- N08: the whole declaration is the contract, and the import binding names the dependency --

/** `answer.js` imports `calc` from `./dep.js`; `after(src, file)` rewrites a file and returns
 *  the minted artifact's revalidation against a freshly built atlas. */
const contractFixture = (depSrc, { extra = {} } = {}) => {
  const root = tmp();
  writeFileSync(join(root, "dep.js"), depSrc);
  writeFileSync(
    join(root, "answer.js"),
    'import { calc } from "./dep.js";\nexport const answer = calc({ a: 42 });\n',
  );
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(root, f), text);
  const desc = describeFile(root, "answer.js", { atlas: build({ root }) });
  const art = artifactClaim({ spec: SPEC, ...desc }, 0).claim;
  return {
    desc,
    after(src, file = "dep.js") {
      writeFileSync(join(root, file), src);
      return revalidate(art, build({ root }), { root });
    },
  };
};

test("N08: a destructured key, default, nested pattern or annotation change invalidates", () => {
  const cases = [
    // the review's counterexample: both used to hash as `export function calc(`
    ["export function calc({a}) { return a; }", "export function calc({b}) { return b; }"],
    ["export function calc({a = 1}) { return a; }", "export function calc({a = 2}) { return a; }"],
    [
      "export function calc({a: {b}}) { return b; }",
      "export function calc({a: {c}}) { return c; }",
    ],
    ["export function calc([x, y]) { return x; }", "export function calc([y, x]) { return x; }"],
    [
      'export function calc(a, sep = " ") { return a; }',
      'export function calc(a, sep = "  ") { return a; }',
    ],
    ["export const calc = ({a}) => a;", "export const calc = ({b}) => b;"],
    [
      "export const calc = async function ({a}) { return a; };",
      "export const calc = async function ({a, b}) { return a; };",
    ],
    [
      "export function calc(a: number): {x: number} {\n  return {x: a};\n}",
      "export function calc(a: number): {y: number} {\n  return {y: a};\n}",
    ],
  ];
  for (const [before, after] of cases) {
    const f = contractFixture(`${before}\n`);
    assert.match(f.desc.depContracts.calc ?? "", /^v2:/, before);
    const rv = f.after(`${after}\n`);
    assert.equal(rv.status, "invalid", `${before} → ${after}`);
    assert.deepEqual(rv.changed, ["calc"]);
  }
});

test("N08: a body-only edit, a reformat or a comment keeps the contract", () => {
  const before = "export function calc({a}) {\n  return a;\n}\n";
  for (const after of [
    "export function calc({a}) {\n  return a * 2; // the body is not the contract\n}\n",
    "export function calc( { a } ) { return a; }\n",
    "/** docs */\nexport function calc({a} /* the input */) {\n  return a;\n}\n",
  ])
    assert.equal(contractFixture(before).after(after).status, "valid", after);
});

test("N08: the contract follows the import binding, not the first same-name symbol", () => {
  // `a.js` sorts before `dep.js`: the old resolver fingerprinted a.js's `calc` for everyone.
  const f = contractFixture("export function calc({a}) { return a; }\n", {
    extra: { "a.js": "export function calc(x) { return x; }\n" },
  });
  assert.equal(f.desc.depSources.calc, "dep.js");
  assert.equal(f.after("export function calc(y, z) { return y; }\n", "a.js").status, "valid");
  assert.equal(f.after("export function calc({b}) { return b; }\n").status, "invalid");
  assert.equal(
    f.after("export function other() {}\n").status,
    "invalid",
    "the bound module no longer defines it",
  );
});

test("N08: an ambiguous name, an old-format or an unestablished contract is unknown, never valid", () => {
  const root = tmp();
  writeFileSync(join(root, "a.js"), "export function calc(x) { return x; }\n");
  writeFileSync(join(root, "b.js"), "export function calc(y) { return y; }\n");
  const atlas = build({ root });
  assert.equal(
    depContract(root, atlas, "calc"),
    null,
    "two definitions, no binding: not established",
  );
  assert.match(depContract(root, atlas, "calc", { file: "b.js" }) ?? "", /^v2:/);
  const base = { spec: SPEC, code: { inline: "export const x = calc(1);" }, deps: ["calc"] };
  for (const sig of ["626fb87d7f2b9cde", null]) {
    const art = artifactClaim({ ...base, depContracts: { calc: sig } }, 0).claim;
    const rv = revalidate(art, atlas, { root });
    assert.equal(rv.status, "unknown", String(sig));
    assert.ok(
      rv.unknown.some((u) => u.startsWith("contract of calc")),
      rv.unknown.join("; "),
    );
  }
});

test("N08: Python defaults and class members are contract; a def's body is not", () => {
  const root = tmp();
  const write = (src) => {
    writeFileSync(join(root, "dep.py"), src);
    const atlas = build({ root });
    return { calc: depContract(root, atlas, "calc"), box: depContract(root, atlas, "Box") };
  };
  const v0 = write(
    "def calc(a, scale=1):\n    return a * scale\n\nclass Box:\n    def put(self, x):\n        return x\n",
  );
  assert.match(v0.calc ?? "", /^v2:/);
  const v1 = write(
    "def calc(a, scale=1):\n    return a * scale * 1\n\nclass Box:\n    def put(self, x, y=None):\n        return x\n",
  );
  assert.equal(v1.calc, v0.calc, "a body edit keeps a def's contract");
  assert.notEqual(v1.box, v0.box, "a method signature is part of a class's contract");
  const v2 = write("def calc(a, scale=2):\n    return a * scale * 1\n\nclass Box:\n    pass\n");
  assert.notEqual(v2.calc, v0.calc, "a changed default is a changed contract");
});

test("N08: a value's contract is the value; an overload set is one contract", () => {
  const root = tmp();
  const sig = (src, name) => {
    writeFileSync(join(root, "dep.ts"), src);
    return depContract(root, build({ root }), name);
  };
  assert.notEqual(
    sig("export const LIMIT = 10;\n", "LIMIT"),
    sig("export const LIMIT = 20;\n", "LIMIT"),
  );
  const one =
    "export function over(a: string): void;\nexport function over(a: any) {\n  return a;\n}\n";
  const two = `export function over(a: number): void;\n${one}`;
  assert.notEqual(sig(one, "over"), sig(two, "over"), "an added overload changes the contract");
});

// Review N08 round 2: dependencies are what the imports BIND to, through every import form.
/** A repo whose `answer.*` imports from dep modules; mint, edit, revalidate. */
const bindFixture = (files, answer = "answer.js") => {
  const root = tmp();
  const write = (f, text) => {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), text);
  };
  for (const [f, text] of Object.entries(files)) write(f, text);
  const desc = describeFile(root, answer, { atlas: build({ root }) });
  const art = artifactClaim({ spec: SPEC, ...desc }, 0).claim;
  return {
    desc,
    now: () => revalidate(art, build({ root }), { root }),
    after(edits) {
      for (const [f, text] of Object.entries(edits)) write(f, text);
      return revalidate(art, build({ root }), { root });
    },
  };
};
const DEP0 = "export function calc({ a }) {\n  return a;\n}\n";
const DEP1 = "export function calc({ b }) {\n  return b;\n}\n";

test("N08 round 2: every import form records what the code depends on", () => {
  const cases = [
    ["default", 'import calc from "./dep.js";\nexport const x = calc({ a: 1 });\n'],
    ["namespace", 'import * as dep from "./dep.js";\nexport const x = dep.calc({ a: 1 });\n'],
    ["require", 'const dep = require("./dep.js");\nmodule.exports = dep.calc({ a: 1 });\n'],
    ["dynamic", 'export const x = import("./dep.js");\n'],
    ["side effect", 'import "./dep.js";\nexport const x = 1;\n'],
  ];
  for (const [form, answer] of cases) {
    const f = bindFixture({ "dep.js": DEP0, "answer.js": answer });
    assert.equal(typeof f.desc.moduleDeps["dep.js"], "string", `${form}: a whole-module dep`);
    assert.equal(f.now().status, "valid", form);
    assert.equal(f.after({ "dep.js": DEP1 }).status, "invalid", `${form}: any change invalidates`);
  }
  // A named import through a re-export barrel binds the DEFINING module; the barrel is a
  // whole-module dep, so re-pointing the re-export invalidates too.
  const barrel = bindFixture({
    "impl.js": DEP0,
    "index.js": 'export { calc } from "./impl.js";\n',
    "answer.js": 'import { calc } from "./index.js";\nexport const x = calc({ a: 1 });\n',
  });
  assert.deepEqual(barrel.desc.depSources, { calc: "impl.js" });
  assert.equal(typeof barrel.desc.moduleDeps["index.js"], "string");
  assert.equal(barrel.after({ "impl.js": DEP1 }).status, "invalid");
  // tsconfig path aliases resolve like the atlas resolves them
  const aliased = bindFixture(
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
      "src/dep.ts": DEP0,
      "src/answer.ts": 'import { calc } from "@/dep";\nexport const x = calc({ a: 1 });\n',
    },
    "src/answer.ts",
  );
  assert.deepEqual(aliased.desc.depSources, { calc: "src/dep.ts" });
  assert.equal(aliased.after({ "src/dep.ts": DEP1 }).status, "invalid");
  // Python: a from-import binds the defining module
  const py = bindFixture(
    {
      "dep.py": "def calc(a, b=1):\n    return a\n",
      "answer.py": "from dep import calc\n\nANSWER = calc(1)\n",
    },
    "answer.py",
  );
  assert.deepEqual(py.desc.depSources, { calc: "dep.py" });
  assert.equal(py.after({ "dep.py": "def calc(a, b=2):\n    return a\n" }).status, "invalid");
  // An unresolved relative CODE import is recorded, so the artifact is never "valid"
  const missing = bindFixture({
    "answer.js": 'import { calc } from "./nowhere.js";\nexport const x = calc();\n',
  });
  assert.equal(missing.desc.moduleDeps["./nowhere.js"], null);
  assert.equal(missing.now().status, "unknown");
});

test("N08 round 2: an export alias, an alias const and a dropped export are contract changes", () => {
  const answer = 'import { calc } from "./dep.js";\nexport const x = calc({ a: 1 });\n';
  const alias = bindFixture({
    "dep.js":
      "function impl({ a }) {\n  return a;\n}\nfunction other(x, y) {\n  return x;\n}\nexport { impl as calc };\n",
    "a.js": "export function calc(x) {\n  return x;\n}\n", // an unrelated same-name definition
    "answer.js": answer,
  });
  assert.equal(alias.now().status, "valid");
  const repointed = alias.after({
    "dep.js":
      "function impl({ a }) {\n  return a;\n}\nfunction other(x, y) {\n  return x;\n}\nexport { other as calc };\n",
  });
  assert.equal(repointed.status, "invalid", "the export now binds another function");
  const constAlias = bindFixture({
    "dep.js": "function impl({ a }) {\n  return a;\n}\nexport const calc = impl;\n",
    "answer.js": answer,
  });
  assert.equal(
    constAlias.after({
      "dep.js": "function impl({ b }) {\n  return b;\n}\nexport const calc = impl;\n",
    }).status,
    "invalid",
    "an alias's contract is its target's",
  );
  const dropped = bindFixture({
    "dep.js": "function calc({ a }) {\n  return a;\n}\nexport { calc };\n",
    "answer.js": answer,
  });
  assert.equal(
    dropped.after({
      "dep.js": "function calc({ a }) {\n  return a;\n}\nexport { calc as compute };\n",
    }).status,
    "invalid",
    "no longer exported under the imported name",
  );
});

test("N08 round 2: decorators, split keywords, regex literals and arrows in types are contract", () => {
  const root = tmp();
  const sig = (src, name, file = "dep.ts") => {
    writeFileSync(join(root, file), src);
    return depContract(root, build({ root }), name);
  };
  const differ = (a, b, name, why, file) =>
    assert.notEqual(sig(a, name, file), sig(b, name, file), why);
  differ(
    '@Component({ selector: "a" })\nexport class Widget {\n  x = 1;\n}\n',
    '@Component({ selector: "b" })\nexport class Widget {\n  x = 1;\n}\n',
    "Widget",
    "a decorator line above the name",
  );
  differ(
    "export function\ncalc({ a }) {\n  return a;\n}\n",
    "export async function\ncalc({ a }) {\n  return a;\n}\n",
    "calc",
    "a keyword on the line above the name",
  );
  differ(
    "export function calc(re = /[/*]/, a = 1) {\n  return a;\n}\n",
    "export function calc(re = /[/*]/, a = 2) {\n  return a;\n}\n",
    "calc",
    "a regex literal is a literal, never the start of a comment",
  );
  differ(
    "export function calc(): () => number {\n  return () => 1;\n}\n",
    "export function calc(): () => string {\n  return () => 1;\n}\n",
    "calc",
    "an arrow inside a return type does not cut the declaration",
  );
  differ(
    "const noop = () => 0; export function calc(a) {\n  return a;\n}\n",
    "const noop = () => 0; export function calc(a, b) {\n  return a;\n}\n",
    "calc",
    "an earlier arrow on the name's line belongs to another statement",
  );
  differ(
    "@dataclass\nclass Point:\n    x: int\n",
    "@dataclass(frozen=True)\nclass Point:\n    x: int\n",
    "Point",
    "a Python decorator",
    "dep.py",
  );
});

test("N08 round 2: a dependency edited since the atlas was built is unknown, never valid", () => {
  const root = tmp();
  writeFileSync(join(root, "dep.js"), DEP0);
  writeFileSync(
    join(root, "answer.js"),
    'import { calc } from "./dep.js";\nexport const x = calc({ a: 1 });\n',
  );
  const atlas = build({ root });
  const art = artifactClaim({ spec: SPEC, ...describeFile(root, "answer.js", { atlas }) }, 0).claim;
  writeFileSync(join(root, "dep.js"), `// moved down\n\n${DEP1}`);
  const rv = revalidate(art, atlas, { root }); // the OLD atlas: its lines describe other text
  assert.equal(rv.status, "unknown");
  assert.match(rv.unknown.join("\n"), /changed since the atlas was built/);
});

test("N01 round 2: a key the ledger stores normalized never reaches the near tier", () => {
  const crlf = "keep the CRLF line\r\nand this one";
  const c = verified(crlf);
  assert.equal(c.body.keyVerbatim, false);
  const r = lookup([c], crlf.replace("\r\n", "\n"), { nowDay: 0 });
  assert.equal(r.tier, "adapt");
  assert.match(r.reasons.join("\n"), /stored normalized/);
  assert.equal(verified(SPEC).body.keyVerbatim, true);
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
