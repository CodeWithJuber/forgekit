import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FALLBACK_HOME,
  factName,
  HOME_EXEMPLARS,
  HOMES,
  routeFact,
  storeFact,
} from "../src/knowledge_router.js";
import { loadClaims, repoLedger } from "../src/ledger_store.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("routeFact: every home recognized from unseen phrasings (per-family routing)", () => {
  assert.equal(routeFact("always run the linter before committing changes").home, "claude-md");
  assert.equal(routeFact("never push directly to the release branch").home, "rule");
  assert.equal(routeFact("how to restore the production database from backup").home, "skill");
  assert.equal(routeFact("next step is to finish pagination in the export endpoint").home, "state");
  assert.equal(
    routeFact("we chose redis over rabbitmq because it is already deployed").home,
    "decision",
  );
  assert.equal(routeFact("the api gateway times out after 30 seconds").home, "ledger-fact");
  assert.equal(routeFact("i prefer detailed commit messages").home, "recall");
});

test("routeFact: TOTAL (T6) — 100 arbitrary strings all land in a real home", () => {
  // Deterministic LCG so the fuzz corpus is reproducible run-to-run.
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const alphabets = [
    "abcdefghijklmnopqrstuvwxyz ",
    "0123456789 -_/",
    "日本語テキスト漢字 ",
    "🎉🚀💥🔥 ",
    "{}[]()<>!?#$%^&* ",
  ];
  const corpus = ["", "   ", "???", "a", "\n\t"];
  while (corpus.length < 100) {
    const alpha = alphabets[Math.floor(rnd() * alphabets.length)];
    const len = Math.floor(rnd() * 80);
    let s = "";
    for (let i = 0; i < len; i++) s += alpha[Math.floor(rnd() * alpha.length)];
    corpus.push(s);
  }
  for (const s of corpus) {
    const r = routeFact(s);
    assert.ok(r.home in HOMES, `"${s.slice(0, 30)}" routed to unknown home ${r.home}`);
    assert.ok(["knn", "fallback"].includes(r.provenance));
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
});

test("routeFact: below the gate → the ledger fallback with provenance, never 'none'", () => {
  const r = routeFact("zzz qqq xyzzy plugh");
  assert.equal(r.home, FALLBACK_HOME);
  assert.equal(r.provenance, "fallback");
  const hi = routeFact("we chose sqlite over postgres because zero ops");
  assert.equal(hi.provenance, "knn");
  assert.ok(hi.neighbors.length > 0 && hi.neighbors[0].sim >= hi.confidence - 1e-9);
});

test("HOMES/exemplars: every exemplar row labels a real home; bank covers all homes", () => {
  const labeled = new Set(HOME_EXEMPLARS.map((e) => e.home));
  for (const h of labeled) assert.ok(h in HOMES, `exemplar home ${h} not in HOMES`);
  for (const h of Object.keys(HOMES)) assert.ok(labeled.has(h), `home ${h} has no exemplars`);
  assert.ok(HOMES[FALLBACK_HOME].write === "auto", "fallback home must be writable (totality)");
});

test("storeFact: dry-run (mode advise) never writes, whatever the home", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-know-"));
  for (const text of [
    "we chose sqlite over postgres because zero ops",
    "the api rate limit is 100 requests per minute",
    "zzz qqq xyzzy plugh",
  ]) {
    const r = storeFact(root, text, { mode: "advise" });
    assert.equal(r.ok, true);
    assert.equal(r.stored, false);
    assert.ok(r.advice, "advise mode explains where the fact belongs");
  }
  assert.ok(!existsSync(join(root, ".forge")), "dry-run created .forge/");
});

test("storeFact: advise-only homes (files) get advice, no write — even in auto mode", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-know-"));
  const r = storeFact(root, "next step is to finish pagination in the export endpoint");
  assert.equal(r.home, "state");
  assert.equal(r.stored, false);
  assert.match(r.advice ?? "", /handoff/);
  assert.ok(!existsSync(join(root, ".forge")));
});

test("storeFact: secret refusal — routed but never stored, nothing touches disk", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-know-"));
  const r = storeFact(root, "we chose this api_key=sk-abcdefghijklmnopqrstuvwx for staging");
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.stored, false);
  assert.ok(!existsSync(join(root, ".forge")), "a refused secret still wrote something");
});

test("storeFact: decision home appends the ADR-lite line", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-know-"));
  const r = storeFact(root, "we chose sqlite over postgres because zero ops");
  assert.equal(r.ok, true);
  assert.equal(r.home, "decision");
  assert.equal(r.stored, true);
  assert.equal(r.ref, "D-0001");
  const log = readFileSync(join(root, ".forge", "decisions.md"), "utf8");
  assert.match(log, /\*\*D-0001\*\*.*we chose sqlite over postgres because zero ops/);
});

test("storeFact: ledger-fact home (and the T6 fallback) mint a fact claim", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-know-"));
  const fact = storeFact(root, "the api rate limit is 100 requests per minute");
  assert.equal(fact.home, "ledger-fact");
  assert.equal(fact.stored, true);
  const fb = storeFact(root, "zzz qqq xyzzy plugh");
  assert.equal(fb.home, "ledger-fact");
  assert.equal(fb.stored, true);
  const claims = loadClaims(repoLedger(root));
  const bodies = claims.filter((c) => c.kind === "fact").map((c) => c.body?.text);
  assert.ok(bodies.includes("the api rate limit is 100 requests per minute"));
  assert.ok(bodies.includes("zzz qqq xyzzy plugh"));
});

test("storeFact: recall home writes the personal store (FORGE_HOME-scoped)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-know-"));
  const home = mkdtempSync(join(tmpdir(), "forge-know-home-"));
  process.env.FORGE_HOME = home;
  try {
    const r = storeFact(root, "i prefer detailed commit messages");
    assert.equal(r.home, "recall");
    assert.equal(r.stored, true);
    const slugged = factName("i prefer detailed commit messages");
    assert.ok(existsSync(join(home, "recall", "facts", `${slugged}.md`)));
    assert.ok(!existsSync(join(root, ".forge")), "recall must not touch the repo ledger");
  } finally {
    delete process.env.FORGE_HOME;
  }
});

test("factName: short stable slug, never empty", () => {
  assert.equal(
    factName("The API rate limit is 100 requests per minute"),
    "the-api-rate-limit-is-100",
  );
  assert.equal(factName("???"), "fact");
});

test("cli: forge know --dry-run --json routes without writing", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-know-"));
  const p = spawnSync(
    "node",
    [CLI, "know", "we chose sqlite because zero dependencies", "--dry-run", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(p.status, 0, p.stderr);
  const out = JSON.parse(p.stdout);
  assert.equal(out.home, "decision");
  assert.equal(out.dryRun, true);
  assert.equal(out.stored, false);
  assert.ok(!existsSync(join(root, ".forge")), "--dry-run wrote to disk");
  const empty = spawnSync("node", [CLI, "know"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(empty.status, 1, "bare know without a fact must usage-error");
});
