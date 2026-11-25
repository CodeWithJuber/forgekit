import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brainStore, remember } from "../src/brain.js";
import { factClaim } from "../src/ledger_bridge.js";
import { migrateLegacy, restoreLegacy } from "../src/ledger_migration.js";
import { mergedLessons } from "../src/ledger_read.js";
import {
  loadClaims,
  pruneToAttic,
  putClaim,
  repoLedger,
  tombstone,
  verify,
} from "../src/ledger_store.js";
import { newLesson } from "../src/lessons.js";
import { serialize } from "../src/lessons_store.js";
import { defaultStore, readFact } from "../src/recall.js";
import { fakeGithubPat } from "./_fixtures.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "forge-memory-upgrade-"));
  const root = join(base, "checkout"),
    home = join(base, "private");
  mkdirSync(root);
  const prior = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prior;
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, home };
}
function putFile(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
const factPath = ".forge/brain/facts/fact.md";
const oldFact = "# 目录\r\n\r\nOriginal catalogue  \r\n";
const lessonPath = ".forge/lessons/lsn_compute.md";
const lesson = {
  ...newLesson(
    {
      id: "lsn_compute",
      trigger: { symbols: ["compute"] },
      whatWentWrong: "Compute changed",
      correctedBehavior: "Check its callers",
      provenance: { episodes: ["episode-a"], signals: ["S1"] },
    },
    10,
  ),
  evidenceCount: 3,
  contradictionCount: 1,
  lastConfirmedDay: 20,
  status: "active",
};

test("migrate imports original bytes once, records historical evidence, and restores any backup into a fresh directory", (t) => {
  const { base, root } = fixture(t);
  const raw = serialize(lesson).replaceAll("\n", "\r\n");
  putFile(root, factPath, oldFact);
  putFile(root, lessonPath, raw);
  const first = migrateLegacy(root);
  assert.deepEqual([first.lessons, first.facts, first.outcomes, first.verified], [1, 1, 4, true]);
  assert.deepEqual(readFact(brainStore(root), "目录"), {
    name: "目录",
    text: "Original catalogue",
  });
  const imported = mergedLessons(root, 20)[0];
  assert.deepEqual(
    [imported.evidenceCount, imported.contradictionCount, imported.provenance.episodes],
    [3, 1, ["episode-a"]],
  );
  assert.deepEqual(readFileSync(join(root, lessonPath), "utf8"), raw);
  const repeated = migrateLegacy(root);
  assert.deepEqual(
    [repeated.lessons, repeated.facts, repeated.outcomes, repeated.snapshot],
    [0, 0, 0, first.snapshot],
  );
  putFile(root, factPath, "# 目录\n\nLater file edit\n");
  const later = migrateLegacy(root);
  assert.notEqual(later.snapshot, first.snapshot);
  assert.equal(later.facts, 0);
  assert.equal(readFact(brainStore(root), "目录").text, "Original catalogue");
  const dest = join(base, "restore");
  assert.equal(restoreLegacy(root, dest, { snapshot: first.snapshot }).verified, true);
  assert.equal(readFileSync(join(dest, factPath), "utf8"), oldFact);
  assert.equal(readFileSync(join(dest, lessonPath), "utf8"), raw);
  assert.throws(() => restoreLegacy(root, dest), /EEXIST/);
  assert.equal(verify(repoLedger(root)).ok, true);
});

test("same-name facts in one legacy snapshot retain the first sorted source and normal recall", (t) => {
  const { root, base } = fixture(t);
  const first = ".forge/brain/facts/first.md";
  const second = ".forge/brain/facts/second.md";
  putFile(root, second, "# Shared setting\n\nSecond value\n");
  putFile(root, first, "# Shared setting\n\nFirst value\n");
  const migrated = JSON.parse(
    execFileSync(process.execPath, [cli, "ledger", "migrate", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert.deepEqual([migrated.facts, migrated.retained, migrated.verified], [1, 1, true]);
  assert.equal(readFact(brainStore(root), "shared-setting").text, "First value");
  assert.equal(loadClaims(repoLedger(root)).filter((c) => c.kind === "fact").length, 1);
  const retry = migrateLegacy(root);
  assert.deepEqual([retry.facts, retry.retained], [0, 2]);
  const restore = join(base, "copies");
  restoreLegacy(root, restore, { snapshot: migrated.snapshot });
  assert.equal(
    readFileSync(join(restore, second), "utf8"),
    readFileSync(join(root, second), "utf8"),
  );
});

test("a pre-existing newer, retired or archived fact stays authoritative through migration", (t) => {
  const { root } = fixture(t);
  const store = brainStore(root),
    ledger = repoLedger(root);
  for (const name of ["newer", "retired", "archived"])
    putFile(root, `.forge/brain/facts/${name}.md`, `# ${name}\n\nold file\n`);
  remember(store, "newer", "Current value");
  for (const name of ["retired", "archived"]) {
    const c = factClaim(name, "some prior text").claim;
    putClaim(ledger, c);
    if (name === "retired") tombstone(ledger, c.id, { reason: "outdated", t: 3 });
    else pruneToAttic(ledger, c.id);
  }
  const result = migrateLegacy(root);
  assert.deepEqual([result.facts, result.retained], [0, 3]);
  assert.equal(readFact(store, "newer").text, "Current value");
  assert.equal(readFact(store, "retired"), null);
  assert.equal(readFact(store, "archived"), null);
});

test("a retry completes only this migration's missing provenance and evidence", (t) => {
  const { root } = fixture(t);
  putFile(root, lessonPath, serialize(lesson));
  migrateLegacy(root);
  const ledger = repoLedger(root),
    id = loadClaims(ledger)[0].id;
  // Model an interruption just after publishing immutable claim bytes.
  rmSync(join(ledger, "evidence", `${id}.log`));
  rmSync(join(ledger, "provenance", `${id}.log`));
  const completed = migrateLegacy(root);
  assert.equal(completed.outcomes, 4);
  assert.equal(migrateLegacy(root).outcomes, 0);
  assert.equal(loadClaims(ledger)[0].evidence.length, 4);
});

test("personal and repo migration and restore are independently scoped", (t) => {
  const { root, base } = fixture(t);
  putFile(defaultStore(), "facts/home.md", "# Home\n\nPersonal fact\n");
  putFile(root, factPath, oldFact);
  const personal = migrateLegacy(root, { personal: true });
  const repo = migrateLegacy(root);
  assert.notEqual(repo.snapshot, personal.snapshot);
  assert.equal(readFact(defaultStore(), "home").text, "Personal fact");
  assert.equal(readFact(brainStore(root), "home"), null);
  assert.throws(
    () => restoreLegacy(root, join(base, "wrong"), { snapshot: personal.snapshot }),
    /ENOENT/,
  );
  const other = join(base, "another-checkout");
  mkdirSync(other);
  assert.throws(() => restoreLegacy(other, join(base, "foreign")), /ENOENT/);
  const out = join(base, "personal-copy");
  restoreLegacy(other, out, { personal: true });
  assert.deepEqual(readdirSync(out), ["facts"]);
  assert.equal(readFileSync(join(out, "facts", "home.md"), "utf8"), "# Home\n\nPersonal fact\n");
});

test("historical malformed or sensitive sources stop migration before storing any records", (t) => {
  const { root, base } = fixture(t);
  putFile(root, factPath, oldFact);
  const source = putFile(root, lessonPath, "incomplete");
  assert.throws(() => migrateLegacy(root), /invalid lesson file/);
  assert.equal(existsSync(repoLedger(root)), false);
  writeFileSync(source, serialize({ ...lesson, correctedBehavior: fakeGithubPat() }));
  assert.throws(() => migrateLegacy(root), /credential/);
  assert.throws(() => restoreLegacy(root, join(base, "copy")), /ENOENT/);
});

test("concurrent migrate and import CLI invocations converge on one backup and one evidence set", async (t) => {
  const { root, base } = fixture(t);
  putFile(root, lessonPath, serialize(lesson));
  const run = (args) =>
    promisify(execFile)(process.execPath, [cli, "ledger", ...args, "--json"], { cwd: root });
  const [a, b] = await Promise.all([run(["migrate"]), run(["import"])]);
  const results = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
  assert.equal(results[0].snapshot, results[1].snapshot);
  assert.equal(
    results.reduce((n, r) => n + r.lessons, 0),
    1,
  );
  assert.equal(
    results.reduce((n, r) => n + r.outcomes, 0),
    4,
  );
  const retrieved = JSON.parse((await run(["query", "compute"])).stdout);
  assert.equal(retrieved.ranking, "empirical-midranks-v2");
  assert.equal(retrieved.results[0].id, loadClaims(repoLedger(root))[0].id);
  const restored = await run([
    "restore-legacy",
    join(base, "restored"),
    "--snapshot",
    results[0].snapshot,
  ]);
  assert.equal(JSON.parse(restored.stdout).verified, true);
});

test("a damaged private snapshot is detected before creating a restore destination", (t) => {
  const { base, root, home } = fixture(t);
  putFile(root, factPath, oldFact);
  const { snapshot } = migrateLegacy(root);
  const state = join(home, "ledger-migrations-v1");
  const [key] = readdirSync(state);
  const copy = join(state, key, `${snapshot}.json`);
  writeFileSync(copy, `${readFileSync(copy, "utf8")} `);
  const dest = join(base, "damaged-copy");
  assert.throws(() => restoreLegacy(root, dest), /hash mismatch/);
  assert.equal(existsSync(dest), false);
});
