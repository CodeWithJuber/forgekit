import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brainBlock, brainStore, buildIndex, remember } from "../src/brain.js";
import { sync } from "../src/sync.js";
import { fakeAnthropic } from "./_fixtures.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-brain-"));

test("remember stores a fact and builds the inlined index", () => {
  const root = fixture();
  const res = remember(brainStore(root), "DB port", "Postgres is on 5433 here, not 5432");
  assert.equal(res.ok, true);
  assert.match(brainBlock(root), /db-port/);
  assert.match(brainBlock(root), /5433/);
});

test("remember refuses secrets", () => {
  const root = fixture();
  assert.equal(remember(brainStore(root), "creds", `token ${fakeAnthropic()}`).ok, false);
});

test("brain is inlined into AGENTS.md by sync (so every tool shares it)", () => {
  const root = fixture();
  remember(brainStore(root), "deploy note", "run migrations before deploy, always");
  sync({ targetRoot: root });
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /Project memory \(Forge brain\)/);
  assert.match(agents, /deploy-note/);
});

test("buildIndex caps items and reports overflow (cliff-safe)", () => {
  const store = brainStore(fixture());
  for (let i = 0; i < 5; i++) remember(store, `fact${i}`, `body ${i}`);
  const idx = buildIndex(store, { capItems: 2 });
  assert.equal(idx.indexed, 2);
  assert.equal(idx.overflow, 3);
});

test("the broadcast index withholds a fact the ledger's evidence refuted (and says so)", async () => {
  const { outcomeRecord } = await import("../src/ledger.js");
  const { appendEvidence, loadClaims, repoLedger } = await import("../src/ledger_store.js");
  const { epochDay } = await import("../src/util.js");
  const root = fixture();
  const store = brainStore(root);
  const today = epochDay();
  assert.equal(remember(store, "deploy", "Run `npm run deploy:prod` directly, CI is optional").ok, true);
  assert.match(brainBlock(root), /deploy/, "a fresh fact is broadcast");
  const dir = repoLedger(root);
  const claim = loadClaims(dir).find((c) => c.kind === "fact");
  for (const ref of ["ci:101", "ci:102", "ci:103"])
    appendEvidence(
      dir,
      claim.id,
      outcomeRecord({ oracle: "ci.run", result: "contradict", ref, t: today }).outcome,
    );
  const idx = buildIndex(store, { nowDay: today });
  assert.equal(idx.hidden, 1, "the contradicted fact is withheld from every AGENTS.md reader");
  const block = brainBlock(root);
  assert.doesNotMatch(block, /deploy:prod/, "its content is no longer broadcast");
  assert.match(block, /withheld: contradicted/, "and the withholding is stated, never silent");
});
