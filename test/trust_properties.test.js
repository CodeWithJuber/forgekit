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
import { evidenceEvents, outcomeRecord, val } from "../src/ledger.js";
import { repoLedger } from "../src/ledger_store.js";
import { describeFile, mintArtifact, reusePeek } from "../src/reuse.js";
import { choose, parseObjective } from "../src/router/policy.js";
import { semanticConflicts } from "../src/semantic_guard.js";
import { computeCodeState } from "../src/verify.js";

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
    assert.ok(r.maxPossibleCost >= r.cost - 1e-12, "the worst case bounds the expectation");
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
