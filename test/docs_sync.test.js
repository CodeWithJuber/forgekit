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

test("docSet includes the state snapshot when present; non-git root yields a clean report", () => {
  const { root } = gitFixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "state.md"), "# Session state\n\nmentions src/val.js\n");
  build({ root });
  assert.ok(docSet(root).includes(join(".forge", "state.md")));
  const bare = mkdtempSync(join(tmpdir(), "forge-docsync-"));
  const r = docsSyncReport(bare);
  assert.deepEqual(r.changedFiles, []);
  assert.deepEqual(r.stale, []);
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
