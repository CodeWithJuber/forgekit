// Jev memory layers (src/jev_memory.js) and their wiring into context, deja, the ledger
// prune and remember. No network: every Jev answer comes from an injected transport, and the
// API key is set in-file (per the hermetic convention — each test file is its own process,
// so this assignment runs after _setup's scrub).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.TYPESAFE_API_KEY = "tsk-test-only";

import { assemble } from "../src/context.js";
import { dejaAdvisory, recordSessionSummary } from "../src/deja.js";
import {
  admitWorking,
  chooseReplay,
  clip,
  confidenceOf,
  confident,
  JEV_BATCH,
  JEV_MEMORY_LAYERS,
  jevMemoryLayers,
  jevMemoryStatus,
  judgeForgetting,
  readJournal,
  rememberVerified,
  summarizeJournal,
  verifyFact,
} from "../src/jev_memory.js";
import { storeFact } from "../src/knowledge_router.js";
import { mintClaim, outcomeRecord } from "../src/ledger.js";
import {
  appendEvidence,
  archiveRecord,
  loadClaims,
  pruneLedger,
  putClaim,
  readUses,
  repoLedger,
} from "../src/ledger_store.js";
import { hasSecret } from "../src/secrets.js";
import { fakeGithubPat } from "./_fixtures.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-jev-memory-"));

/** A Jev stand-in: answers every question with pick(key, question, payload) and records
 *  each payload it was sent. */
function fakeJev(pick) {
  /** @type {any[]} */
  const calls = [];
  const call = (payload) => {
    calls.push(payload);
    return {
      model: "jev-1.14.0",
      answers: Object.fromEntries(
        Object.entries(payload.questions).map(([k, q]) => [k, pick(k, q, payload)]),
      ),
      usage: { input_tokens: 321 },
    };
  };
  return Object.assign(call, { calls });
}
const noulOf = (p) => ({ type: "noul", noul: p });
const choiceOf = (pick, confidence) => ({
  type: "choice",
  choice: pick,
  confidence,
  probabilities: { [pick]: confidence },
});

/** Mint a claim into a fixture's repo ledger (optionally with `confirm` test.run outcomes). */
function put(root, kind, body, { t = 100, confirm = 0 } = {}) {
  const m = mintClaim({ kind, body, scope: { level: "repo" }, provenance: { agent: "test" }, t });
  assert.ok(m.ok, "mint");
  const claim = /** @type {any} */ (m).claim;
  putClaim(repoLedger(root), claim);
  for (let i = 0; i < confirm; i++) {
    const o = outcomeRecord({
      oracle: "test.run",
      result: "confirm",
      ref: `session:s${t}-${i}`,
      author: "test",
      t: t + i,
    });
    assert.ok(o.ok);
    appendEvidence(repoLedger(root), claim.id, /** @type {any} */ (o).outcome);
  }
  return claim;
}

// ── shared pieces ─────────────────────────────────────────────────────────────────────

test("FORGE_JEV_MEMORY: unset or 1 → all five layers, 0 → none, a list → those only", () => {
  assert.deepEqual([...jevMemoryLayers({})], [...JEV_MEMORY_LAYERS]);
  assert.deepEqual([...jevMemoryLayers({ FORGE_JEV_MEMORY: "1" })], [...JEV_MEMORY_LAYERS]);
  assert.equal(jevMemoryLayers({ FORGE_JEV_MEMORY: "0" }).size, 0);
  assert.deepEqual(
    [...jevMemoryLayers({ FORGE_JEV_MEMORY: "working, Forgetting,bogus" })],
    ["working", "forgetting"],
  );
});

test("jevMemoryStatus: needs the key AND the decisions opt-in, and says which is missing", () => {
  const root = fixture();
  assert.equal(jevMemoryStatus(root, { llm: true }).enabled, true);
  const off = jevMemoryStatus(root);
  assert.equal(off.enabled, false, "FORGE_LLM is scrubbed in tests — decisions default off");
  assert.match(off.reason, /decisions are off/);
  const only = jevMemoryStatus(root, { llm: true, env: { FORGE_JEV_MEMORY: "episodic" } });
  assert.deepEqual(
    Object.entries(only.layers)
      .filter(([, on]) => on)
      .map(([l]) => l),
    ["episodic"],
  );
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const noKey = jevMemoryStatus(root, { llm: true });
    assert.equal(noKey.enabled, false);
    assert.match(noKey.reason, /TYPESAFE_API_KEY/);
  } finally {
    process.env.TYPESAFE_API_KEY = key;
  }
});

test("confident(): only p ≥ 0.8 or ≤ 0.2 is a verdict; anything else is the rubric's", () => {
  assert.equal(confident(0.85), true);
  assert.equal(confident(0.1), false);
  assert.equal(confident(0.5), null);
  assert.equal(confident(0.79), null);
  assert.equal(confident(Number.NaN), null);
  assert.equal(confident(undefined), null);
  assert.equal(confidenceOf({ choice: "a", probabilities: { a: 0.7 } }), 0.7);
  assert.equal(confidenceOf({ choice: "a", confidence: 0.9, probabilities: { a: 0.7 } }), 0.9);
});

test("clip: secrets are redacted before anything is sent, text collapsed and capped", () => {
  const out = clip(`use token ${fakeGithubPat()}   for   the\nmirror`, 60);
  assert.equal(hasSecret(out), false);
  assert.ok(!out.includes("\n"));
  assert.ok(out.length <= 60);
});

// ── layer 1: working ──────────────────────────────────────────────────────────────────

test("admitWorking: off → null and Jev is never asked", () => {
  const call = fakeJev(() => noulOf(0.9));
  assert.equal(
    admitWorking("task", [{ id: "a", text: "x" }], { root: fixture(), llm: false, call }),
    null,
  );
  assert.equal(call.calls.length, 0);
});

test("admitWorking: one noul per item in ONE call, capped at the batch, journaled", () => {
  const root = fixture();
  const items = Array.from({ length: JEV_BATCH + 12 }, (_, i) => ({
    id: `c${i}`,
    text: `item ${i}`,
  }));
  const call = fakeJev((k) => noulOf(k === "m0" ? 0.2 : 0.9));
  const r = admitWorking("fix the login test", items, { root, llm: true, call });
  assert.equal(call.calls.length, 1);
  assert.equal(Object.keys(call.calls[0].questions).length, JEV_BATCH);
  assert.equal(call.calls[0].questions.m0.type, "noul");
  assert.match(call.calls[0].questions.m0.instructions, /untrusted/);
  assert.equal(r?.p.get("c0"), 0.2);
  assert.equal(r?.p.get("c1"), 0.9);
  assert.equal(r?.p.has(`c${JEV_BATCH}`), false, "past the batch: not asked");
  const [rec] = readJournal(root);
  assert.equal(rec.layer, "working");
  assert.equal(rec.ok, true);
  assert.equal(rec.billedIn, 321);
  assert.equal(rec.decisions.find((d) => d.id === "c0").action, "drop");
});

test("admitWorking: a secret inside one item is redacted, so the batch still goes out", () => {
  const call = fakeJev(() => noulOf(0.9));
  const r = admitWorking(
    "wire the mirror",
    [
      { id: "safe", text: "mirror config lives in .forge/sources.json" },
      { id: "leaky", text: `the token is ${fakeGithubPat()}` },
    ],
    { root: fixture(), llm: true, call },
  );
  assert.equal(call.calls.length, 1, "systemOne refuses a batch that carries a secret");
  assert.equal(hasSecret(JSON.stringify(call.calls[0])), false);
  assert.equal(r?.p.size, 2);
});

test("admitWorking: a garbled answer is no answer — null, and the failure is journaled", () => {
  const root = fixture();
  const call = fakeJev(() => ({ type: "choice", choice: "nope" }));
  assert.equal(admitWorking("t", [{ id: "a", text: "x" }], { root, llm: true, call }), null);
  assert.equal(readJournal(root)[0].ok, false);
});

test("assemble: Jev off → exactly the rubric's result (no memory block, no extra items)", () => {
  const root = fixture();
  put(root, "fact", { name: "login-flow", text: "the login flow posts to /api/session" });
  put(root, "summary", { text: "fixed the login redirect loop", files: ["src/login.js"] });
  const task = "improve the login flow redirect";
  const base = assemble(root, task, { nowDay: 120 });
  const call = fakeJev(() => noulOf(0.99));
  const off = assemble(root, task, { nowDay: 120, llm: false, jevCall: call });
  assert.deepEqual(off, base);
  assert.equal(call.calls.length, 0);
  assert.equal("memory" in base, false);
});

test("assemble: Jev on → admits what it judged needed, drops the rest, measures full vs admitted", () => {
  const root = fixture();
  const fact = put(root, "fact", {
    name: "login-flow",
    text: "the login flow posts to /api/session",
  });
  const summary = put(root, "summary", {
    text: "fixed the login redirect loop",
    files: ["src/login.js"],
  });
  const decision = put(root, "decision", { text: "chose argon2 for password hashing" });
  const task = "improve the login flow redirect";
  const call = fakeJev((k, _q, payload) => {
    const text = payload.state.memory[k];
    return noulOf(text.includes("redirect loop") ? 0.93 : 0.05);
  });
  const r = assemble(root, task, { nowDay: 120, llm: true, jevCall: call });
  const ids = r.selection.map((s) => s.id);
  assert.ok(ids.includes(`summary:${summary.id.slice(0, 8)}`), "a widened kind Jev admitted");
  assert.ok(!ids.includes(`fact:${fact.id.slice(0, 8)}`), "a rubric fact Jev dropped");
  assert.ok(!ids.includes(`decision:${decision.id.slice(0, 8)}`));
  assert.equal(r.memory.jev.asked, 3);
  assert.equal(r.memory.jev.admitted, 1);
  assert.equal(r.memory.jev.dropped, 2);
  assert.equal(r.memory.memoryClaims, 3);
  assert.ok(r.memory.fullTokens > r.memory.admittedTokens);
  assert.ok(r.memory.reduction > 0 && r.memory.reduction <= 1);
});

test("assemble: memory past Jev's batch stays out — a short off-topic fact cannot win on density", () => {
  const root = fixture();
  // Short, off-topic facts the rubric would pack first (equal score, fewest tokens) …
  for (let i = 0; i < JEV_BATCH + 10; i++)
    put(root, "fact", { name: `n${i}`, text: `budget alert ${i}` });
  // … and one long, on-topic one.
  const onTopic = put(root, "fact", {
    name: "login-redirect",
    text: "the login redirect loop came from the session cookie path; keep it at / for the login flow",
  });
  // Jev rejects every off-topic fact it is shown; the 10 it is never shown (past the
  // relevance-ranked batch) are the ones the old rule packed on value density alone.
  const call = fakeJev((k, _q, payload) =>
    noulOf(payload.state.memory[k].includes("redirect loop") ? 0.95 : 0.1),
  );
  const r = assemble(root, "fix the login redirect loop", {
    nowDay: 120,
    llm: true,
    jevCall: call,
  });
  assert.equal(Object.keys(call.calls[0].questions).length, JEV_BATCH);
  assert.equal(r.memory.jev.dropped, JEV_BATCH - 1);
  assert.deepEqual(
    r.selection.filter((s) => s.source === "fact").map((s) => s.id),
    [`fact:${onTopic.id.slice(0, 8)}`],
    "only memory Jev judged (and admitted) is packed",
  );
});

test("assemble: Jev on but the call fails → the rubric's selection, unchanged", () => {
  const root = fixture();
  put(root, "fact", { name: "login-flow", text: "the login flow posts to /api/session" });
  put(root, "summary", { text: "fixed the login redirect loop", files: ["src/login.js"] });
  const task = "improve the login flow redirect";
  const base = assemble(root, task, { nowDay: 120 });
  const failed = assemble(root, task, { nowDay: 120, llm: true, jevCall: () => null });
  assert.deepEqual(failed, base);
});

test("assemble: measure adds the memory block with Jev off, and touches nothing else", () => {
  const root = fixture();
  put(root, "fact", { name: "a", text: "alpha beta gamma" });
  const base = assemble(root, "alpha", { nowDay: 120 });
  const measured = assemble(root, "alpha", { nowDay: 120, measure: true });
  const { memory, ...rest } = measured;
  assert.deepEqual(rest, base);
  assert.equal(memory.jev, null);
  assert.equal(memory.memoryClaims, 1);
});

// ── layer 2: episodic ─────────────────────────────────────────────────────────────────

const hit = (id, rel, text) => ({
  claim: { id, kind: "summary", body: { text } },
  score: rel,
  rel,
});

test("chooseReplay: off, or no hit with any overlap → null (the rubric decides, Jev unasked)", () => {
  const call = fakeJev(() => noulOf(0.9));
  const root = fixture();
  assert.equal(chooseReplay("t", [hit("a", 0.9, "x")], { root, llm: false, call }), null);
  assert.equal(chooseReplay("t", [hit("a", 0, "x")], { root, llm: true, call }), null);
  assert.equal(call.calls.length, 0);
});

test("chooseReplay: picks the most helpful hit (index into hits); all unhelpful → −1", () => {
  const root = fixture();
  const hits = [hit("a", 0.9, "fix login css"), hit("b", 0.4, "fix flaky login test")];
  const pickB = fakeJev((k) => noulOf(k === "s1" ? 0.92 : 0.3));
  assert.deepEqual(
    { ...chooseReplay("fix the flaky login test", hits, { root, llm: true, call: pickB }), ms: 0 },
    { index: 1, p: 0.92, ms: 0 },
  );
  const none = fakeJev(() => noulOf(0.2));
  assert.equal(chooseReplay("x", hits, { root, llm: true, call: none })?.index, -1);
  const rec = readJournal(root)[0];
  assert.deepEqual(
    rec.decisions.map((d) => [d.rubric, d.action]),
    [
      ["replay", "skip"],
      ["skip", "replay"],
    ],
  );
});

test("dejaAdvisory: Jev's pick is replayed (with its p), Jev's 'none' silences, off = rubric", () => {
  const root = fixture();
  put(root, "summary", { text: "fix the flaky login test in auth", files: ["test/auth.test.js"] });
  put(root, "summary", { text: "restyle the login page", files: ["src/login.css"] });
  const task = "fix the flaky login test";
  const rubric = dejaAdvisory(root, task, 120, { llm: false });
  assert.match(rubric, /flaky login test/);
  const pick = fakeJev(() => noulOf(0.88));
  const line = dejaAdvisory(root, task, 120, { llm: true, call: pick });
  assert.match(line, /jev p=0\.88/);
  const silent = fakeJev(() => noulOf(0.1));
  assert.equal(dejaAdvisory(root, task, 120, { llm: true, call: silent }), "");
});

// ── layer 3: semantic ─────────────────────────────────────────────────────────────────

test("verifyFact: off → write (rubric), Jev unasked", () => {
  const call = fakeJev(() => noulOf(0.1));
  const v = verifyFact(
    fixture(),
    { name: "x", text: "tests run with node --test" },
    { llm: false, call },
  );
  assert.equal(v.verdict, "write");
  assert.equal(v.source, "rubric");
  assert.equal(call.calls.length, 0);
});

test("verifyFact: transient / duplicate / supersede need confidence; uncertainty writes", () => {
  const root = fixture();
  const old = put(root, "fact", { name: "deploy-day", text: "we deploy on Tuesdays" });
  const ask = (durable, relation, conf) =>
    verifyFact(
      root,
      { name: "release-day", text: "we deploy on Thursdays" },
      {
        llm: true,
        nowDay: 120,
        call: fakeJev((k) => (k === "durable" ? noulOf(durable) : choiceOf(relation, conf))),
      },
    );
  assert.equal(ask(0.1, "new", 0.9).verdict, "transient");
  const dup = ask(0.9, "same_as_f0", 0.95);
  assert.equal(dup.verdict, "duplicate");
  assert.equal(dup.nearest?.id, old.id);
  assert.equal(ask(0.9, "conflicts_f0", 0.9).verdict, "supersede");
  const unsure = ask(0.6, "conflicts_f0", 0.6);
  assert.equal(unsure.verdict, "write");
  assert.equal(unsure.source, "jev");
});

test("verifyFact: a same-name fact is not a 'nearest' — remember already supersedes by name", () => {
  const root = fixture();
  put(root, "fact", { name: "deploy-day", text: "we deploy on Tuesdays" });
  const call = fakeJev(() => noulOf(0.9));
  verifyFact(root, { name: "deploy-day", text: "we deploy on Thursdays" }, { llm: true, call });
  assert.equal(call.calls[0].questions.relation, undefined);
});

test("rememberVerified: transient refused (force stores), duplicate skipped, supersede archives", () => {
  const root = fixture();
  const transient = fakeJev((k) => (k === "durable" ? noulOf(0.05) : choiceOf("new", 0.9)));
  const refused = rememberVerified(root, "wip", "I am halfway through the refactor", {
    llm: true,
    call: transient,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /--force/);
  assert.equal(loadClaims(repoLedger(root)).length, 0, "nothing stored");
  const forced = rememberVerified(root, "wip", "I am halfway through the refactor", {
    force: true,
    llm: true,
    call: transient,
  });
  assert.equal(forced.ok, true);
  assert.equal(transient.calls.length, 1, "force skips the check");

  const old = put(root, "fact", { name: "deploy-day", text: "we deploy on Tuesdays" });
  const same = fakeJev((k) => (k === "durable" ? noulOf(0.9) : choiceOf("same_as_f0", 0.95)));
  const dup = rememberVerified(root, "deploys", "deploys happen on Tuesdays", {
    llm: true,
    call: same,
  });
  assert.equal(dup.duplicate, true);
  assert.equal(loadClaims(repoLedger(root)).filter((c) => c.body?.name === "deploys").length, 0);
  assert.ok(readUses(repoLedger(root)).has(old.id), "the existing fact's use is recorded");

  const conflict = fakeJev((k) => (k === "durable" ? noulOf(0.9) : choiceOf("conflicts_f0", 0.9)));
  const r = rememberVerified(root, "release-day", "we deploy on Thursdays", {
    llm: true,
    call: conflict,
  });
  assert.equal(r.ok, true);
  assert.equal(r.superseded?.id, old.id);
  const live = loadClaims(repoLedger(root)).map((c) => c.id);
  assert.ok(!live.includes(old.id), "the contradicted fact left the live ledger");
  assert.ok(existsSync(join(repoLedger(root), "attic", `${old.id}.json`)), "…for the attic");
  assert.equal(archiveRecord(repoLedger(root), old.id)?.cause, "superseded");
  assert.ok(readJournal(root).some((j) => j.kind === "action" && j.action === "superseded"));
});

test("storeFact: the semantic layer gates ledger facts; decisions are never checked", () => {
  const root = fixture();
  const transient = fakeJev(() => noulOf(0.05));
  const r = storeFact(root, "the build is currently red on my branch", {
    route: { home: "ledger-fact", confidence: 1, provenance: "test", neighbors: [], write: "auto" },
    llm: true,
    call: transient,
  });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  const forced = storeFact(root, "the build is currently red on my branch", {
    route: { home: "ledger-fact", confidence: 1, provenance: "test", neighbors: [], write: "auto" },
    force: true,
    llm: true,
    call: transient,
  });
  assert.equal(forced.stored, true);
  const decision = storeFact(root, "we picked Postgres over Mongo", {
    route: { home: "decision", confidence: 1, provenance: "test", neighbors: [], write: "auto" },
    llm: true,
    call: transient,
  });
  assert.equal(decision.stored, true);
  assert.equal(transient.calls.length, 1);
});

// ── layer 5: forgetting ───────────────────────────────────────────────────────────────

const mem = (kind, text, t) => ({
  .../** @type {any} */ (
    mintClaim({ kind, body: { text }, scope: { level: "repo" }, provenance: {}, t })
  ).claim,
  provenance: { t },
});

test("judgeForgetting: off → the same plan object, Jev unasked", () => {
  const plan = { archive: [] };
  const call = fakeJev(() => noulOf(0.1));
  assert.equal(
    judgeForgetting([mem("fact", "a", 1)], plan, new Map(), 100, {
      root: fixture(),
      llm: false,
      call,
    }),
    plan,
  );
  assert.equal(call.calls.length, 0);
});

test("judgeForgetting: floors hold; idle vetoed when useful; stale live memory archived as 'judged'", () => {
  const nowDay = 200;
  const tomb = mem("fact", "tombstoned thing", 10);
  const dormant = mem("lesson", "contradicted lesson", 10);
  const idle = mem("summary", "still useful summary", 20);
  const stale = mem("summary", "obsolete one-off summary", 30);
  const fresh = mem("fact", "minted today", nowDay);
  const artifact = mem("artifact", "cached code", 5);
  const plan = {
    archive: [
      { id: tomb.id, reason: "t", cause: "tombstoned" },
      { id: dormant.id, reason: "d", cause: "dormant" },
      { id: idle.id, reason: "i", cause: "idle" },
    ],
  };
  const call = fakeJev((k, _q, payload) => {
    const text = payload.state.memory[k];
    if (text.includes("obsolete")) return noulOf(0.05);
    return noulOf(0.95);
  });
  const root = fixture();
  const out = judgeForgetting(
    [tomb, dormant, idle, stale, fresh, artifact],
    plan,
    new Map(),
    nowDay,
    { root, llm: true, call },
  );
  const asked = Object.values(call.calls[0].state.memory).join(" | ");
  assert.ok(
    !asked.includes("tombstoned thing") && !asked.includes("contradicted lesson"),
    "floors are never asked",
  );
  assert.ok(!asked.includes("minted today"), "today's claims are never touched");
  assert.ok(!asked.includes("cached code"), "only memory kinds are judged");
  const ids = out.archive.map((a) => a.id);
  assert.ok(ids.includes(tomb.id) && ids.includes(dormant.id));
  assert.ok(!ids.includes(idle.id), "vetoed: Jev is confident it is still useful");
  assert.equal(out.archive.find((a) => a.id === stale.id)?.cause, "judged");
  assert.deepEqual(out.judged.vetoed, [idle.id]);
  assert.deepEqual(out.judged.added, [stale.id]);
});

test("pruneLedger: a judge re-decides the plan; a judge that throws leaves the rubric's", () => {
  const root = fixture();
  const dir = repoLedger(root);
  const a = put(root, "summary", { text: "a" }, { t: 100 });
  const kept = pruneLedger(dir, 101, {
    judge: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(kept.pruned, []);
  const judged = pruneLedger(dir, 101, {
    judge: (_c, plan) => ({ ...plan, archive: [{ id: a.id, reason: "jev", cause: "judged" }] }),
  });
  assert.deepEqual(judged.pruned, [a.id]);
  assert.equal(archiveRecord(dir, a.id)?.cause, "judged");
});

test("recordSessionSummary: with Jev on, the Stop prune asks the forgetting layer", () => {
  const root = fixture();
  put(root, "summary", { text: "an old one-off investigation" }, { t: 10 });
  const call = fakeJev(() => noulOf(0.05));
  const r = recordSessionSummary(
    root,
    "s1",
    [
      { type: "prompt", text: "add rate limiting to the export route" },
      { type: "edit", file: "src/export.js" },
    ],
    200,
    { llm: true, call },
  );
  assert.equal(r.ok, true);
  assert.ok(
    call.calls.some((p) => p.questions.c0),
    "the forgetting layer was asked",
  );
  const live = loadClaims(repoLedger(root)).map((c) => c.body?.text);
  assert.ok(!live.includes("an old one-off investigation"), "judged stale → attic");
  assert.ok(live.includes("add rate limiting to the export route"), "today's summary is untouched");
});

// ── journal ───────────────────────────────────────────────────────────────────────────

test("summarizeJournal: per-layer calls, answered, overrides and measured latency", () => {
  const s = summarizeJournal([
    {
      layer: "working",
      ok: true,
      ms: 100,
      billedIn: 50,
      decisions: [
        { rubric: "admit", action: "drop" },
        { rubric: "admit", action: "admit" },
      ],
    },
    { layer: "working", ok: true, ms: 140, billedIn: 70, decisions: [] },
    { layer: "working", ok: false, ms: 2500, decisions: [] },
    { layer: "semantic", kind: "action", action: "superseded" },
  ]);
  assert.equal(s.working.calls, 3);
  assert.equal(s.working.answered, 2);
  assert.equal(s.working.failed, 1);
  assert.equal(s.working.overrides, 1);
  assert.equal(s.working.decisions, 2);
  assert.equal(s.working.billedIn, 120);
  assert.equal(s.working.ms.median, 140);
  assert.equal(s.working.ms.p95, 2500);
  assert.equal(s.semantic.calls, 0, "an action record is not a call");
});

test("the journal is plain JSONL under .forge and survives a corrupt line", () => {
  const root = fixture();
  admitWorking("t", [{ id: "a", text: "x" }], {
    root,
    llm: true,
    call: fakeJev(() => noulOf(0.7)),
  });
  const path = join(root, ".forge", "jev-memory.jsonl");
  const text = readFileSync(path, "utf8");
  assert.equal(text.trim().split("\n").length, 1);
  assert.equal(readJournal(root).length, 1);
});
