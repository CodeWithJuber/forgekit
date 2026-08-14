import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { add, consolidate, list } from "../src/recall.js";
import { fakeGithubPat } from "./_fixtures.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

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
  const res = add(s, "api creds", `token is ${fakeGithubPat()}`);
  assert.equal(res.ok, false);
  assert.match(res.reason, /refused/);
  assert.deepEqual(list(s), []);
});

test("add refuses a secret-ish key ASSIGNED to a value", () => {
  const s = store();
  for (const body of [
    'password = "hunter2xyz"',
    "SECRET_KEY: djangoInsecure9",
    "api_key=abcdef12",
  ]) {
    assert.equal(add(s, "k", body).ok, false, `should refuse: ${body}`);
  }
});

test("add allows a bare mention of secret/password/api key (a pointer, not a value)", () => {
  const s = store();
  // These are the legitimate notes the over-broad word match used to reject.
  assert.equal(add(s, "auth note", "implement password hashing with argon2 in auth.js").ok, true);
  assert.equal(add(s, "rotate note", "rotate the api key helper before release").ok, true);
  assert.equal(add(s, "vault note", "the secret lives in the vault, not the repo").ok, true);
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
