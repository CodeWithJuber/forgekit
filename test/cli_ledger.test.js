import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// CLI-boundary contracts for the temporal ledger subcommands — exit codes and
// stderr routing are the interface here, so these spawn the real dispatcher.
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (args, cwd) =>
  spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORGE_NO_HINT: "1" },
  });

test("ledger diff with <since> after <until> refuses loudly instead of inverting classes", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-cliledger-"));
  const r = run(["ledger", "diff", "2026-08-01", "2026-05-02"], root);
  assert.equal(
    r.status,
    1,
    "a reversed window must FAIL, not print inverted results",
  );
  assert.match(r.stderr, /is after/, "the reason names the swapped arguments");
});

test("ledger at rejects an impossible calendar date instead of letting Date.parse roll it over", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-cliledger-"));
  const r = run(["ledger", "at", "2026-02-31"], root);
  assert.equal(r.status, 1, "2026-02-31 is not a day that ever existed");
  assert.match(r.stderr, /usage/, "rejected at parse time with usage");
});

test("ledger at accepts a real date and a bare epoch-day equally", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-cliledger-"));
  assert.equal(run(["ledger", "at", "2026-08-01"], root).status, 0);
  assert.equal(run(["ledger", "at", "20666"], root).status, 0);
});
