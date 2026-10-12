// Tests for `forge verify --claim` (src/verify.js verifyClaim) — checking someone
// else's verification claim: CONFIRMED / STALE / REFUTED with evidence, no re-run
// needed when the tree is unchanged (the MAC'd, fingerprint-bound stamp IS the evidence).
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeCodeState, signProvenance, verify, verifyClaim } from "../src/verify.js";

const CLI = join(import.meta.dirname, "..", "src", "cli.js");

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "forge-claim-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t && git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  execSync("git add -A && git commit -qm init", { cwd: dir });
  return dir;
}

function receiptFor(dir) {
  const r = verify({ targetRoot: dir });
  return JSON.parse(JSON.stringify(r)); // through JSON, like a real artifact
}

test("CONFIRMED: valid signature + unchanged tree", () => {
  const dir = gitRepo();
  const r = verifyClaim(receiptFor(dir), { cwd: dir });
  assert.equal(r.verdict, "CONFIRMED");
  assert.equal(r.signature, "VALID");
  assert.equal(r.tree, "MATCHED");
  assert.ok(r.claim.runId, "evidence names the run");
  assert.match(r.reason, /signature valid/);
});

test("STALE: valid signature + changed tree cannot be confirmed from the receipt", () => {
  const dir = gitRepo();
  const receipt = receiptFor(dir);
  writeFileSync(join(dir, "b.js"), "export const b = 2;\n"); // tree moves on
  const r = verifyClaim(receipt, { cwd: dir });
  assert.equal(r.verdict, "STALE");
  assert.equal(r.signature, "VALID");
  assert.equal(r.tree, "CHANGED");
  assert.match(r.reason, /re-run `forge verify`/);
});

test("REFUTED: a modified receipt fails the MAC", () => {
  const dir = gitRepo();
  const receipt = receiptFor(dir);
  receipt.provenance.tests.status = "PASS"; // tamper: upgrade the claim
  const r = verifyClaim(receipt, { cwd: dir });
  assert.equal(r.verdict, "REFUTED");
  assert.equal(r.signature, "INVALID");
  assert.match(r.reason, /modified after minting/);
});

test("REFUTED: a hand-written receipt with a forged signature fails", () => {
  const dir = gitRepo();
  const forged = {
    provenance: {
      codeState: computeCodeState(dir),
      tests: { status: "PASS" },
      event: { runId: "forged" },
      signature: "0".repeat(64),
    },
    tests: { status: "PASS" },
    ok: true,
  };
  const r = verifyClaim(forged, { cwd: dir });
  assert.equal(r.verdict, "REFUTED");
});

test("INVALID: not a receipt at all", () => {
  const dir = gitRepo();
  for (const bad of [{}, { provenance: {} }, { provenance: { codeState: {} } }]) {
    const r = verifyClaim(bad, { cwd: dir });
    assert.equal(r.verdict, "INVALID", JSON.stringify(bad));
  }
});

test("minting the receipt does not perturb the tree (forge's own .forge/ is excluded)", () => {
  const dir = gitRepo();
  const before = computeCodeState(dir).dirtyHash;
  verify({ targetRoot: dir }); // writes .forge/provenance.json
  const after = computeCodeState(dir).dirtyHash;
  assert.equal(before, after, ".forge writes must not change the fingerprint");
  const r = verifyClaim(receiptFor(dir), { cwd: dir });
  assert.equal(r.verdict, "CONFIRMED");
});

test("CLI: --claim prints CONFIRMED and exits 0; STALE exits 1", () => {
  const dir = gitRepo();
  const receiptPath = join(dir, "..", "receipt.json");
  // `forge verify --json` exits non-zero when the verdict isn't ok (here:
  // NOT_CONFIGURED) — the receipt is still printed to stdout; read it there.
  let out;
  try {
    out = execFileSync(process.execPath, [CLI, "verify", "--json"], {
      cwd: dir,
      encoding: "utf8",
    });
  } catch (e) {
    out = e.stdout;
  }
  assert.match(out, /"signature": "/, "the receipt carries a signature");
  writeFileSync(receiptPath, out); // receipt lives OUTSIDE the repo
  const ok = execFileSync(process.execPath, [CLI, "verify", "--claim", receiptPath], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.match(ok, /CONFIRMED/);
  writeFileSync(join(dir, "b.js"), "export const b = 2;\n");
  try {
    execFileSync(process.execPath, [CLI, "verify", "--claim", receiptPath], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.fail("STALE must exit non-zero");
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(e.stdout, /STALE/);
  }
});

test("signProvenance still round-trips through verifyClaim (B7 binding intact)", () => {
  const dir = gitRepo();
  const stamp = signProvenance({
    tests: { status: "PASS" },
    codeState: computeCodeState(dir),
  });
  assert.ok(stamp.signature, "signed");
  const r = verifyClaim({ provenance: stamp, tests: { status: "PASS" }, ok: true }, { cwd: dir });
  assert.equal(r.verdict, "CONFIRMED");
});
