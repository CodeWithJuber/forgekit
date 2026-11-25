// Explicit review categories and model authorization are independent of predictive routing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { riskMatches } from "../src/route_policy.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const fixture = () => mkdtempSync(join(tmpdir(), "forge-route-policy-"));
test("riskMatches: whole words and phrases, optional plural, case-insensitive", () => {
  const cats = {
    money: ["payment"],
    secrets: ["api key", ".env"],
    auth: ["auth", "login"],
    migrations: ["migration"],
  };
  assert.deepEqual(riskMatches("Fix the PAYMENTS retry", cats), [
    { category: "money", keyword: "payment" },
  ]);
  assert.deepEqual(riskMatches("rotate the API key in config", cats), [
    { category: "secrets", keyword: "api key" },
  ]);
  assert.deepEqual(riskMatches("load values from .env", cats), [
    { category: "secrets", keyword: ".env" },
  ]);
  assert.deepEqual(riskMatches("update the author field", cats), [], "auth ≠ author");
  assert.deepEqual(riskMatches("rename a variable", cats), []);
  const many = riskMatches("add a migration for the login table", cats).map((r) => r.category);
  assert.deepEqual(many.sort(), ["auth", "migrations"]);
});

test("even in unattended mode the CLI cannot turn risk vocabulary into a paid recommendation", () => {
  const cwd = fixture();
  for (const task of ["hello", "architecture migration money auth security"]) {
    const result = spawnSync(
      process.execPath,
      [CLI, "route", task, "--mode", "unattended", "--allow-top", "--json"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const rec = JSON.parse(result.stdout);
    assert.equal(rec.model, null);
    assert.equal(rec.provenance.path, "insufficient-evidence");
  }
  const apply = spawnSync(
    process.execPath,
    [CLI, "route", "change a variable", "--apply", "--json"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(apply.status, 1);
  assert.equal(JSON.parse(apply.stdout).model, null);
});
