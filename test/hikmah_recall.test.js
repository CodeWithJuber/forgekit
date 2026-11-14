import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindHikmah, recallHikmah } from "../src/hikmah_recall.js";

test("Hikmah MCP recall never publishes private, disputed or unverified traces", {
  skip: process.platform === "win32",
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-kernel-"));
  const prev = process.env.FORGE_HOME;
  t.after(() => {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.FORGE_HOME = join(dir, "state");
  const project = join(dir, "repo");
  mkdirSync(project);
  const bin = join(dir, "hikmah"),
    ledger = join(dir, "ledger.jsonl");
  const row = (id, privacy = "public", verified = true, conflicts = []) => ({
    trace: {
      id,
      content: id,
      privacy,
      provenance: { verified, source: "human:tester", locator: "test:1" },
    },
    conflicts,
  });
  writeFileSync(ledger, "fixture");
  const rows = [
    row("allowed"),
    row("sensitive", "sensitive"),
    row("private", "private"),
    row("disputed", "public", true, ["x"]),
    row("unchecked", "public", false),
  ];
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(rows)}'\n`, { mode: 0o700 });
  assert.equal((await recallHikmah(project, "retry")).enabled, false);
  bindHikmah(project, { binary: bin, store: ledger });
  assert.deepEqual(
    (await recallHikmah(project, "retry")).hits.map((row) => row.id),
    ["allowed"],
  );
  bindHikmah(project, null);
  assert.equal((await recallHikmah(project, "retry")).enabled, false);
});
