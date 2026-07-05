import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brainBlock, brainStore, buildIndex, remember } from "../src/brain.js";
import { sync } from "../src/sync.js";

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
  assert.equal(
    remember(brainStore(root), "creds", "token REDACTED_FIXTURE").ok,
    false,
  );
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
  for (let i = 0; i < 5; i++) remember(store, "fact" + i, "body " + i);
  const idx = buildIndex(store, { capItems: 2 });
  assert.equal(idx.indexed, 2);
  assert.equal(idx.overflow, 3);
});
