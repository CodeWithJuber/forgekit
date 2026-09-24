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
// It used to replace the file and park the original in AGENTS.md.forge-bak, which no agent
// reads; now it appends forge's block and leaves every hand-written line where it was.
test("sync keeps a pre-existing hand-written AGENTS.md in place and appends the Forge block", () => {
  const root = dir();
  const mine = "# my hand-written rules\n- do the thing\n";
  writeFileSync(join(root, "AGENTS.md"), mine);
  const res = sync({ targetRoot: root });
  assert.equal(res.backedUp, false, "nothing to back up: the file is not replaced");
  assert.ok(!existsSync(join(root, "AGENTS.md.forge-bak")), "no backup file");
  const after = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.ok(after.startsWith(mine), "hand-written text kept verbatim, first");
  assert.match(after, /<!-- forge:begin -->[\s\S]*## Workflow[\s\S]*<!-- forge:end -->\n$/);
  // second run: only the block is compared, and it is current
  const again = sync({ targetRoot: root });
  assert.equal(again.report.find((r) => r.target === "AGENTS.md").action, "unchanged");
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), after);
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
