// Mutation oracle for `forge impact`: which test files really break when a function breaks, and
// how many of them the static graph and the runtime map named beforehand.
//
//   node bench/impact_mutation.mjs <clean checkout> [--k 12] [--seed 20261128]
//
// Run it on a CLEAN copy (a `git worktree add --detach`): it edits one file at a time and puts
// it back. Procedure:
//   1. Record the runtime map of the checkout (forge impact --record, default command).
//   2. Pick K exported functions from src/*.js with a seeded generator.
//   3. For each, insert `throw new Error("forge-mutant")` as the first statement, run the WHOLE
//      test suite (`node --test` over test/*.test.js), and take the test files that fail as
//      the truth. Restore the file.
//   4. Score three predictions of the failing test files: the static graph's transitive
//      reverse walk (test files among impactedFiles), the runtime map (test files that
//      executed the function), and their union.
// A throw at entry fails exactly the tests that execute the function and do not catch the
// error, so the runtime map is close to this oracle by construction; the number the oracle
// adds is how many breaking tests the STATIC graph misses. The runtime map's own blind spot,
// code no test runs, is not measured here.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, impact } from "../src/atlas.js";
import { recordRuntimeMap } from "../src/runtime_map.js";

const args = process.argv.slice(2);
const root = args[0];
const opt = (/** @type {string} */ name, /** @type {number} */ def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const K = opt("--k", 12);
let x = opt("--seed", 20261128);
if (!root) {
  console.error("usage: node bench/impact_mutation.mjs <clean checkout> [--k 12] [--seed N]");
  process.exit(1);
}
const rand = () => {
  x = (x * 1103515245 + 12345) % 2 ** 31;
  return x / 2 ** 31;
};
const tests = readdirSync(join(root, "test"))
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => `test/${f}`);

console.error("recording the runtime map…");
const map = await recordRuntimeMap(root, { tests });
const atlas = build({ root });

/** @type {{file: string, line: number, name: string}[]} */
const candidates = [];
for (const f of readdirSync(join(root, "src")).filter((n) => n.endsWith(".js"))) {
  readFileSync(join(root, "src", f), "utf8")
    .split("\n")
    .forEach((l, line) => {
      const m = /^export function (\w+)\(.*\)\s*\{\s*$/.exec(l);
      if (m) candidates.push({ file: `src/${f}`, line, name: m[1] });
    });
}
const picked = [];
while (picked.length < K && candidates.length)
  picked.push(candidates.splice(Math.floor(rand() * candidates.length), 1)[0]);

const totals = Object.fromEntries(
  ["static", "runtime", "union"].map((k) => [k, { tp: 0, p: 0, t: 0 }]),
);
const rows = [];
for (const m of picked) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  lines.splice(m.line + 1, 0, '  throw new Error("forge-mutant");');
  writeFileSync(path, lines.join("\n"));
  let out = "";
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    out = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", "--import", "./test/_setup.js", ...tests],
      { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, env },
    ).stdout;
  } finally {
    writeFileSync(path, original);
  }
  const truth = new Set(
    [...out.matchAll(/location: '([^']+?\/test\/[^':]+\.test\.js)/g)].map(
      (h) => `test/${h[1].split("/test/").pop()}`,
    ),
  );
  const r = impact(atlas, m.name);
  const predictions = {
    static: new Set((r.impactedFiles ?? []).filter((f) => f.startsWith("test/"))),
    runtime: new Set(
      Object.entries(map.runs)
        .filter(([, ran]) => (ran[m.file] ?? []).includes(m.name))
        .map(([t]) => t),
    ),
  };
  predictions.union = new Set([...predictions.static, ...predictions.runtime]);
  const row = { mutant: `${m.file}:${m.name}`, failing: truth.size };
  for (const [k, pred] of Object.entries(predictions)) {
    const tp = [...pred].filter((t) => truth.has(t)).length;
    totals[k].tp += tp;
    totals[k].p += pred.size;
    totals[k].t += truth.size;
    row[k] = `${tp}/${truth.size} (named ${pred.size})`;
  }
  rows.push(row);
  console.error(`${row.mutant}: ${truth.size} failing`);
}
console.table(rows);
for (const [k, s] of Object.entries(totals))
  console.log(
    `${k.padEnd(8)} recall ${s.t ? (s.tp / s.t).toFixed(2) : "n/a"}  precision ${s.p ? (s.tp / s.p).toFixed(2) : "n/a"}  (${s.tp} of ${s.t} failing test files; ${s.p} named)`,
  );
