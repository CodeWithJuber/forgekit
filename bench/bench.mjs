// forge bench — deterministic micro/meso benchmarks for the substrate primitives.
// Discipline (docs/plans/substrate-v2/05-cost-model.md, whitepaper C6): a number is an
// assumption until measured. Everything here is MEASURED on the machine that runs it —
// median of N timed runs after warmup, environment recorded next to every table, no
// projections, no blending with the paper's prototype numbers.
//
// Node stdlib only. Run: `npm run bench`. Output: a table on stdout AND the measured
// section of reports/benchmarks.md (between the BENCH:RESULTS markers — the prose
// around it is hand-written and not touched by this script).
//
// What is benchmarked on what:
//  - atlas/context/substrate run against a COPY of this repo in os.tmpdir (bench/
//    excluded so the harness's own imports don't perturb the impact-quality eval;
//    .forge excluded so the copy starts cold). The copy is deleted afterwards.
//  - ledger/reuse run against synthetic fixtures generated with a seeded PRNG
//    (mulberry32) — deterministic across runs and machines, built in os.tmpdir,
//    cleaned up.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as buildAtlas, impact } from "../src/atlas.js";
import { assemble } from "../src/context.js";
import { evalImpact } from "../src/eval.js";
import { mintClaim, outcomeRecord, val } from "../src/ledger.js";
import { appendEvidence, loadClaims, mergeDirs, putClaim } from "../src/ledger_store.js";
import { artifactClaim, fingerprint, lookup } from "../src/reuse.js";
import { substrateCheck } from "../src/substrate.js";
import { IMPACT_CASES } from "./impact_cases.mjs";

// ---------------------------------------------------------------------------
// Pure helpers (exported for the smoke test — no benchmark runs on import).
// ---------------------------------------------------------------------------

/** Median of a sample list (even n → mean of the middle two). */
export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank p95 (with n < 20 this is simply the max — say so, don't smooth). */
export function p95(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/** ms with sensible precision: 0.042 ms / 1.3 ms / 412 ms / 1503 ms. */
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 0.1) return `${ms.toFixed(3)} ms`;
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

/** Integer rate with thousands separators: 12,340/s. */
export function fmtRate(perSec) {
  if (!Number.isFinite(perSec)) return "n/a";
  return `${Math.round(perSec).toLocaleString("en-US")}/s`;
}

/** Plain monospace table (also valid Markdown when `markdown` is set). */
export function formatTable(headers, rows, { markdown = false } = {}) {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const line = (r, pad = " ") =>
    `|${r.map((cell, c) => ` ${(cell ?? "").padEnd(widths[c], pad)} `).join("|")}|`;
  const sep = markdown
    ? `|${widths.map((w) => `${"-".repeat(w + 2)}`).join("|")}|`
    : line(
        headers.map(() => ""),
        "-",
      );
  return [line(headers), sep, ...rows.map((r) => line(r.map(String)))].join("\n");
}

/** Time fn: `warmup` unmeasured runs, then `runs` measured ones. Returns samples +
 *  stats. fn receives a counter that NEVER repeats across warmup and measured runs,
 *  so fixtures keyed by it (fresh directories) can't collide — a measured run must
 *  never silently hit a warmup run's already-written state. */
export function timeIt(fn, { runs = 5, warmup = 1 } = {}) {
  let k = 0;
  for (let i = 0; i < warmup; i++) fn(k++);
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn(k++);
    samples.push(performance.now() - t0);
  }
  return { samples, median: median(samples), p95: p95(samples), runs, warmup };
}

// Deterministic PRNG — fixture generation must be identical on every run/machine.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB =
  `add remove update handle parse render validate merge sort filter cache load store fetch
   compute batch stream retry queue flush index search rank group split join trim wrap
   pagination cursor listing endpoint request response payload schema record entry field
   column widget layout panel button badge banner report summary metric signal window`
    .split(/\s+/)
    .filter(Boolean);

/** Deterministic prose-like spec of `len` tokens (no idents/paths/numbers, no secrets). */
export function makeSpec(rand, len = 40) {
  const words = [];
  for (let i = 0; i < len; i++) words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
  return words.join(" ");
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const SKIP_COPY = new Set(["node_modules", "bench"]);

function copyRepo() {
  const dst = mkdtempSync(join(tmpdir(), "forge-bench-repo-"));
  cpSync(REPO_ROOT, dst, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return !(SKIP_COPY.has(name) || (name.startsWith(".") && src !== REPO_ROOT));
    },
  });
  return dst;
}

function fillLedger(dir, { count, offset = 0, evidenceEvery = 4 }) {
  for (let i = 0; i < count; i++) {
    const n = offset + i;
    const minted = mintClaim({
      kind: "fact",
      body: { name: `bench-fact-${n}`, text: `deterministic bench fact number ${n}` },
      scope: { level: "repo" },
      provenance: { agent: "bench", author: "bench" },
      t: 0,
    });
    if (!minted.ok) throw new Error(minted.reason);
    putClaim(dir, minted.claim);
    if (n % evidenceEvery === 0) {
      const o = outcomeRecord({
        oracle: "test.run",
        result: "confirm",
        ref: `bench:run:${n}`,
        author: "bench",
        t: 0,
      });
      if (o.ok) appendEvidence(dir, minted.claim.id, o.outcome);
    }
  }
}

/**
 * A real git object to cite as evidence: a throwaway one-commit repo, and its full commit id,
 * checked to resolve (`git cat-file -e`) — the same resolution appendEvidence performs. The
 * old fixture cited `bench:artifact:<i>`, an untyped ref that val() caps below SERVE_FLOOR, so
 * every "exact"/"near" row actually measured a MISS (review F14).
 * @returns {{dir: string, oid: string}}
 */
export function resolvedEvidenceRepo() {
  const dir = mkdtempSync(join(tmpdir(), "forge-bench-git-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g("init");
  g("config", "user.email", "bench@example.invalid");
  g("config", "user.name", "bench");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "fixture.txt"), "reuse bench fixture\n");
  g("add", "-A");
  g("commit", "-m", "bench fixture");
  const oid = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  g("cat-file", "-e", oid); // throws if it does not resolve
  return { dir, oid };
}

/** n in-memory artifact claims, each with one RESOLVED test.run confirm (a `git:` object id)
 *  so it genuinely clears SERVE_FLOOR. `ref` overrides the evidence ref — a stale/unresolved
 *  fixture for the validation self-test. */
export function makeArtifacts(n, { ref }) {
  const rand = mulberry32(42);
  const claims = [];
  const specs = [];
  for (let i = 0; i < n; i++) {
    const spec = makeSpec(rand, 40);
    specs.push(spec);
    const minted = artifactClaim(
      { spec, code: { inline: `// artifact ${i}` }, iface: [`benchExport${i}`], deps: [] },
      0,
    );
    if (!minted.ok) throw new Error(minted.reason);
    const o = outcomeRecord({ oracle: "test.run", result: "confirm", ref, author: "bench", t: 0 });
    if (!o.ok) throw new Error(`bench evidence rejected: ${o.reason}`);
    minted.claim.evidence = [o.outcome];
    claims.push(minted.claim);
  }
  return { claims, specs };
}

/** Strip EVERY memoized sketch the lookup path caches — ledger.js's claim-text `_sketch`/
 *  `_terms` and reuse.js's `_specSketch`/`_keySketch` — so a "cold" row behaves like a fresh
 *  process. (It used to delete `_sketch` only, which reuse never reads.) */
export const coldSketches = (claims) => {
  for (const c of claims) {
    delete c._sketch;
    delete c._terms;
    delete c._specSketch;
    delete c._keySketch;
  }
};

/**
 * A row is only labeled with a tier it actually exercised: run the lookup once, untimed, and
 * abort the benchmark unless the expected tier comes back (review F14).
 * @param {any[]} claims
 * @param {string} spec
 * @param {"exact"|"near"|"adapt"|"miss"} tier
 */
export function expectTier(claims, spec, tier) {
  coldSketches(claims);
  const r = lookup(claims, spec);
  if (r.tier !== tier)
    throw new Error(
      `bench fixture invalid: expected a ${tier} lookup, got ${r.tier}${r.reasons?.length ? ` (${r.reasons.slice(0, 2).join("; ")})` : ""}`,
    );
  return r;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function environment() {
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
    // Numbers measured on an uncommitted tree are not the numbers OF that commit — say so.
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT })
      .toString()
      .trim();
    if (dirty) commit += " + uncommitted changes";
  } catch {}
  // The filesystem the tmpdir fixtures live on changes the disk-bound rows (A06).
  let fsType = "unknown";
  try {
    if (platform() === "linux")
      fsType = execFileSync("stat", ["-f", "-c", "%T", tmpdir()], { encoding: "utf8" }).trim();
  } catch {}
  return {
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    platform: platform(),
    arch: arch(),
    fsType,
    commit,
    date: new Date().toISOString(),
  };
}

function runBenchmarks() {
  process.env.FORGE_AUTHOR = "bench"; // no git subprocess variance inside timed loops
  const cleanup = [];
  const rows = []; // [suite, benchmark, median, p95, runs, notes]
  const push = (suite, name, t, notes = "") =>
    rows.push([suite, name, fmtMs(t.median), fmtMs(t.p95), `${t.runs}`, notes]);

  try {
    // --- atlas: build / incremental / impact query, on a copy of this repo ---------
    const repo = copyRepo();
    cleanup.push(repo);
    let atlas = null;
    const tFull = timeIt(
      () => {
        rmSync(join(repo, ".forge"), { recursive: true, force: true });
        atlas = buildAtlas({ root: repo });
      },
      { runs: 5, warmup: 1 },
    );
    push(
      "atlas",
      "full build (this repo)",
      tFull,
      `${atlas.files} files, ${atlas.symbols.length} symbols, ${atlas.edges.length} edges${atlas.capped ? `, CAPPED at ${atlas.cap} files` : `, cap ${atlas.cap ?? "none"} not reached`}`,
    );
    const tIncr = timeIt(
      () => {
        atlas = buildAtlas({ root: repo });
      },
      { runs: 5, warmup: 1 },
    );
    push("atlas", "incremental rebuild (unchanged)", tIncr, "per-file hash cache hit");
    const target = "claimText";
    let impactResult = impact(atlas, target); // warms the memoized adjacency index
    const tImpact = timeIt(
      () => {
        impactResult = impact(atlas, target);
      },
      { runs: 30, warmup: 3 },
    );
    push(
      "atlas",
      `impact("${target}") (warm adjacency)`,
      tImpact,
      `${impactResult.impactedFiles.length} files impacted`,
    );

    // --- impact-oracle quality on the committed labeled cases ----------------------
    const quality = evalImpact(atlas, IMPACT_CASES);

    // --- ledger: mint+put, loadClaims, mergeDirs, val -------------------------------
    const ledgerScratch = mkdtempSync(join(tmpdir(), "forge-bench-ledger-"));
    cleanup.push(ledgerScratch);
    const N_CLAIMS = 1000;
    let mintDir = "";
    const tMint = timeIt(
      (i) => {
        mintDir = join(ledgerScratch, `mint-${i}`);
        fillLedger(mintDir, { count: N_CLAIMS });
      },
      { runs: 5, warmup: 1 }, // disk-bound: 5 runs, median damps fs-cache noise
    );
    push("ledger", `mint+put ${N_CLAIMS} claims`, tMint, fmtRate(N_CLAIMS / (tMint.median / 1000)));
    let claims1k = [];
    const tLoad = timeIt(
      () => {
        claims1k = loadClaims(mintDir);
      },
      { runs: 5, warmup: 1 },
    );
    push("ledger", `loadClaims at ${claims1k.length} claims`, tLoad, "full state from disk");
    const srcA = join(ledgerScratch, "replica-a");
    const srcB = join(ledgerScratch, "replica-b");
    fillLedger(srcA, { count: 500, offset: 0 });
    fillLedger(srcB, { count: 500, offset: 250 }); // 250 shared, 250 new each side
    const MERGE_RUNS = { runs: 3, warmup: 1 };
    for (let k = 0; k < MERGE_RUNS.runs + MERGE_RUNS.warmup; k++)
      cpSync(srcA, join(ledgerScratch, `merge-${k}`), { recursive: true }); // setup, untimed
    let mergeStats = { claims: 0, records: 0 };
    const tMerge = timeIt((k) => {
      mergeStats = mergeDirs(join(ledgerScratch, `merge-${k}`), srcB);
    }, MERGE_RUNS);
    push(
      "ledger",
      "mergeDirs 2×500-claim replicas (250 shared)",
      tMerge,
      `+${mergeStats.claims} claims, +${mergeStats.records} records`,
    );
    let valSum = 0;
    const tVal = timeIt(
      () => {
        valSum = 0;
        for (const c of claims1k) valSum += val(c, 30);
      },
      { runs: 20, warmup: 2 },
    );
    push(
      "ledger",
      `val() over ${claims1k.length} claims`,
      tVal,
      `${fmtRate(claims1k.length / (tVal.median / 1000))} (mean val ${(valSum / claims1k.length).toFixed(2)})`,
    );

    // --- reuse: fingerprint throughput, lookup at 100 and 1000 artifacts -----------
    const rand = mulberry32(7);
    const fpSpecs = Array.from({ length: 2000 }, () => makeSpec(rand, 40));
    const tFp = timeIt(
      () => {
        for (const s of fpSpecs) fingerprint(s);
      },
      { runs: 5, warmup: 1 },
    );
    push(
      "reuse",
      `fingerprint ${fpSpecs.length} specs`,
      tFp,
      fmtRate(fpSpecs.length / (tFp.median / 1000)),
    );
    const evidence = resolvedEvidenceRepo();
    cleanup.push(evidence.dir);
    for (const n of [100, 1000]) {
      const { claims, specs } = makeArtifacts(n, { ref: `git:${evidence.oid}` });
      const exactQ = specs[n >> 1];
      const nearQ = `${specs[n >> 1]} gently`; // superset tokens → Jaccard ≈ 0.97 → near tier
      const missQ = "configure the blue ocean lighthouse keeper rotation schedule";
      // Validate BEFORE timing: each row must exercise the tier it is labeled with.
      expectTier(claims, exactQ, "exact");
      expectTier(claims, nearQ, "near");
      expectTier(claims, missQ, "miss");
      let hit = null;
      const tExact = timeIt(
        () => {
          coldSketches(claims); // fresh-process behavior: no memoized sketches
          hit = lookup(claims, exactQ);
        },
        { runs: 10, warmup: 2 },
      );
      push("reuse", `lookup exact hit, cold @ ${n} artifacts`, tExact, `tier=${hit.tier}`);
      const tExactWarm = timeIt(
        () => {
          hit = lookup(claims, exactQ); // memoized sketches kept: a long-lived process
        },
        { runs: 10, warmup: 2 },
      );
      push("reuse", `lookup exact hit, warm @ ${n} artifacts`, tExactWarm, `tier=${hit.tier}`);
      const tNear = timeIt(
        () => {
          coldSketches(claims);
          hit = lookup(claims, nearQ);
        },
        { runs: 5, warmup: 1 },
      );
      push(
        "reuse",
        `lookup near hit (LSH), cold @ ${n} artifacts`,
        tNear,
        `tier=${hit.tier}, j=${hit.jaccard?.toFixed(2) ?? "-"}`,
      );
      const tMiss = timeIt(
        () => {
          coldSketches(claims);
          hit = lookup(claims, missQ);
        },
        { runs: 5, warmup: 1 },
      );
      push("reuse", `lookup miss, cold @ ${n} artifacts`, tMiss, `tier=${hit.tier}`);
    }

    // --- context: assemble() on this repo for a representative task ----------------
    const task =
      "add a keywords field to `mintClaim` in src/ledger.js and update `claimText` and `val`";
    let ctx = null;
    const tCtx = timeIt(
      () => {
        ctx = assemble(repo, task, { atlas });
      },
      { runs: 10, warmup: 2 },
    );
    push(
      "context",
      "assemble() (this repo, 3-symbol task)",
      tCtx,
      `${ctx.tokens}/${ctx.budget} tokens, ${ctx.required.length} required, ${ctx.ok ? "complete" : "incomplete"}`,
    );

    // --- substrate: full substrateCheck wall time -----------------------------------
    let sub = null;
    const tSub = timeIt(
      () => {
        sub = substrateCheck(repo, task, { allowBuild: true, llm: false });
      },
      { runs: 3, warmup: 1 },
    );
    push(
      "substrate",
      "substrateCheck (allowBuild, llm off)",
      tSub,
      `${sub.impact?.impactedFiles?.length ?? 0} impacted files, route ${sub.route?.tier ?? "?"}`,
    );

    return { rows, quality };
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const RESULT_HEADERS = ["suite", "benchmark", "median", "p95", "runs", "notes"];
const QUALITY_HEADERS = ["case (target)", "precision", "recall", "F1", "predicted", "truth"];
const SERIES_HEADERS = ["series", "precision", "recall", "F1", "ground truth"];

/** Paper prototype vs this repo — different methodologies, side by side and labeled,
 *  NEVER averaged or blended. The two paper rows are constants, not something this harness
 *  ran: the self-built demo (whitepaper Figure 5 / deliverable-package.md), which the
 *  pre-registered field study REFUTED, and that field study's own result on real co-change
 *  data (research/empirical-refutation; recomputed by the 2026-09-26 external review). The
 *  regex atlas measured below is a different (Node) graph — not the evaluated Python oracle. */
export function seriesRows(quality) {
  return [
    [
      "paper prototype, self-built demo (REFUTED)",
      "0.63",
      "1.00",
      "0.75",
      "mutation testing on the authors' own fixture",
    ],
    [
      "paper prototype, field study (pooled, 9 repos)",
      "0.40",
      "0.02",
      "0.04",
      "759 files' mined co-change (research/empirical-refutation)",
    ],
    [
      "this repo (regex atlas, hand-labeled)",
      quality.oracle.precision.toFixed(2),
      quality.oracle.recall.toFixed(2),
      quality.oracle.f1.toFixed(2),
      `${quality.n} hand-labeled cases (bench/impact_cases.mjs)`,
    ],
  ];
}

export function qualityRows(quality) {
  const rows = quality.perCase.map((p) => [
    p.target,
    p.oracle.precision.toFixed(2),
    p.oracle.recall.toFixed(2),
    p.oracle.f1.toFixed(2),
    `${p.oracle.predicted}`,
    `${p.oracle.groundTruth}`,
  ]);
  rows.push([
    `mean of ${quality.n}`,
    quality.oracle.precision.toFixed(2),
    quality.oracle.recall.toFixed(2),
    quality.oracle.f1.toFixed(2),
    "",
    "",
  ]);
  return rows;
}

const BEGIN = "<!-- BENCH:RESULTS:BEGIN (generated by bench/bench.mjs — do not edit) -->";
const END = "<!-- BENCH:RESULTS:END -->";

function resultsMarkdown(env, rows, quality) {
  const q = qualityRows(quality);
  return [
    BEGIN,
    "",
    "### Environment (machine section)",
    "",
    "```json",
    JSON.stringify(env, null, 2),
    "```",
    "",
    "### Measured results",
    "",
    formatTable(RESULT_HEADERS, rows, { markdown: true }),
    "",
    "### Impact-oracle quality (hand-labeled cases, this repo)",
    "",
    formatTable(QUALITY_HEADERS, q, { markdown: true }),
    "",
    `Edited-file-only baseline recall over the same cases: **${quality.baseline.recall.toFixed(2)}**.`,
    "",
    "Different methodologies, side by side — different codebases, different ground-truth",
    "derivations, so the rows are comparable in spirit only and are never blended:",
    "",
    formatTable(SERIES_HEADERS, seriesRows(quality), { markdown: true }),
    "",
    END,
  ].join("\n");
}

function writeReport(env, rows, quality) {
  const path = join(REPO_ROOT, "reports", "benchmarks.md");
  const section = resultsMarkdown(env, rows, quality);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = `# Benchmarks\n\n${BEGIN}\n${END}\n`;
  }
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  text =
    begin !== -1 && end !== -1
      ? text.slice(0, begin) + section + text.slice(end + END.length)
      : `${text.trimEnd()}\n\n${section}\n`;
  writeFileSync(path, text);
  return path;
}

function main() {
  const env = environment();
  const t0 = performance.now();
  const { rows, quality } = runBenchmarks();
  const total = performance.now() - t0;
  process.stdout.write(
    `forge bench — median of N runs after warmup (node ${env.node}, ${env.cpu})\n\n`,
  );
  process.stdout.write(`${formatTable(RESULT_HEADERS, rows)}\n\n`);
  process.stdout.write("impact-oracle quality (hand-labeled cases, this repo):\n\n");
  process.stdout.write(`${formatTable(QUALITY_HEADERS, qualityRows(quality))}\n\n`);
  process.stdout.write("vs the paper prototype (different methodology — never blended):\n\n");
  process.stdout.write(`${formatTable(SERIES_HEADERS, seriesRows(quality))}\n\n`);
  const path = writeReport(env, rows, quality);
  process.stdout.write(`wrote ${path} (total bench time ${fmtMs(total)})\n`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
