import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalize, mintClaim } from "../src/ledger.js";
import { loadClaims, loadState, putClaim } from "../src/ledger_store.js";
import { defaultRun, ledgerSync, stateBytes, syncDir, syncTarget } from "../src/ledger_sync.js";

const tmp = (p = "forge-sync-") => mkdtempSync(join(tmpdir(), p));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A git work-tree with an identity, ready to hold a `.forge/ledger` and talk to a remote. */
function initRepo() {
  const dir = tmp("forge-sync-repo-");
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "user.email", "tester@example.com");
  return dir;
}
function initBare() {
  const dir = tmp("forge-sync-bare-");
  git(dir, "init", "-q", "--bare");
  return dir;
}
/** The ledger dir lives inside the work-tree so ref-mode plumbing runs against it. */
const ledgerOf = (repo) => join(repo, ".forge", "ledger");
const fact = (name, text, t = 0) =>
  mintClaim({
    kind: "fact",
    body: { name, text },
    provenance: { author: "tester" },
    t,
  }).claim;
const mint = (dir, name, text) => putClaim(dir, fact(name, text));

// ── 1. target discovery ────────────────────────────────────────────────────
test("syncTarget: --dir wins over everything", () => {
  const t = syncTarget({
    dirTarget: "/some/dir",
    remote: "origin",
    env: { FORGE_SYNC_DIR: "/x" },
  });
  assert.deepEqual(t, { mode: "dir", dir: "/some/dir" });
});

test("syncTarget: --remote/--ref force ref mode with sensible defaults", () => {
  assert.deepEqual(syncTarget({ remote: "upstream" }), {
    mode: "ref",
    remote: "upstream",
    ref: "refs/forge/ledger",
  });
  assert.deepEqual(syncTarget({ ref: "refs/x" }), {
    mode: "ref",
    remote: "origin",
    ref: "refs/x",
  });
  assert.equal(syncTarget({ personal: true }).ref === "refs/forge/ledger", false);
  assert.equal(syncTarget({ remote: "origin", personal: true }).ref, "refs/forge/ledger-personal");
});

test("syncTarget: a repo git remote → ref mode with the first remote", () => {
  const t = syncTarget({ run: () => "origin\nupstream", env: {} });
  assert.deepEqual(t, {
    mode: "ref",
    remote: "origin",
    ref: "refs/forge/ledger",
  });
});

test("syncTarget: FORGE_SYNC_DIR is the fallback dir target when there is no remote", () => {
  const t = syncTarget({
    run: () => "",
    env: { FORGE_SYNC_DIR: "/shared/ledger" },
  });
  assert.deepEqual(t, { mode: "dir", dir: "/shared/ledger" });
});

test("syncTarget: nothing resolves → honest none (no throw)", () => {
  const t = syncTarget({
    run: () => {
      throw new Error("not a repo");
    },
    env: {},
  });
  assert.equal(t.mode, "none");
  assert.match(t.reason, /no sync target/);
});

// ── 2. dir mode bidirectional convergence ──────────────────────────────────
test("syncDir: bidirectional union → both dirs byte-identical", () => {
  const a = tmp();
  const b = tmp();
  mint(a, "x", "known only to A");
  mint(b, "y", "known only to B");
  const r = syncDir(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "dir");
  const idsA = loadClaims(a)
    .map((c) => c.body.name)
    .sort();
  const idsB = loadClaims(b)
    .map((c) => c.body.name)
    .sort();
  assert.deepEqual(idsA, ["x", "y"]);
  assert.deepEqual(idsB, ["x", "y"]);
  assert.equal(canonicalize(loadState(a)), canonicalize(loadState(b)), "byte-identical state");
});

test("syncDir: missing target degrades honestly (no throw)", () => {
  const a = tmp();
  const r = syncDir(a, join(tmp(), "does-not-exist"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no sync directory/);
});

// ── 3. ref-mode two-repo convergence ───────────────────────────────────────
test("ref sync: two repos converge to byte-identical state through a git ref", () => {
  const bare = initBare();
  const repoA = initRepo();
  const repoB = initRepo();
  git(repoA, "remote", "add", "origin", bare);
  git(repoB, "remote", "add", "origin", bare);
  mint(ledgerOf(repoA), "x", "from A");
  mint(ledgerOf(repoB), "y", "from B");

  const r1 = ledgerSync({ dir: ledgerOf(repoA), root: repoA });
  assert.equal(r1.ok, true);
  assert.equal(r1.mode, "ref");
  assert.equal(r1.pushed, true);

  const r2 = ledgerSync({ dir: ledgerOf(repoB), root: repoB });
  assert.equal(r2.ok, true);
  assert.equal(r2.pulled.claims, 1, "B pulled A's claim");
  assert.equal(r2.pushed, true);

  const r3 = ledgerSync({ dir: ledgerOf(repoA), root: repoA });
  assert.equal(r3.ok, true);
  assert.equal(r3.pulled.claims, 1, "A pulled B's claim on the second round");

  assert.equal(
    canonicalize(loadState(ledgerOf(repoA))),
    canonicalize(loadState(ledgerOf(repoB))),
    "convergent state",
  );
  const treeA = git(repoA, "rev-parse", "refs/forge/ledger^{tree}");
  const treeB = git(repoB, "rev-parse", "refs/forge/ledger^{tree}");
  assert.equal(treeA, treeB, "identical state.json tree in both clones");
});

// ── 4. idempotence ─────────────────────────────────────────────────────────
test("ref sync: an immediate re-run is a byte-level no-op", () => {
  const bare = initBare();
  const repo = initRepo();
  git(repo, "remote", "add", "origin", bare);
  mint(ledgerOf(repo), "x", "only claim");
  assert.equal(ledgerSync({ dir: ledgerOf(repo), root: repo }).pushed, true);
  const sha1 = git(repo, "rev-parse", "refs/forge/ledger");

  const again = ledgerSync({ dir: ledgerOf(repo), root: repo });
  assert.equal(again.ok, true);
  assert.equal(again.upToDate, true);
  assert.equal(again.pushed, false);
  assert.equal(again.pulled.claims, 0);
  assert.equal(git(repo, "rev-parse", "refs/forge/ledger"), sha1, "ref SHA unchanged");
});

// ── 5. race retry (monotone) ───────────────────────────────────────────────
test("ref sync: a non-fast-forward race re-merges and retries, losing nothing", () => {
  const bare = initBare();
  const repoA = initRepo();
  const repoB = initRepo();
  git(repoA, "remote", "add", "origin", bare);
  git(repoB, "remote", "add", "origin", bare);
  mint(ledgerOf(repoA), "x", "from A");
  mint(ledgerOf(repoB), "y", "from B");

  let injected = false;
  const racyRun = (args, opts) => {
    if (!injected && args[0] === "push") {
      injected = true;
      // A concurrent writer (repoB) lands on the ref first → A's push must reject.
      ledgerSync({
        dir: ledgerOf(repoB),
        root: repoB,
        remote: "origin",
        run: defaultRun,
      });
    }
    return defaultRun(args, opts);
  };

  const r = ledgerSync({
    dir: ledgerOf(repoA),
    root: repoA,
    remote: "origin",
    run: racyRun,
  });
  assert.equal(r.ok, true, "the race is resolved, not fatal");
  assert.equal(r.retries, 1);
  assert.equal(r.pushed, true);
  // Nothing lost: A now holds both claims and the remote reflects the union.
  const names = loadClaims(ledgerOf(repoA))
    .map((c) => c.body.name)
    .sort();
  assert.deepEqual(names, ["x", "y"]);
});

// ── 6. honesty / fail-open ─────────────────────────────────────────────────
test("ref sync: not a git repo → honest reason (no throw)", () => {
  const dir = tmp();
  const r = ledgerSync({ dir, root: dir, remote: "origin" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a git repository/);
});

test("ref sync: unknown remote → honest reason", () => {
  const repo = initRepo();
  const r = ledgerSync({ dir: ledgerOf(repo), root: repo, remote: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no such git remote/);
});

test("ref sync: a fetch failure (offline) fails open", () => {
  const repo = initRepo();
  const bare = initBare();
  git(repo, "remote", "add", "origin", bare);
  const offlineRun = (args, opts) => {
    if (args[0] === "fetch")
      throw Object.assign(new Error("boom"), { stderr: "network unreachable" });
    return defaultRun(args, opts);
  };
  const r = ledgerSync({
    dir: ledgerOf(repo),
    root: repo,
    remote: "origin",
    run: offlineRun,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fetch failed/);
});

test("ref sync: a corrupt remote state blob degrades to empty + note, push proceeds", () => {
  const bare = initBare();
  const repo = initRepo();
  git(repo, "remote", "add", "origin", bare);
  // Plant a garbage state.json on the ref (a concurrent writer's corruption).
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: "not json {{{",
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["mktree"], {
    cwd: repo,
    input: `100644 blob ${blob}\tstate.json\n`,
    encoding: "utf8",
  }).trim();
  const commit = git(repo, "commit-tree", tree, "-m", "garbage");
  git(repo, "update-ref", "refs/forge/ledger", commit);
  git(repo, "push", "origin", "refs/forge/ledger:refs/forge/ledger");

  mint(ledgerOf(repo), "x", "still fine");
  const r = ledgerSync({ dir: ledgerOf(repo), root: repo, remote: "origin" });
  assert.equal(r.ok, true);
  assert.equal(r.pulled.claims, 0);
  assert.ok(
    r.notes.some((n) => /unreadable/.test(n)),
    "corruption is noted",
  );
  assert.equal(loadClaims(ledgerOf(repo)).length, 1, "local claim survived");
});

// ── 7. --personal recall portability ───────────────────────────────────────
test("--personal: recall-shadowed facts ride the CRDT pipe across stores", async () => {
  const { shadowFact } = await import("../src/ledger_bridge.js");
  const { ledgerFacts } = await import("../src/ledger_read.js");
  // Two "machines": each has its own personal store with a ledger sibling dir.
  const storeA = tmp("forge-sync-storeA-");
  const storeB = tmp("forge-sync-storeB-");
  const ledgerA = join(storeA, "ledger");
  const ledgerB = join(storeB, "ledger");
  shadowFact(ledgerA, "laptop path", "~/dev on the laptop", 1);
  shadowFact(ledgerB, "desktop path", "~/work on the desktop", 1);

  const r = syncDir(ledgerA, ledgerB);
  assert.equal(r.ok, true);
  const namesFromB = ledgerFacts(ledgerB)
    .map((f) => f.name)
    .sort();
  assert.deepEqual(namesFromB, ["desktop path", "laptop path"], "A's personal fact reached B");
});

// stateBytes is the canonical payload — deterministic across an idempotent reload.
test("stateBytes: deterministic and newline-terminated", () => {
  const a = tmp();
  mint(a, "x", "y");
  assert.equal(stateBytes(a), stateBytes(a));
  assert.ok(stateBytes(a).endsWith("\n"));
});
