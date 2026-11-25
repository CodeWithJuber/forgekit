import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintClaim } from "../src/ledger.js";
import { ambientLookup, putClaim, rebuildAmbientIndex, repoLedger } from "../src/ledger_store.js";

test("prompt candidates bound disk work and revalidate a retraction from a separate process", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-ambient-"));
  const dir = repoLedger(root);
  try {
    for (let i = 0; i < 400; i++) {
      const claim = mintClaim({
        kind: "fact",
        body: { name: `sample${i}`, text: "sample fixture" },
      });
      putClaim(dir, claim.claim);
    }
    const c = mintClaim({ kind: "diagnosis", body: { note: "xylophone renderer correction" } });
    putClaim(dir, c.claim);
    writeFileSync(join(dir, "claims", ".DS_Store"), "noise");
    mkdirSync(join(dir, "claims", "ignored"));
    let r = ambientLookup(dir, "xylophone renderer");
    assert.ok(r.examined <= 64);
    assert.ok(r.claims.some((x) => x.id === c.claim.id));
    const mod = new URL("../src/ledger_store.js", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {tombstone} from ${JSON.stringify(mod)}; const r=tombstone(process.argv[1],process.argv[2],{reason:"retired",author:"human",t:2});if(!r.ok)process.exitCode=1;`,
        dir,
        c.claim.id,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    r = ambientLookup(dir, "xylophone renderer");
    assert.ok(!r.claims.some((x) => x.id === c.claim.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebuilding over common terms longer than one posting page is byte-idempotent", async () => {
  const { ambientIndexDir } = await import("../src/ambient_memory.js");
  const root = mkdtempSync(join(tmpdir(), "forge-index-")),
    dir = repoLedger(root);
  try {
    for (let i = 0; i < 128; i++) {
      const { claim } = mintClaim({
        kind: "diagnosis",
        body: { note: `shared renderer observation ${i}` },
      });
      putClaim(dir, claim);
    }
    const dest = ambientIndexDir(dir);
    const buckets = () =>
      Object.fromEntries(
        readdirSync(dest)
          .filter((n) => /^[a-f0-9]{4}$/.test(n))
          .map((n) => [n, readFileSync(join(dest, n), "utf8")]),
      );
    const before = buckets();
    assert.ok(Object.values(before).some((s) => s.length > 4096));
    for (let i = 0; i < 2; i++)
      assert.deepEqual(rebuildAmbientIndex(dir), { ok: true, claims: 128, failed: 0 });
    assert.deepEqual(buckets(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
