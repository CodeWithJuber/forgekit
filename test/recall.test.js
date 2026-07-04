import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add, list, consolidate } from "../src/recall.js";

const store = () => mkdtempSync(join(tmpdir(), "forge-recall-"));

test("add stores a fact and updates the index", () => {
  const s = store();
  const res = add(s, "DB port quirk", "Postgres runs on 5433 here, not 5432.");
  assert.equal(res.ok, true);
  assert.deepEqual(list(s), ["db-port-quirk"]);
  assert.match(readFileSync(join(s, "MEMORY.md"), "utf8"), /db-port-quirk/);
});

test("add refuses secrets (stores nothing)", () => {
  const s = store();
  const res = add(
    s,
    "api creds",
    "token is REDACTED_FIXTURE",
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /refused/);
  assert.deepEqual(list(s), []);
});

test("consolidate removes exact-duplicate bodies", () => {
  const s = store();
  add(s, "rule one", "always run migrations before deploy");
  add(s, "rule one restated", "always run migrations before deploy");
  assert.equal(list(s).length, 2);
  const { removed } = consolidate(s);
  assert.equal(removed, 1);
  assert.equal(list(s).length, 1);
});
