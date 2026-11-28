// Jev memory layers (src/jev_memory.js) and their wiring into context, deja, the ledger
// prune and remember. No network: every Jev answer comes from an injected transport, and the
// API key is set in-file (per the hermetic convention — each test file is its own process,
// so this assignment runs after _setup's scrub).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.TYPESAFE_API_KEY = "tsk-test-only";
// Every layer on, including the two the default leaves off (tested below with explicit env).
process.env.FORGE_JEV_MEMORY = "all";

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

test("FORGE_JEV_MEMORY: unset → the read-side three; all/1/true/on → five; 0/off → none; a list", () => {
  assert.deepEqual([...jevMemoryLayers({})], ["working", "episodic", "semantic"]);
  for (const v of ["all", "1", "true", "ON"])
    assert.deepEqual([...jevMemoryLayers({ FORGE_JEV_MEMORY: v })], [...JEV_MEMORY_LAYERS], v);
  for (const v of ["0", "false", "off", "none"])
    assert.equal(jevMemoryLayers({ FORGE_JEV_MEMORY: v }).size, 0, v);
  assert.deepEqual(
    [...jevMemoryLayers({ FORGE_JEV_MEMORY: "working, Forgetting,bogus" })],
    ["working", "forgetting"],
  );
});

test("the autonomous write layers (procedural, forgetting) need an explicit opt-in", () => {
  const st = jevMemoryStatus(fixture(), { llm: true, env: {} });
  assert.equal(st.layers.working, true);
  assert.equal(st.layers.procedural, false);
  assert.equal(st.layers.forgetting, false);
  const off = jevMemoryStatus(fixture(), { llm: true, env: { FORGE_JEV_MEMORY: "off" } });
  assert.match(off.reason, /FORGE_JEV_MEMORY=off/);
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
  assert.equal(refused.refused, true, "the one refusal a caller may override");
  assert.match(refused.reason, /one-off/);
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

  // (A fresh repo: the duplicate step above used `old` today, and today's memory is a floor.)
  const root2 = fixture();
  const stale = put(root2, "fact", { name: "deploy-day", text: "we deploy on Tuesdays" });
  const conflict = fakeJev((k) => (k === "durable" ? noulOf(0.9) : choiceOf("conflicts_f0", 0.9)));
  const r = rememberVerified(root2, "release-day", "we deploy on Thursdays", {
    llm: true,
    call: conflict,
  });
  assert.equal(r.ok, true);
  assert.equal(r.superseded?.id, stale.id);
  const live = loadClaims(repoLedger(root2)).map((c) => c.id);
  assert.ok(!live.includes(stale.id), "the contradicted fact left the live ledger");
  assert.ok(existsSync(join(repoLedger(root2), "attic", `${stale.id}.json`)), "…for the attic");
  assert.equal(archiveRecord(repoLedger(root2), stale.id)?.cause, "superseded");
  assert.ok(readJournal(root2).some((j) => j.kind === "action" && j.action === "superseded"));
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

// ── regressions from the independent review (one per confirmed defect) ──────────────

test("working: an asked item whose answer is garbled keeps its rubric standing", () => {
  const root = fixture();
  const a = put(root, "fact", { name: "login-a", text: "login uses the session cookie" });
  const b = put(root, "fact", { name: "login-b", text: "login retries twice on 503" });
  const base = assemble(root, "fix the login flow", { nowDay: 120 });
  // One answer validates, the other is garbled (wrong type) — systemOne drops only that one.
  const firstOnly = fakeJev((k) => (k === "m0" ? noulOf(0.9) : { type: "choice", choice: "x" }));
  const r = assemble(root, "fix the login flow", { nowDay: 120, llm: true, jevCall: firstOnly });
  const ids = (x) =>
    x.selection
      .filter((s) => s.source === "fact")
      .map((s) => s.id)
      .sort();
  assert.deepEqual(ids(r), ids(base), "a garbled verdict is no verdict: the rubric's facts stay");
  assert.ok([a, b].every((c) => ids(r).includes(`fact:${c.id.slice(0, 8)}`)));
  assert.equal(firstOnly.calls.length, 1);
});

test("episodic: one garbled answer → the rubric decides (never a silent override)", () => {
  const root = fixture();
  const hits = [hit("a", 0.9, "fix flaky login test"), hit("b", 0.4, "restyle login page")];
  const garbledFirst = fakeJev((k) =>
    k === "s0" ? { type: "choice", choice: "x" } : noulOf(0.55),
  );
  assert.equal(
    chooseReplay("fix the flaky login test", hits, { root, llm: true, call: garbledFirst }),
    null,
  );
  const garbledLow = fakeJev((k) => (k === "s0" ? { type: "choice", choice: "x" } : noulOf(0.2)));
  assert.equal(
    chooseReplay("fix the flaky login test", hits, { root, llm: true, call: garbledLow }),
    null,
  );
});

test("semantic: supersede keeps a fact that evidence confirmed, that is today's, or file-backed", () => {
  const conflict = () =>
    fakeJev((k) => (k === "durable" ? noulOf(0.9) : choiceOf("conflicts_f0", 0.95)));
  // confirmed by a test.run outcome → val > 0.5
  const r1 = fixture();
  const confirmed = put(
    r1,
    "fact",
    { name: "deploy-day", text: "we deploy on Tuesdays" },
    { confirm: 3 },
  );
  // judged near the evidence (confirmations decay back to the 0.5 prior over weeks)
  const a = rememberVerified(r1, "release-day", "we deploy on Thursdays", {
    llm: true,
    call: conflict(),
    nowDay: 105,
  });
  assert.equal(a.superseded, undefined);
  assert.equal(a.contradicts?.id, confirmed.id);
  assert.match(a.kept, /evidence/);
  assert.ok(loadClaims(repoLedger(r1)).some((c) => c.id === confirmed.id));
  // minted today
  const r2 = fixture();
  const today = put(r2, "fact", { name: "deploy-day", text: "we deploy on Tuesdays" }, { t: 500 });
  const b = rememberVerified(r2, "release-day", "we deploy on Thursdays", {
    llm: true,
    call: conflict(),
    nowDay: 500,
  });
  assert.match(b.kept ?? "", /today/);
  assert.ok(loadClaims(repoLedger(r2)).some((c) => c.id === today.id));
  // backed by a fact file (portable brain / FORGE_LEDGER_ONLY=0)
  const r3 = fixture();
  put(r3, "fact", { name: "deploy-day", text: "we deploy on Tuesdays" });
  mkdirSync(join(r3, ".forge", "brain", "facts"), { recursive: true });
  writeFileSync(join(r3, ".forge", "brain", "facts", "deploy-day.md"), "we deploy on Tuesdays\n");
  const c = rememberVerified(r3, "release-day", "we deploy on Thursdays", {
    llm: true,
    call: conflict(),
  });
  assert.match(c.kept ?? "", /fact file/);
});

test("semantic: a secret-shaped name never reaches the journal", () => {
  const root = fixture();
  verifyFact(
    root,
    { name: fakeGithubPat(), text: "the mirror token lives in the vault" },
    {
      llm: true,
      call: fakeJev(() => noulOf(0.9)),
    },
  );
  assert.equal(hasSecret(readFileSync(join(root, ".forge", "jev-memory.jsonl"), "utf8")), false);
});

test("semantic: storeFact never checks a personal recall note against this repo's ledger", () => {
  const call = fakeJev(() => noulOf(0.01));
  const r = storeFact(fixture(), "I prefer tabs over spaces everywhere", {
    route: { home: "recall", confidence: 1, provenance: "test", neighbors: [], write: "auto" },
    llm: true,
    call,
  });
  assert.equal(r.stored, true);
  assert.equal(call.calls.length, 0);
});

test("semantic: storeFact with archive:false (the autonomous path) never archives a fact", () => {
  const root = fixture();
  const old = put(root, "fact", { name: "deploy-day", text: "we deploy on Tuesdays" });
  const conflict = fakeJev((k) => (k === "durable" ? noulOf(0.9) : choiceOf("conflicts_f0", 0.95)));
  const r = storeFact(root, "we deploy on Thursdays", {
    route: { home: "ledger-fact", confidence: 1, provenance: "test", neighbors: [], write: "auto" },
    llm: true,
    call: conflict,
    archive: false,
  });
  assert.equal(r.stored, true);
  assert.equal(r.superseded, undefined);
  assert.ok(loadClaims(repoLedger(root)).some((c) => c.id === old.id));
});

test("forgetting: cached code and decisions are never judged; recent memory is out of reach", () => {
  const nowDay = 200;
  const artifact = mem("artifact", "cached parser code", 5);
  const decision = mem("decision", "ratified: keep argon2", 5);
  const recent = mem("summary", "touched last week", nowDay - 7);
  const old = mem("summary", "an old one-off", 10);
  const plan = { archive: [{ id: artifact.id, reason: "i", cause: "idle" }] };
  const call = fakeJev(() => noulOf(0.95));
  const out = judgeForgetting([artifact, decision, recent, old], plan, new Map(), nowDay, {
    root: fixture(),
    llm: true,
    call,
  });
  const sent = Object.values(call.calls[0].state.memory).join(" | ");
  assert.ok(!sent.includes("cached parser code"), "an artifact is never sent off the machine");
  assert.ok(!sent.includes("argon2"), "a decision is never judged");
  assert.ok(!sent.includes("touched last week"), "idle < 30 days is out of reach");
  assert.ok(sent.includes("an old one-off"));
  assert.ok(
    out.archive.some((a) => a.id === artifact.id),
    "the rubric's artifact archive stands",
  );
});

test("forgetting: the Stop path (once) judges at most once a day", () => {
  const root = fixture();
  const claims = [mem("summary", "an old one-off", 10)];
  const call = fakeJev(() => noulOf(0.5));
  const opts = { root, llm: true, call, once: true };
  judgeForgetting(claims, { archive: [] }, new Map(), 200, opts);
  judgeForgetting(claims, { archive: [] }, new Map(), 200, opts);
  assert.equal(call.calls.length, 1, "the second Stop the same day does not ask");
  judgeForgetting(claims, { archive: [] }, new Map(), 201, opts);
  assert.equal(call.calls.length, 2, "the next day asks again");
  judgeForgetting(claims, { archive: [] }, new Map(), 201, { root, llm: true, call });
  assert.equal(call.calls.length, 3, "an explicit dry run is never rate-limited");
});
