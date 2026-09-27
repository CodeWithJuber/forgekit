// Review 2026-09-26 — A02: property tests for the trust invariants, over seeded random
// inputs (deterministic: a fixed-seed PRNG, so a failure reproduces exactly). Each property is
// one the review found broken by a single counterexample; the generators widen those
// counterexamples into families. Zero failures over n seeded cases is evidence, not proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build as buildAtlas } from "../src/atlas.js";
import { assemble } from "../src/context.js";
import { consolidateLearned } from "../src/learn_consolidate.js";
import { evidenceEvents, outcomeRecord, val } from "../src/ledger.js";
import { repoLedger } from "../src/ledger_store.js";
import {
  artifactClaim,
  depContract,
  describeFile,
  fingerprint,
  lookup,
  mintArtifact,
  reusePeek,
} from "../src/reuse.js";
import { choose, parseObjective } from "../src/router/policy.js";
import { semanticConflicts } from "../src/semantic_guard.js";
import { recursiveTestInvocation } from "../src/stack.js";
import {
  computeCodeState,
  readVerifyEvents,
  VERIFY_EVENT_VERSION,
  verifyEventMac,
} from "../src/verify.js";

// mulberry32 — the same seeded PRNG the benchmark fixtures use.
const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const shuffle = (rand, xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const gitRepo = (files) => {
  const root = mkdtempSync(join(tmpdir(), "forge-prop-git-"));
  const g = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  g("add", "-A");
  g("commit", "-qm", "init");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
};
const POSIX = process.platform !== "win32"; // exec bits and symlinks

test("property: the rendered context never exceeds its budget while claiming completion", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-prop-ctx-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const pad = (n) => Array.from({ length: n }, (_, i) => `// line ${i}`).join("\n");
  writeFileSync(
    join(root, "src", "a.js"),
    `${pad(60)}\nexport function alpha(x) {\n  return x;\n}\n`,
  );
  writeFileSync(
    join(root, "src", "b.js"),
    `import { alpha } from "./a.js";\nexport function beta() {\n  return alpha(2);\n}\n${pad(80)}\n`,
  );
  writeFileSync(join(root, "src", "a.test.js"), `import { alpha } from "./a.js";\n${pad(30)}\n`);
  const atlas = buildAtlas({ root });
  const rand = prng(20260926);
  const budgets = [1, 2, 7, 8, 9, 20, 50, 100, 400, 6000];
  for (let i = 0; i < 40; i++) budgets.push(1 + Math.floor(rand() * 900));
  for (const budget of budgets) {
    const r = assemble(root, "change alpha in src/a.js and src/b.js", { atlas, budget });
    assert.ok(r.tokens <= budget, `budget ${budget}: rendered ${r.tokens} tokens`);
    if (r.ok) {
      assert.equal(r.overflow, false, `budget ${budget}`);
      assert.deepEqual(r.pending, [], `budget ${budget}: ok with pending reads`);
      assert.deepEqual(r.missing, [], `budget ${budget}: ok with missing keys`);
    }
    for (const k of r.covered) assert.ok(r.required.includes(k) || !k.includes(":"));
    for (const k of r.pending)
      assert.ok(!r.covered.includes(k), "pending and covered are disjoint");
  }
});

test("property: evidence counts per event — any spelling mix, any order, any replay", () => {
  const rand = prng(7);
  const hex = () =>
    Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  for (let trial = 0; trial < 60; trial++) {
    const k = 1 + Math.floor(rand() * 4);
    const oids = Array.from({ length: k }, hex);
    // One canonical record per event…
    const canonical = oids.map(
      (oid, i) =>
        outcomeRecord({ oracle: "test.run", result: "confirm", ref: `git:${oid}`, t: i }).outcome,
    );
    // …versus the same events cited under random abbreviations, re-cited LATER (which must not
    // refresh decay), duplicated, and shuffled.
    const aliases = [];
    oids.forEach((oid, i) => {
      aliases.push(canonical[i]);
      const extra = Math.floor(rand() * 4);
      for (let j = 0; j < extra; j++) {
        const len = 7 + Math.floor(rand() * 34);
        aliases.push(
          outcomeRecord({
            oracle: "test.run",
            result: "confirm",
            ref: `git:${rand() < 0.5 ? oid.slice(0, len) : oid.slice(0, len).toUpperCase()}`,
            author: `a${j}`,
            t: i + 1 + j,
          }).outcome,
        );
      }
    });
    const replayed = shuffle(rand, [...aliases, ...aliases]);
    const now = k + 5;
    assert.equal(evidenceEvents(replayed).length, k, `trial ${trial}: ${k} distinct events`);
    assert.equal(
      val({ evidence: replayed }, now),
      val({ evidence: canonical }, now),
      `trial ${trial}: aliases, replays and order must not move confidence`,
    );
  }
});

test("property: a budget is never reported met when it is not, and infeasibility is explicit", () => {
  const rand = prng(99);
  for (let trial = 0; trial < 80; trial++) {
    const m = 2 + Math.floor(rand() * 3);
    const q = 1 + Math.floor(rand() * 3);
    const P = Array.from({ length: m }, () => Array.from({ length: q }, () => rand()));
    const w = Array.from({ length: q }, () => 1 / q);
    const costs = Array.from({ length: m }, () => 0.01 + rand() * 3);
    const budget = rand() * 2;
    const r = choose(
      { P, weights: w },
      costs,
      [...Array(m).keys()],
      parseObjective(`budget:${budget}`),
      3,
    );
    if (r.feasible) {
      assert.equal(r.budgetMet, true);
      assert.ok(r.cost <= budget + 1e-9, `trial ${trial}: feasible but over budget`);
    } else {
      assert.equal(r.budgetMet, false);
      assert.ok(r.minimumExpectedCost > budget - 1e-12, `trial ${trial}`);
      assert.match(r.reason, /infeasible/);
    }
    assert.ok(
      r.estimatedCostIfAllAttemptsRun >= r.cost - 1e-12,
      "running every attempt costs at least the expectation",
    );
  }
});

test("property: the semantic guard is symmetric and flags every polarity/operator flip", () => {
  const rand = prng(3);
  const subjects = ["the cache", "request signatures", "the admin route", "retries", "the linter"];
  const flips = [
    ["enable", "disable"],
    ["allow", "deny"],
    ["include", "exclude"],
    ["always run", "never run"],
    ["add", "remove"],
    [">=", "<="],
    ["==", "!="],
  ];
  for (let trial = 0; trial < 60; trial++) {
    const s = subjects[Math.floor(rand() * subjects.length)];
    const [x, y] = flips[Math.floor(rand() * flips.length)];
    const tail = rand() < 0.5 ? " before every deploy" : "";
    const a = /[<>=!]/.test(x) ? `accept ${s} ${x} 18${tail}` : `${x} ${s}${tail}`;
    const b = /[<>=!]/.test(y) ? `accept ${s} ${y} 18${tail}` : `${y} ${s}${tail}`;
    const ab = semanticConflicts(a, b);
    const ba = semanticConflicts(b, a);
    assert.ok(ab.length > 0, `${a} / ${b} must conflict`);
    assert.deepEqual(
      ab.map((c) => c.kind),
      ba.map((c) => c.kind),
      "symmetric",
    );
    assert.deepEqual(semanticConflicts(a, a), [], "a text never conflicts with itself");
  }
});

test("property: any composition of manifest transformations moves the fingerprint; undoing restores it", () => {
  const { root } = gitRepo({ "tracked.js": "export const x = 1;\n" });
  const p = (f) => join(root, f);
  writeFileSync(p("a.txt"), "alpha\n");
  writeFileSync(p("b.txt"), "left");
  writeFileSync(p("c.txt"), "right");
  writeFileSync(p("run.sh"), "echo hi\n");
  chmodSync(p("run.sh"), 0o644);
  if (POSIX) symlinkSync("b.txt", p("link"));
  const split = (b, c) => () => {
    writeFileSync(p("b.txt"), b);
    writeFileSync(p("c.txt"), c);
  };
  const relink = (target) => () => {
    rmSync(p("link"));
    symlinkSync(target, p("link"));
  };
  // Each transformation touches its own files, so any subset composes and undoes cleanly.
  const ops = [
    [
      "rename an untracked file",
      () => renameSync(p("a.txt"), p("a2.txt")),
      () => renameSync(p("a2.txt"), p("a.txt")),
    ],
    ["move a byte across a file boundary", split("lef", "tright"), split("left", "right")],
    ["add an empty file", () => writeFileSync(p("empty.txt"), ""), () => rmSync(p("empty.txt"))],
    [
      "edit a tracked file",
      () => writeFileSync(p("tracked.js"), "export const x = 2;\n"),
      () => writeFileSync(p("tracked.js"), "export const x = 1;\n"),
    ],
    ...(POSIX
      ? [
          [
            "set an exec bit",
            () => chmodSync(p("run.sh"), 0o755),
            () => chmodSync(p("run.sh"), 0o644),
          ],
          ["retarget a symlink", relink("c.txt"), relink("b.txt")],
        ]
      : []),
  ];
  const base = computeCodeState(root);
  assert.equal(typeof base.dirtyHash, "string");
  const rand = prng(20260926);
  const seen = new Set([base.dirtyHash]);
  for (let trial = 0; trial < 24; trial++) {
    const k = 1 + Math.floor(rand() * 3);
    const pick = shuffle(rand, ops).slice(0, k);
    for (const [, apply] of pick) apply();
    const moved = computeCodeState(root).dirtyHash;
    const names = pick.map(([n]) => n).join(" + ");
    assert.notEqual(moved, base.dirtyHash, `trial ${trial}: ${names} must change the fingerprint`);
    seen.add(moved);
    for (const [, , undo] of [...pick].reverse()) undo();
    assert.equal(computeCodeState(root).dirtyHash, base.dirtyHash, `trial ${trial}: undo ${names}`);
  }
  assert.ok(seen.size > 2, "different compositions reach different fingerprints");
});

test("property: an artifact is never served after any edit, move or deletion of its file", () => {
  const { root, head } = gitRepo({ "seed.txt": "seed\n" });
  const dir = repoLedger(root);
  const body = "export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}\n";
  writeFileSync(join(root, "clamp.js"), body);
  const spec = "clamp a number between a lower and an upper bound, inclusive";
  mintArtifact(
    dir,
    { spec, ...describeFile(root, "clamp.js") },
    { evidence: { oracle: "test.run", result: "confirm", ref: `git:${head}` }, t: 0 },
  );
  const atlas = { symbols: [] };
  const served = () => reusePeek(root, spec, { atlas, nowDay: 0 }).tier;
  assert.equal(served(), "exact");
  const rand = prng(11);
  const edits = [
    ["append a byte", () => writeFileSync(join(root, "clamp.js"), `${body} `)],
    [
      "flip one character",
      () => {
        const i = Math.floor(rand() * body.length);
        const c = body[i] === "x" ? "y" : "x";
        writeFileSync(join(root, "clamp.js"), body.slice(0, i) + c + body.slice(i + 1));
      },
    ],
    [
      "truncate",
      () => writeFileSync(join(root, "clamp.js"), body.slice(0, Math.floor(rand() * body.length))),
    ],
    ["delete", () => rmSync(join(root, "clamp.js"))],
    ["move away", () => renameSync(join(root, "clamp.js"), join(root, "clamp2.js"))],
  ];
  for (let trial = 0; trial < 30; trial++) {
    const [name, edit] = edits[Math.floor(rand() * edits.length)];
    edit();
    assert.notEqual(served(), "exact", `trial ${trial}: served after "${name}"`);
    assert.notEqual(served(), "near", `trial ${trial}: served after "${name}"`);
    rmSync(join(root, "clamp2.js"), { force: true });
    writeFileSync(join(root, "clamp.js"), body);
    assert.equal(served(), "exact", `trial ${trial}: the verified bytes serve again`);
  }
});

// ---------------------------------------------------------------------------------------
// Review 2026-09-27 (suggestion 3): the same properties, along the SEMANTIC boundaries the
// follow-up review crossed — generators that represent quoted whitespace, binding swaps,
// command-option ambiguity, destructured parameters and a degraded evidence key, rather than
// only safe transformations. Each family widens one finding (N01, N02, N03, N08, N06).
// ---------------------------------------------------------------------------------------

const pickFrom = (rand) => (xs) => xs[Math.floor(rand() * xs.length)];
/** A verified in-memory artifact for `spec` (two confirming test runs). */
const provenArtifact = (spec) => {
  const c = artifactClaim({ spec, code: { inline: "export const x = 1;" } }, 0).claim;
  c.evidence = [0, 1].map((i) => ({
    oracle: "test.run",
    result: "confirm",
    ref: `git:${String(i).repeat(8)}`,
    author: "ci",
    t: 0,
    w: 0.8,
    h: `${i}`.repeat(64),
  }));
  return c;
};

test("property (N01): whitespace or a code point inside a quoted literal is never served as-is", () => {
  const rand = prng(20260927);
  const pick = pickFrom(rand);
  const words = ["alpha", "beta", "gamma", "delta", "caf\u00e9", "ok"];
  const edits = [
    (s) => s.replace(" ", "  "), // one space → two (the review's case)
    (s) => s.replace(" ", "\t"), // an embedded tab
    (s) => s.replace(" ", "\n"), // an embedded newline
    (s) => `${s} `, // a trailing space inside the quotes
    (s) => s.replace("\u00e9", "e\u0301"), // composed → decomposed
  ];
  let checked = 0;
  for (let i = 0; i < 80; i++) {
    const q = pick(['"', "'", "`"]);
    const inner = `${pick(words)} ${pick(words)}`;
    const edited = pick(edits)(inner);
    if (edited === inner) continue;
    const tail = ` from the ${pick(words)} formatter`;
    const minted = `return ${q}${inner}${q}${tail}`;
    const asked = `return ${q}${edited}${q}${tail}`;
    assert.notEqual(fingerprint(minted).exact, fingerprint(asked).exact, asked);
    const r = lookup([provenArtifact(minted)], asked, { nowDay: 0 });
    assert.ok(r.tier === "adapt" || r.tier === "miss", `${JSON.stringify(asked)} got ${r.tier}`);
    assert.equal(lookup([provenArtifact(minted)], minted, { nowDay: 0 }).tier, "exact");
    checked++;
  }
  assert.ok(checked >= 60, `only ${checked} cases generated`);
});

test("property (N02): swapping which subject gets which action or value never merges two rules", () => {
  const rand = prng(20260928);
  const pick = pickFrom(rand);
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const TAIL =
    " for every incoming webhook request before processing the payload or allowing the request to access any internal application service or write changes to durable storage in the production environment";
  const roles = ["admins", "guests", "owners", "auditors", "bots", "members", "vendors"];
  const poles = [
    ["allow", "deny"],
    ["enable", "disable"],
    ["include", "exclude"],
    ["show", "hide"],
  ];
  for (let i = 0; i < 40; i++) {
    const [x, y] = shuffle(rand, roles);
    const [p, q] = pick(poles);
    const n = [5, 10, 30, 60, 120];
    const [n1, n2] = shuffle(rand, n);
    const pair = pick([
      [`${cap(p)} ${x} and ${q} ${y}${TAIL}`, `${cap(p)} ${y} and ${q} ${x}${TAIL}`],
      [
        `Use a ${n1}s read timeout and ${n2}s write timeout${TAIL}`,
        `Use a ${n2}s read timeout and ${n1}s write timeout${TAIL}`,
      ],
    ]);
    const r = consolidateLearned(
      pair.map((text) => ({ project: "p", text })),
      { claims: [] },
    );
    assert.equal(r.merged.length, 0, pair[1]);
    assert.equal(r.kept.length, 2, pair[1]);
  }
});

test("property (N03): a look-alike flag on another tool, or a filter on a workspace run, never covers the workspaces", () => {
  const rand = prng(20260929);
  const pick = pickFrom(rand);
  const wrappers = ["", "cross-env CI=1 ", "npx ", "CI=1 ", "env NODE_ENV=test "];
  const tools = ["node", "mocha", "jest", "vitest", "tsx", "c8", "nyc", "ava", "tap"];
  const lookAlikes = ["-r", "--recursive", "-ws", "--workspaces", "-w", "--filter=web", "-F"];
  for (let i = 0; i < 80; i++) {
    const args = shuffle(rand, [pick(lookAlikes), "./setup.cjs", "--test", "test/"]);
    const cmd = `${pick(wrappers)}${pick(tools)} ${args.join(" ")}`;
    assert.equal(recursiveTestInvocation(cmd), null, cmd);
  }
  const RUNS = {
    npm: ["npm test --workspaces", ["-w web", "--workspace=web", "--prefix pkg"]],
    pnpm: ["pnpm -r test", ["--filter web", "-F web", "--resume-from web"]],
    turbo: ["turbo run test", ["--filter=web", "-F web", "--affected", "--dry-run"]],
    lerna: ["lerna run test", ["--scope web", "--ignore web", "--since main"]],
    nx: ["nx run-many -t test", ["-p web", "--projects=web", "--exclude web"]],
  };
  for (let i = 0; i < 80; i++) {
    const [run, filters] = RUNS[pick(Object.keys(RUNS))];
    const words = run.split(" ");
    words.splice(1 + Math.floor(rand() * words.length), 0, pick(filters));
    const wrapped = `${pick(wrappers)}${words.join(" ")}`;
    assert.equal(recursiveTestInvocation(wrapped), null, wrapped);
    assert.ok(recursiveTestInvocation(`${pick(wrappers)}${run}`), `${run} unfiltered is a run`);
  }
  // Q02: the same runs through a program named by a path count only when the path is the
  // root's node_modules/.bin install of a tool a project installs — never by basename — and a
  // PATH override never counts.
  const dirs = [
    "./tools/",
    "tools/",
    "/usr/local/bin/",
    "./node_modules/.bin/",
    "../node_modules/.bin/",
  ];
  const exts = ["", ".js", ".cjs", ".cmd", ".exe"];
  for (let i = 0; i < 80; i++) {
    const [run] = RUNS[pick(Object.keys(RUNS))];
    const [tool, ...rest] = run.split(" ");
    const [dir, ext] = [pick(dirs), pick(exts)];
    const named = `${pick(wrappers)}${dir}${tool}${ext} ${rest.join(" ")}`;
    const installed =
      dir === "./node_modules/.bin/" &&
      ["turbo", "nx", "lerna"].includes(tool) &&
      ["", ".cmd"].includes(ext);
    assert.equal(recursiveTestInvocation(named) !== null, installed, named);
    const overridden = `PATH=${dir.slice(0, -1)}:/usr/bin ${run}`;
    assert.equal(recursiveTestInvocation(overridden), null, overridden);
  }
});

test("property (N08): changing a destructured key, default or nesting changes the contract; a reformat never does", () => {
  const rand = prng(20260930);
  const pick = pickFrom(rand);
  const keys = ["a", "b", "c", "id", "name", "opts", "limit"];
  const lits = ["1", "2", '"x"', '"x y"', "null", "[]"];
  /** A random destructuring pattern, as tokens-with-structure (so it can be mutated). */
  const gen = (depth) =>
    shuffle(rand, keys)
      .slice(0, 1 + Math.floor(rand() * 3))
      .map((k) => {
        const r = rand();
        if (depth > 0 && r < 0.25) return { k, nest: gen(depth - 1) };
        if (r < 0.6) return { k, def: pick(lits) };
        return { k };
      });
  const show = (fields, sp) =>
    `{${sp}${fields
      .map((f) =>
        f.nest ? `${f.k}:${sp}${show(f.nest, sp)}` : f.def ? `${f.k}${sp}=${sp}${f.def}` : f.k,
      )
      .join(`,${sp}`)}${sp}}`;
  /** One semantic mutation: rename a key, change a default, add or drop a field. */
  const mutate = (fields) => {
    const out = structuredClone(fields);
    const f = out[Math.floor(rand() * out.length)];
    const m = pick(["rename", "default", "add", "drop"]);
    if (m === "rename") f.k = `${f.k}2`;
    else if (m === "default") f.def = f.def === "1" ? "2" : "1";
    else if (m === "add") out.push({ k: "extra" });
    else if (out.length > 1) out.splice(out.indexOf(f), 1);
    else f.k = `${f.k}3`;
    return out;
  };
  const root = mkdtempSync(join(tmpdir(), "forge-prop-contract-"));
  const contractOf = (params) => {
    writeFileSync(join(root, "dep.js"), `export function calc(${params}) {\n  return 1;\n}\n`);
    return depContract(root, buildAtlas({ root }), "calc");
  };
  try {
    for (let i = 0; i < 25; i++) {
      const fields = gen(2);
      const base = contractOf(show(fields, ""));
      assert.match(base ?? "", /^v2:/, show(fields, ""));
      const spaced = contractOf(`/* args */ ${show(fields, pick([" ", "  ", "\n    "]))}`);
      assert.equal(spaced, base, `a reformat is not a contract change: ${show(fields, " ")}`);
      let changed = mutate(fields);
      // A mutation must be VISIBLE in the source (a default on a nested field is not rendered).
      while (show(changed, " ") === show(fields, " ")) changed = mutate(fields);
      assert.notEqual(
        contractOf(show(changed, " ")),
        base,
        `${show(fields, " ")} → ${show(changed, " ")}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("property (N06): with no evidence key nothing is authenticated; with one, any edited field unauthenticates", () => {
  const rand = prng(20261001);
  const pick = pickFrom(rand);
  const old = process.env.FORGE_HOME;
  const root = mkdtempSync(join(tmpdir(), "forge-prop-events-"));
  mkdirSync(join(root, ".forge"), { recursive: true });
  const log = join(root, ".forge", "verify-events.jsonl");
  const event = () => ({
    v: VERIFY_EVENT_VERSION,
    runId: `run-${Math.floor(rand() * 1e9)}`,
    status: pick(["PASS", "FAIL", "INCOMPLETE"]),
    suites: [{ label: "npm test", cwd: ".", covers: ["."], status: "PASS", exitCode: 0 }],
    coverage: { required: ["."], basis: { ".": "measured" } },
    pre: { scheme: "manifest-v3", head: "a".repeat(40), dirtyHash: "b".repeat(64) },
    post: { head: "a".repeat(40), dirtyHash: "b".repeat(64) },
    environment: { node: "v22", platform: "linux", arch: "x64", digest: "c".repeat(16) },
  });
  /** Every leaf path of an object. */
  const leaves = (o, at = []) =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" ? leaves(v, [...at, k]) : [[...at, k]],
    );
  try {
    const noKey = join(root, "not-a-dir");
    writeFileSync(noKey, "a regular file: no key can be read or created below it");
    process.env.FORGE_HOME = noKey;
    const unsigned = Array.from({ length: 10 }, event);
    writeFileSync(
      log,
      unsigned.map((e) => JSON.stringify({ ...e, mac: verifyEventMac(e) })).join("\n"),
    );
    assert.ok(readVerifyEvents(root).every((e) => e.authenticated === false));
    process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-prop-key-"));
    for (let i = 0; i < 40; i++) {
      const e = event();
      const signed = { ...e, mac: verifyEventMac(e) };
      writeFileSync(log, JSON.stringify(signed));
      assert.equal(readVerifyEvents(root)[0].authenticated, true);
      const path = pick(leaves(e));
      const edited = structuredClone(signed);
      let o = edited;
      for (const k of path.slice(0, -1)) o = o[k];
      const k = path[path.length - 1];
      o[k] = typeof o[k] === "number" ? o[k] + 1 : `${o[k]}x`;
      writeFileSync(log, JSON.stringify(edited));
      assert.equal(readVerifyEvents(root)[0].authenticated, false, `edited ${path.join(".")}`);
    }
  } finally {
    if (old === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});
