import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brainStore, buildIndex, remember } from "../src/brain.js";
import { lessonsForContext, recordMistake, startupBlock, summary } from "../src/cortex.js";
import { mintClaim, outcomeRecord } from "../src/ledger.js";
import { recordLessonEvent, shadowFact } from "../src/ledger_bridge.js";
import {
  claimToLesson,
  ledgerFacts,
  ledgerLessons,
  mergedLessons,
  mergeFactSlugs,
} from "../src/ledger_read.js";
import { mergeDirs, putClaim, repoLedger, tombstone } from "../src/ledger_store.js";
import { newLesson } from "../src/lessons.js";
import { load, save } from "../src/lessons_store.js";
import { add as recallAdd, list as recallList, reindex as recallReindex } from "../src/recall.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-readflip-"));

/** A lesson claim the way ledger_bridge.lessonClaim mints one (body = content only,
 *  legacy id in provenance.task). */
const mkClaim = (over = {}) => {
  const minted = mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: over.correctedBehavior ?? "Check parseCfg callers before editing.",
      trigger: {
        action: "edit",
        files: over.files ?? ["src/cfg.js"],
        keywords: [],
        symbols: over.symbols ?? ["parseCfg"],
      },
      whatWentWrong: over.whatWentWrong ?? "parseCfg was edited without checking callers.",
    },
    scope: { level: over.level ?? "symbol" },
    provenance: {
      agent: "cortex",
      author: over.author ?? "Teammate <t@example.com>",
      task: over.task ?? "lsn_parsecfg",
    },
    t: over.t ?? 0,
  });
  assert.equal(minted.ok, true);
  return minted.claim;
};

const ev = (result, ref, t, oracle = "test.run") => {
  const o = outcomeRecord({ oracle, result, ref, t });
  assert.equal(o.ok, true);
  return o.outcome;
};

// --- claimToLesson: the mapping table, one test per status branch --------------------

test("claimToLesson: fresh claim → candidate at the 0.5 prior, fields from body/provenance", () => {
  const claim = mkClaim({ t: 7 });
  const l = claimToLesson(claim, 7);
  assert.equal(l.id, "lsn_parsecfg", "legacy id rides in provenance.task");
  assert.equal(l.status, "candidate");
  assert.equal(l.scope, "symbol");
  assert.deepEqual(l.trigger.symbols, ["parseCfg"]);
  assert.equal(l.whatWentWrong, "parseCfg was edited without checking callers.");
  assert.equal(l.correctedBehavior, "Check parseCfg callers before editing.");
  assert.deepEqual(
    {
      e: l.evidenceCount,
      c: l.contradictionCount,
      created: l.createdDay,
      last: l.lastConfirmedDay,
    },
    { e: 0, c: 0, created: 7, last: 7 },
  );
  assert.equal(l.provenance.claim, claim.id, "audit pointer back to the ledger");
});

test("claimToLesson: a fresh confirm crosses val ≥ 0.6 → active, lastConfirmedDay = confirm t", () => {
  const claim = mkClaim({ t: 1 });
  claim.evidence = [ev("confirm", "run:1", 5)]; // test.run w=0.8 → val 1.8/2.8 ≈ 0.64
  const l = claimToLesson(claim, 5);
  assert.equal(l.status, "active");
  assert.equal(l.evidenceCount, 1);
  assert.equal(l.lastConfirmedDay, 5);
  assert.equal(l.createdDay, 1);
});

test("claimToLesson: net-negative evidence (val < 0.45, ≥1 contradiction) → quarantined", () => {
  const claim = mkClaim();
  claim.evidence = [ev("contradict", "revert:abc", 2, "human.revert")]; // val 1/3 ≈ 0.33
  const l = claimToLesson(claim, 2);
  assert.equal(l.status, "quarantined");
  assert.equal(l.contradictionCount, 1);
});

test("claimToLesson: an old decayed confirm falls back to candidate, NOT quarantined", () => {
  const claim = mkClaim({ t: 0 });
  claim.evidence = [ev("confirm", "run:0", 0)];
  const l = claimToLesson(claim, 400); // decay pulls val back to ~0.5 (the prior)
  assert.equal(l.status, "candidate", "no contradiction → uncertainty, never quarantine");
});

test("claimToLesson: tombstoned → retired, regardless of evidence", () => {
  const claim = mkClaim();
  claim.evidence = [ev("confirm", "run:1", 1)];
  claim.tombstone = { author: "x", reason: "superseded", t: 2 };
  assert.equal(claimToLesson(claim, 1).status, "retired");
});

test("claimToLesson: no provenance.task → deterministic lsn_<id8> fallback; junk evidence ignored", () => {
  const claim = mkClaim({ task: "" });
  claim.evidence = [
    { oracle: "made.up", result: "confirm", ref: "x", h: "deadbeef", t: 1 }, // unknown oracle
    ev("confirm", "run:1", 1),
  ];
  const l = claimToLesson(claim, 1);
  assert.equal(l.id, `lsn_${claim.id.slice(0, 8)}`);
  assert.equal(l.evidenceCount, 1, "only validOutcome records count");
});

// --- merge / dedupe semantics --------------------------------------------------------

test("mergedLessons: dedupes by legacy id with the legacy FILE winning", () => {
  const root = tmp();
  const legacy = newLesson(
    {
      id: "lsn_parsecfg",
      trigger: { symbols: ["parseCfg"], files: [], keywords: [] },
      scope: "symbol",
      whatWentWrong: "local wording",
      correctedBehavior: "local fix wording",
    },
    1,
  );
  assert.equal(save(root, legacy).ok, true);
  putClaim(repoLedger(root), mkClaim({ task: "lsn_parsecfg" })); // same legacy id, other wording
  putClaim(repoLedger(root), mkClaim({ task: "lsn_other", symbols: ["otherFn"] }));
  const merged = mergedLessons(root, 1);
  assert.deepEqual(
    merged.map((l) => l.id),
    ["lsn_parsecfg", "lsn_other"],
    "legacy first, then ledger-only sorted by id",
  );
  assert.equal(merged[0].correctedBehavior, "local fix wording", "the local file is canonical");
  assert.equal(merged[1].provenance.claim.length, 64, "the extra one came from the ledger");
});

test("mergedLessons: within the ledger, the live claim beats its superseded (tombstoned) twin", () => {
  const root = tmp();
  const dir = repoLedger(root);
  const template = mkClaim({ correctedBehavior: "template wording" });
  const distilled = mkClaim({ correctedBehavior: "distilled wording" });
  putClaim(dir, template);
  putClaim(dir, distilled);
  tombstone(dir, template.id, { author: "t", reason: `superseded-by:${distilled.id}`, t: 2 });
  const merged = mergedLessons(root, 2);
  assert.equal(merged.length, 1, "one legacy id → one lesson");
  assert.equal(merged[0].correctedBehavior, "distilled wording");
});

test("mergedLessons: a corrupt ledger degrades to legacy-only (best-effort, hooks call this)", () => {
  const root = tmp();
  save(
    root,
    newLesson(
      { id: "lsn_x", trigger: { symbols: ["x"] }, whatWentWrong: "w", correctedBehavior: "c" },
      1,
    ),
  );
  mkdirSync(repoLedger(root), { recursive: true });
  writeFileSync(join(repoLedger(root), "claims"), "not a directory"); // readdir throws ENOTDIR
  assert.deepEqual(ledgerLessons(root, 1), []);
  const merged = mergedLessons(root, 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "lsn_x");
});

test("write-loop: a local lesson's own shadow claim is invisible in the merged view", () => {
  const root = tmp();
  const ctx = { symbols: ["computeTax"], files: ["src/tax.ts"], keywords: [] };
  const strong = [{ signal: "S1" }, { signal: "S6" }];
  recordMistake(root, { signals: strong, context: ctx, nowDay: 1, episodeId: "e1" });
  recordMistake(root, { signals: strong, context: ctx, nowDay: 2, episodeId: "e2" }); // → active + shadow claim
  const merged = mergedLessons(root, 2);
  assert.equal(merged.length, 1, "shadow claim (provenance.task = legacy id) deduped away");
  assert.deepEqual(merged[0].provenance.episodes, ["e1", "e2"], "it IS the legacy file");
  assert.equal(summary(root, 2).total, 1);
});

// --- the read flip end-to-end: a teammate's knowledge reaches injection --------------

test("a teammate lesson claim injects after `forge ledger merge` (no local file needed)", () => {
  const local = tmp();
  const mate = tmp();
  // On the teammate's machine: their Stop hook created and later confirmed the lesson —
  // exactly what recordMistake's shadow writes produce.
  const lesson = newLesson(
    {
      id: "lsn_parsecfg",
      trigger: { symbols: ["parseCfg"], files: ["src/cfg.js"], keywords: [] },
      scope: "symbol",
      whatWentWrong: "parseCfg was edited without checking callers.",
      correctedBehavior: "Check parseCfg callers and tests before editing.",
    },
    3,
  );
  assert.equal(recordLessonEvent(mate, lesson, { t: 3 }).ok, true);
  assert.equal(
    recordLessonEvent(mate, lesson, { result: "confirm", ref: "episode:e1#n1", t: 5 }).ok,
    true,
  );

  // Before the merge the local repo knows nothing.
  assert.equal(startupBlock(local, 5), "");
  assert.equal(
    lessonsForContext(local, { symbols: ["parseCfg"] }, { nowDay: 5 }).selected.length,
    0,
  );

  // `forge ledger merge <teammate-checkout>` — the CRDT join.
  const r = mergeDirs(repoLedger(local), repoLedger(mate));
  assert.equal(r.claims, 1);

  // The teammate's lesson now surfaces on every read path, with NO legacy file created.
  const hit = lessonsForContext(local, { symbols: ["parseCfg"] }, { nowDay: 5 });
  assert.equal(hit.selected.length, 1);
  assert.equal(hit.selected[0].id, "lsn_parsecfg");
  assert.match(hit.block, /Check parseCfg callers and tests before editing\./);
  assert.match(startupBlock(local, 5), /lsn_parsecfg/);
  assert.equal(summary(local, 5).active, 1);
  assert.equal(load(local).length, 0, "the read flip does NOT materialize legacy files");
});

// --- facts: recall + brain merged reads ----------------------------------------------

test("ledgerFacts: live fact claims only (tombstoned/superseded values are skipped)", () => {
  const dir = join(tmp(), "ledger");
  shadowFact(dir, "api-base", "https://old.example", 1);
  shadowFact(dir, "api-base", "https://new.example", 2); // supersedes → tombstones the old
  const facts = ledgerFacts(dir);
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0], { slug: "api-base", name: "api-base", text: "https://new.example" });
  assert.deepEqual(ledgerFacts(join(dir, "nope")), [], "missing ledger → []");
});

test("recall.list merges ledger facts; a file wins on slug collision; MEMORY.md keeps its format", () => {
  const store = tmp();
  recallAdd(store, "db port", "5433 here, not 5432");
  shadowFact(join(store, "ledger"), "Team Endpoint", "staging lives at stg.example.com", 1);
  shadowFact(join(store, "ledger"), "db port", "ledger value must NOT shadow the file", 1);
  assert.deepEqual(recallList(store), ["db-port", "team-endpoint"], "merged, deduped, sorted");
  recallReindex(store);
  const memory = readFileSync(join(store, "MEMORY.md"), "utf8");
  assert.match(memory, /^# Durable memory index\n\n- db-port\n- team-endpoint\n$/);
});

test("mergeFactSlugs is deterministic and file-first", () => {
  const dir = join(tmp(), "ledger");
  shadowFact(dir, "beta", "b", 1);
  shadowFact(dir, "alpha", "a", 1);
  assert.deepEqual(mergeFactSlugs(["zeta", "alpha"], dir), ["alpha", "beta", "zeta"]);
});

test("brain.buildIndex inlines repo-ledger facts (merged team memory reaches AGENTS.md)", () => {
  const root = tmp();
  const store = brainStore(root);
  remember(store, "deploy order", "run migrations before the app roll");
  // A teammate's fact arriving via `forge ledger merge` into the REPO ledger:
  shadowFact(repoLedger(root), "flaky suite", "retry integration tests once before failing", 1);
  const idx = buildIndex(store);
  assert.equal(idx.indexed, 2);
  const block = readFileSync(join(store, "AGENTS.brain.md"), "utf8");
  assert.match(block, /- \*\*deploy-order\*\* — run migrations before the app roll/);
  assert.match(block, /- \*\*flaky-suite\*\* — retry integration tests once before failing/);
});
