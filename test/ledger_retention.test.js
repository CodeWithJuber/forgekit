// Ledger retention and compaction learned from the ledger's own history (ledger_retention.js).
// The point of these tests is that NOTHING is a fixed threshold: the same code gives
// different cut-offs for ledgers with different rhythms, and refuses to act where the
// data cannot support a decision.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintClaim } from "../src/ledger.js";
import {
  activityDays,
  duplicateGroups,
  learnIdleCutoff,
  retentionPlan,
  similarityBoundary,
} from "../src/ledger_retention.js";
import {
  compactLedger,
  loadClaims,
  loadState,
  pruneLedger,
  putClaim,
  readUses,
  recordUse,
  repoLedger,
  tombstone,
  USAGE_FILE,
} from "../src/ledger_store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-retention-"));
const fact = (name, text, t = 0) =>
  mintClaim({ kind: "fact", body: { name, text }, provenance: { author: "tester" }, t }).claim;

/** A ledger's history: `hot` claims used every `step` days until `end`, `cold` ones used
 *  twice and then abandoned. Scaling `step` scales the whole calendar. */
function rhythm(step, { hot = 8, cold = 8, periods = 30 } = {}) {
  const histories = [];
  for (let i = 0; i < hot; i++)
    histories.push({ days: Array.from({ length: periods }, (_, k) => k * step) });
  for (let i = 0; i < cold; i++) histories.push({ days: [0, step] });
  return { histories, nowDay: periods * step };
}

// ── The idle cut-off ──────────────────────────────────────────────────────────────────

test("learnIdleCutoff: the cut-off follows the ledger's own rhythm (no fixed window)", () => {
  const fast = rhythm(3);
  const slow = rhythm(30);
  const f = learnIdleCutoff(fast.histories, fast.nowDay, { usageSince: 0 });
  const s = learnIdleCutoff(slow.histories, slow.nowDay, { usageSince: 0 });
  assert.equal(f.learned, true, f.reason);
  assert.equal(s.learned, true, s.reason);
  assert.equal(f.cutoff, 3, "cut-off = the longest idle stretch a claim came back from");
  // Every quantity scaled by 10, so the learned cut-off scales by exactly 10.
  assert.equal(s.cutoff, 10 * /** @type {number} */ (f.cutoff));
  assert.equal(s.typicalGap, 10 * /** @type {number} */ (f.typicalGap));
});

test("learnIdleCutoff: a claim with a slower rhythm is never archived while it is due", () => {
  // The flaw a fitted cut-off had: with a 3-day claim in the ledger it learned "idle > 2 ⇒
  // gone" and archived the 10-day claim — which, archived, could never be served again.
  const histories = [
    { days: Array.from({ length: 30 }, (_, k) => k * 3) }, // every 3 days
    { days: Array.from({ length: 9 }, (_, k) => k * 10) }, // every 10 days
    { days: [0, 3] }, // abandoned
  ];
  const r = learnIdleCutoff(histories, 90, { usageSince: 0 });
  assert.equal(r.learned, true);
  assert.equal(r.cutoff, 10, "the slowest comeback sets the cut-off");
});

test("learnIdleCutoff: refuses to act without the data to back it", () => {
  const { histories, nowDay } = rhythm(3);
  assert.match(
    learnIdleCutoff(histories, nowDay, { usageSince: null }).reason ?? "",
    /no usage recorded/,
  );
  const once = histories.map((h) => ({ days: h.days.slice(0, 1) }));
  assert.match(learnIdleCutoff(once, nowDay, { usageSince: 0 }).reason ?? "", /active twice/);
  // The usage log is younger than the longest comeback: it could not yet have seen a reuse
  // after that long, so "not used" would only mean "not recorded".
  const young = learnIdleCutoff(histories, nowDay, { usageSince: nowDay - 1 });
  assert.equal(young.learned, false);
  assert.match(young.reason ?? "", /longest comeback/);
});

test("activityDays: mint, evidence and served days, sorted and unique", () => {
  const c = { id: "x", provenance: { t: 5 }, evidence: [{ t: 9 }, { t: 5 }] };
  assert.deepEqual(activityDays(c, [7, 9, 12]), [5, 7, 9, 12]);
});

// ── The plan ──────────────────────────────────────────────────────────────────────────

test("retentionPlan: archives idle live claims only once a cut-off is learned", () => {
  const { histories, nowDay } = rhythm(3);
  // Claims whose only activity is use (no evidence), ids by index.
  const claims = histories.map((_, i) => ({ id: `c${i}`, kind: "fact", body: { text: `t${i}` } }));
  const uses = new Map(histories.map((h, i) => [`c${i}`, h.days]));
  // `now` is the hot claims' due day (idle = the full 3-day gap): they must stay.
  const plan = retentionPlan(claims, uses, nowDay);
  assert.equal(plan.retention.learned, true);
  const archived = new Set(plan.archive.map((a) => a.id));
  for (let i = 0; i < 8; i++) assert.ok(!archived.has(`c${i}`), `hot claim c${i} is kept`);
  for (let i = 8; i < 16; i++) assert.ok(archived.has(`c${i}`), `abandoned claim c${i} goes`);
  assert.match(plan.archive[0].reason, /learned cut-off/);
  // With no usage log the same claims are all kept.
  assert.equal(retentionPlan(claims, new Map(), nowDay).archive.length, 0);
});

test("retentionPlan: tombstoned claims are never served, so they are archived at once", () => {
  const claims = [
    { id: "a", kind: "fact", body: { text: "a" }, provenance: { t: 99 } },
    { id: "b", kind: "fact", body: { text: "b" }, provenance: { t: 99 }, tombstone: { t: 99 } },
  ];
  const plan = retentionPlan(claims, new Map(), 100);
  assert.deepEqual(
    plan.archive.map((a) => a.id),
    ["b"],
  );
  assert.match(plan.archive[0].reason, /tombstoned/);
});

// ── Duplicates ────────────────────────────────────────────────────────────────────────

test("similarityBoundary: two separated groups give a boundary between them; one group none", () => {
  const two = [0.02, 0.05, 0.03, 0.04, 0.06, 0.01, 0.05, 0.9, 0.95, 0.92];
  const fit = similarityBoundary(two);
  assert.ok(fit.boundary != null && fit.boundary > 0.06 && fit.boundary < 0.9, `${fit.boundary}`);
  assert.equal(similarityBoundary([0.1, 0.12, 0.09, 0.11, 0.1, 0.13, 0.08]).boundary, null);
  assert.equal(similarityBoundary([0.1, 0.9, 0.95]).boundary, null, "too few points to fit two");
  // Exact duplicates (similarity 1) must not make the likelihood infinite.
  const exact = similarityBoundary([0.02, 0.03, 0.01, 0.04, 0.02, 1, 1, 1]);
  assert.ok(Number.isFinite(exact.bic1) && exact.boundary != null && exact.boundary < 1);
});

const TOPICS = [
  "the build uses esbuild with a custom plugin for svg imports",
  "database migrations run in a single transaction per file",
  "the staging deploy needs the vpn to reach the metrics endpoint",
  "feature flags are read once at process start and cached",
  "logging goes through pino and is shipped to loki every minute",
  "image uploads are resized by a lambda before they hit the bucket",
  "the cron worker locks jobs with redis to avoid double runs",
  "api keys rotate every ninety days via the secrets operator",
];

test("duplicateGroups: near-duplicates collapse to one survivor; distinct facts are untouched", () => {
  const dir = tmp();
  const base = "the payments service retries failed webhooks three times with backoff";
  const dupA = fact("wh1", base, 1);
  const dupB = fact("wh2", `${base} and jitter`, 2);
  const dupC = fact("wh3", `in production ${base}`, 3);
  for (const c of [dupA, dupB, dupC, ...TOPICS.map((t, i) => fact(`t${i}`, t, 1))])
    putClaim(dir, c);
  const r = duplicateGroups(loadClaims(dir), 10);
  assert.ok(r.boundary != null, "the similarity distribution has a duplicate mode");
  assert.equal(r.groups.length, 1, JSON.stringify(r.groups));
  const g = r.groups[0];
  assert.deepEqual([g.keep, ...g.drop.map((d) => d.id)].sort(), [dupA.id, dupB.id, dupC.id].sort());
  assert.equal(g.keep, dupA.id, "equal val and evidence: the earliest minted survives");
  for (const d of g.drop) assert.ok(d.similarity >= /** @type {number} */ (r.boundary));
  // A ledger of distinct facts has no duplicate mode at all.
  const clean = tmp();
  for (const [i, t] of TOPICS.entries()) putClaim(clean, fact(`t${i}`, t, 1));
  assert.deepEqual(duplicateGroups(loadClaims(clean), 10).groups, []);
});

test("duplicateGroups: a chain A–B–C drops only what is close to the survivor itself", () => {
  // B contains A's text and C's text; A and C share nothing. Union-find links all three, but
  // C is no duplicate of the survivor A, so only B goes.
  const words = Array.from({ length: 14 }, (_, i) => `w${i}x`);
  const claims = [
    { id: "a", kind: "fact", body: { text: words.slice(0, 8).join(" ") }, provenance: { t: 1 } },
    { id: "b", kind: "fact", body: { text: words.join(" ") }, provenance: { t: 2 } },
    { id: "c", kind: "fact", body: { text: words.slice(6).join(" ") }, provenance: { t: 3 } },
    ...TOPICS.map((t, i) => ({
      id: `t${i}`,
      kind: "fact",
      body: { text: t },
      provenance: { t: 1 },
    })),
  ];
  const r = duplicateGroups(claims, 10);
  assert.ok(r.boundary != null);
  assert.equal(r.groups.length, 1, JSON.stringify(r.groups));
  assert.equal(r.groups[0].keep, "a");
  assert.deepEqual(
    r.groups[0].drop.map((d) => d.id),
    ["b"],
    "c is not a duplicate of a — it stays",
  );
});

test("duplicateGroups: claims of different kinds are never grouped", () => {
  const text = "always run the migrations before seeding the database";
  const claims = [
    { id: "f1", kind: "fact", body: { text } },
    { id: "l1", kind: "lesson", body: { text } },
  ];
  assert.deepEqual(duplicateGroups(claims, 0).groups, []);
});

// ── Store integration ─────────────────────────────────────────────────────────────────

test("recordUse/readUses: a gitignored, append-only local log; never throws", () => {
  const dir = tmp();
  putClaim(dir, fact("a", "alpha fact", 0));
  const [c] = loadClaims(dir);
  const sigBefore = statSync(join(dir, ".state-cache.json")).mtimeMs;
  recordUse(dir, [c.id, c.id, "", 42], { via: "test", t: 7 });
  recordUse(dir, [c.id], { via: "test", t: 9 });
  writeFileSync(join(dir, USAGE_FILE), `${readFileSync(join(dir, USAGE_FILE), "utf8")}{broken\n`);
  assert.deepEqual(readUses(dir).get(c.id), [7, 9], "deduped per call, malformed lines skipped");
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.usage\.jsonl$/m, "gitignored");
  // Logging use does not invalidate the snapshot cache (it is outside the signature).
  loadState(dir);
  assert.equal(statSync(join(dir, ".state-cache.json")).mtimeMs, sigBefore);
  assert.doesNotThrow(() => recordUse(join(dir, "missing"), ["x"]));
  assert.equal(existsSync(join(dir, "missing")), false, "a missing ledger records nothing");
});

test("pruneLedger + compactLedger: learned from the usage log, reversible, dry run writes nothing", () => {
  const root = tmp();
  const dir = repoLedger(root);
  const hot = fact("hot", "the api gateway strips x-forwarded-host", 0);
  const cold = fact("cold", "the old admin panel lived under /legacy", 0);
  const gone = fact("gone", "retracted belief", 0);
  for (const c of [hot, cold, gone]) putClaim(dir, c);
  tombstone(dir, gone.id, { author: "alice", reason: "wrong", t: 1 });
  // Both served early on; only `hot` keeps being served, every 3 days.
  for (let d = 0; d <= 60; d += 3) recordUse(dir, [hot.id], { via: "test", t: d });
  recordUse(dir, [cold.id], { via: "test", t: 3 });
  const dry = compactLedger(dir, 61, { dryRun: true });
  assert.equal(dry.retention.learned, true, dry.retention.reason);
  assert.deepEqual(dry.archive.map((a) => a.id).sort(), [cold.id, gone.id].sort());
  assert.deepEqual(dry.archived, [], "dry run");
  assert.equal(loadClaims(dir).length, 3, "dry run wrote nothing");
  const { pruned } = pruneLedger(dir, 61);
  assert.deepEqual(pruned.sort(), [cold.id, gone.id].sort());
  assert.deepEqual(
    loadClaims(dir).map((c) => c.id),
    [hot.id],
  );
});

test("recordServedLessons: logs ledger-backed lessons, skips legacy ones", async () => {
  const { recordServedLessons } = await import("../src/cortex.js");
  const root = tmp();
  const dir = repoLedger(root);
  putClaim(dir, fact("x", "a fact so the ledger directory exists", 0));
  recordServedLessons(
    root,
    [{ provenance: { claim: "c-ledger" } }, { provenance: {} }, { id: "legacy-only" }],
    { via: "pre-edit", t: 12 },
  );
  const uses = readUses(dir);
  assert.deepEqual([...uses.keys()], ["c-ledger"]);
  assert.deepEqual(uses.get("c-ledger"), [12]);
});
