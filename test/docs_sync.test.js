import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/atlas.js";
import { changedIdentifiers, docSet, docsSyncReport } from "../src/docs_sync.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-docsync-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "val.js"), "export function validateOrder(x){ return !!x }\n");
  writeFileSync(
    join(root, "README.md"),
    "# app\n\nUse `validateOrder` from `src/val.js` to check orders.\n",
  );
  writeFileSync(join(root, "SILENT.md"), "# notes\n\nNothing about that code here.\n");
  writeFileSync(join(root, "CHANGELOG.md"), "# changes\n\n- added validateOrder\n");
  const commit = (m) => {
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-qm", m);
  };
  commit("fixture");
  return { root, git, commit };
}

test("changedIdentifiers: paths + definitions + calls from added AND removed lines", () => {
  const { root } = gitFixture();
  writeFileSync(
    join(root, "src", "val.js"),
    "export function validateOrderStrict(x){ return checkLimits(x) }\n",
  );
  const { identifiers, changedFiles } = changedIdentifiers(root, { base: "HEAD" });
  assert.ok(changedFiles.includes("src/val.js"));
  assert.ok(identifiers.includes("src/val.js"), "the changed path is an identifier");
  assert.ok(identifiers.includes("validateOrderStrict"), "new definition captured");
  assert.ok(identifiers.includes("validateOrder"), "REMOVED definition captured too");
  assert.ok(identifiers.includes("checkLimits"), "called symbol captured");
});

test("docsSyncReport: stale doc cited file:line; silent doc verified with reason; CHANGELOG exempt", () => {
  const { root } = gitFixture();
  build({ root });
  writeFileSync(join(root, "src", "val.js"), "export function validateOrderV2(x){ return !!x }\n");
  const r = docsSyncReport(root, { base: "HEAD" });
  const stale = r.stale.find((s) => s.file === "README.md");
  assert.ok(stale, `README flagged stale: ${JSON.stringify(r.stale)}`);
  assert.ok(
    stale.hits.some((h) => h.identifier === "validateOrder" && h.line === 3),
    "hit cites the identifier and line",
  );
  const silent = r.unaffected.find((v) => v.file === "SILENT.md");
  assert.ok(silent, "silent doc present in unaffected");
  assert.match(silent.reason, /mentions none/, "verified-unaffected records its reason");
  assert.ok(
    !r.stale.some((s) => /CHANGELOG/.test(s.file)) &&
      !r.unaffected.some((v) => /CHANGELOG/.test(v.file)),
    "append-only history is not swept",
  );
});

test("a doc edited in the same diff reports UPDATED, not STALE", () => {
  const { root } = gitFixture();
  build({ root });
  writeFileSync(join(root, "src", "val.js"), "export function validateOrderV2(x){ return !!x }\n");
  writeFileSync(
    join(root, "README.md"),
    "# app\n\nUse `validateOrderV2` from `src/val.js` to check orders.\n",
  );
  const r = docsSyncReport(root, { base: "HEAD" });
  assert.ok(
    r.updated.some((u) => u.file === "README.md"),
    "doc moved with the change",
  );
  assert.ok(!r.stale.some((s) => s.file === "README.md"));
});

test("docSet EXCLUDES the state snapshot (machine-written bookkeeping, not prose); non-git root yields a clean report", () => {
  const { root } = gitFixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  // handoff writes the changed-file list into state.md BY DESIGN — scanning it would
  // flag the sweep's own bookkeeping as stale, an unfixable self-reference.
  writeFileSync(join(root, ".forge", "state.md"), "# Session state\n\n- M src/val.js\n");
  build({ root });
  assert.ok(!docSet(root).includes(join(".forge", "state.md")));
  writeFileSync(join(root, "src", "val.js"), "export function validateOrderX(x){ return !!x }\n");
  const r0 = docsSyncReport(root, { base: "HEAD" });
  assert.ok(
    !r0.stale.some((s) => s.file.includes("state.md")),
    "state snapshot never reported stale",
  );
  const bare = mkdtempSync(join(tmpdir(), "forge-docsync-"));
  const r = docsSyncReport(bare);
  assert.deepEqual(r.changedFiles, []);
  assert.deepEqual(r.stale, []);
});

test("a renamed symbol stays STALE in a doc that was touched for another reason", () => {
  const { root, commit } = gitFixture();
  build({ root });
  commit("atlas");
  // Rename validateOrder → checkOrder, and touch README's intro WITHOUT fixing the mention.
  writeFileSync(join(root, "src", "val.js"), "export function checkOrder(x){ return !!x }\n");
  writeFileSync(
    join(root, "README.md"),
    "# app (new tagline)\n\nUse `validateOrder` from `src/val.js` to check orders.\n",
  );
  const r = docsSyncReport(root, { base: "HEAD" });
  const stale = r.stale.find((s) => s.file === "README.md");
  assert.ok(stale, `touched README still flagged: ${JSON.stringify(r)}`);
  assert.ok(stale.hits.some((h) => h.identifier === "validateOrder"));
  assert.match(stale.note, /REMOVED/, "the reason names the removed-symbol case");
});

test("lowercase symbols scan only inside backticks (code span = code reference)", () => {
  const { root, commit } = gitFixture();
  writeFileSync(join(root, "MATHDOC.md"), "# math\n\nThe `cusum` detector accumulates drift.\n");
  writeFileSync(
    join(root, "PROSE.md"),
    "# prose\n\nWe check the cusum of the queue in plain words here.\n",
  );
  commit("docs");
  build({ root });
  commit("atlas");
  writeFileSync(join(root, "src", "val.js"), "export function cusum(s){ return s.length }\n");
  const r = docsSyncReport(root, { base: "HEAD" });
  assert.ok(r.soft.includes("cusum"), `cusum is a soft identifier: ${JSON.stringify(r.soft)}`);
  assert.ok(
    r.stale.some((s) => s.file === "MATHDOC.md"),
    "backticked mention flags",
  );
  assert.ok(!r.stale.some((s) => s.file === "PROSE.md"), "plain-prose word does not flag");
});

test("an unknown explicit --base errors instead of silently mislabeling", () => {
  const { root } = gitFixture();
  const r = docsSyncReport(root, { base: "totally-bogus-ref" });
  assert.match(r.error, /unknown base ref/);
  const cli = spawnSync("node", [CLI, "docs", "sync", "--base", "totally-bogus-ref"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(cli.status, 1, "CLI exits 1 on a bad ref");
  assert.match(cli.stdout, /unknown base ref/);
});

test("CLI: docs sync --json reports; --strict exits 1 only when stale docs exist", () => {
  const { root, commit } = gitFixture();
  build({ root });
  commit("atlas artifacts");
  writeFileSync(join(root, "src", "val.js"), "export function validateOrderV3(x){ return !!x }\n");
  const strict = spawnSync("node", [CLI, "docs", "sync", "--strict"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(strict.status, 1, `stale docs fail --strict: ${strict.stdout}`);
  const lax = spawnSync("node", [CLI, "docs", "sync", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(lax.status, 0, "advisory by default");
  const parsed = JSON.parse(lax.stdout);
  assert.ok(parsed.stale.some((s) => s.file === "README.md"));
});
