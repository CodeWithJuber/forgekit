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
  assert.equal(r.status, 1, "a reversed window must FAIL, not print inverted results");
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

test("ledger retract (C2): a prefix is refused; the full id tombstones under the human's identity", async () => {
  const { mintClaim } = await import("../src/ledger.js");
  const { loadClaims, putClaim, repoLedger } = await import("../src/ledger_store.js");
  const root = mkdtempSync(join(tmpdir(), "forge-cliledger-"));
  const dir = repoLedger(root);
  const c = mintClaim({ kind: "fact", body: { name: "port", text: "api listens on 8080" } }).claim;
  putClaim(dir, c);
  const retract = (id) =>
    spawnSync("node", [CLI, "ledger", "retract", id, "--reason", "stale"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORGE_NO_HINT: "1", FORGE_AUTHOR: "Alice <alice@corp>" },
    });
  for (const prefix of [c.id.slice(0, 2), c.id.slice(0, 12), c.id.slice(0, 63)]) {
    const r = retract(prefix);
    assert.equal(r.status, 1, `prefix ${prefix.length} chars refused`);
    assert.match(r.stderr, /full 64-character claim id/);
  }
  assert.equal(loadClaims(dir)[0].tombstone, undefined, "no prefix ever tombstones");
  const ok = retract(c.id);
  assert.equal(ok.status, 0, ok.stderr);
  const t = loadClaims(dir)[0].tombstone;
  assert.equal(t.author, "Alice <alice@corp>");
  assert.equal(t.reason, "stale");
});
