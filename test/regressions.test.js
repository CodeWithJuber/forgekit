import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { add, list } from "../src/recall.js";
import { sync } from "../src/sync.js";
import { fakeAnthropic, fakeGoogle, fakeJwt, fakeSlack } from "./_fixtures.js";

const dir = () => mkdtempSync(join(tmpdir(), "forge-reg-"));

// Regression (verifier finding #1): sync must NOT silently destroy a hand-written AGENTS.md.
test("sync backs up a pre-existing unmanaged AGENTS.md instead of clobbering it", () => {
  const root = dir();
  writeFileSync(join(root, "AGENTS.md"), "# my hand-written rules\n- do the thing\n");
  const res = sync({ targetRoot: root });
  assert.equal(res.backedUp, true);
  assert.ok(existsSync(join(root, "AGENTS.md.forge-bak")), "backup exists");
  assert.match(readFileSync(join(root, "AGENTS.md.forge-bak"), "utf8"), /hand-written rules/);
  assert.ok(
    res.warnings.some((w) => /backed up/.test(w)),
    "warns about the backup",
  );
  // second run: AGENTS.md is now Forge-managed, so no re-backup
  assert.equal(sync({ targetRoot: root }).backedUp, false);
});

// Regression (verifier finding #2): secret detection catches common real key formats.
test("recall refuses Anthropic / Slack / Google / JWT key formats", () => {
  const cases = [
    fakeAnthropic("AAAAbbbbCCCCddddEEEEffffGGGG"),
    fakeSlack(),
    fakeGoogle(),
    fakeJwt(),
  ];
  for (const value of cases) {
    const store = dir();
    assert.equal(add(store, "creds", value).ok, false, `should refuse: ${value}`);
    assert.deepEqual(list(store), []);
  }
});
