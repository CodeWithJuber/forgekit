// The optional embeddings tier (ADR-0005): provider resolution, the disk cache,
// graceful degradation to MinHash, and the wire-in to reuse lookup + Eq. 3 retrieval.
// NO network anywhere — the provider is test/fixtures/fake_embed.mjs (deterministic
// hash-based pseudo-vectors that make two designated spec strings close).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CACHE_MAX_BYTES,
  claimSim,
  cosine,
  embed,
  embedCachePath,
  getProvider,
  simLabel,
} from "../src/embed.js";
import { mintClaim, retrieve, score } from "../src/ledger.js";
import { appendEvidence, putClaim, repoLedger } from "../src/ledger_store.js";
import { artifactClaim, lookup, mintArtifact, reuseQuery } from "../src/reuse.js";
import { epochDay } from "../src/util.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake_embed.mjs", import.meta.url));
const fakeCmd = (flags = "") => `cmd:node ${FAKE}${flags ? ` ${flags}` : ""}`;
const tmp = () => mkdtempSync(join(tmpdir(), "forge-embed-"));

/** Run fn with env vars set, restore after (getProvider re-resolves per env value). */
const withEnv = (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const spawnCount = (log) =>
  existsSync(log) ? readFileSync(log, "utf8").split("spawn").length - 1 : 0;

// --- provider resolution ---------------------------------------------------------------

test("getProvider: unset → null (MinHash default); cmd:/http: parsed; unknown scheme → null", () => {
  withEnv({ FORGE_EMBED: undefined }, () => assert.equal(getProvider(), null));
  withEnv({ FORGE_EMBED: "cmd:my-embedder --local" }, () =>
    assert.deepEqual(getProvider(), { kind: "cmd", cmd: "my-embedder --local" }),
  );
  withEnv({ FORGE_EMBED: "http:https://api.example.com/v1/embeddings" }, () =>
    assert.deepEqual(getProvider(), { kind: "http", url: "https://api.example.com/v1/embeddings" }),
  );
  withEnv({ FORGE_EMBED: "https://api.example.com/v1/embeddings" }, () =>
    assert.deepEqual(getProvider(), { kind: "http", url: "https://api.example.com/v1/embeddings" }),
  );
  withEnv({ FORGE_EMBED: "sqlite:whatever" }, () => assert.equal(getProvider(), null));
});

test("cosine: identical → 1, orthogonal → 0, opposite → -1, degenerate → 0 (never NaN)", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 1], [-1, -1]), -1);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

// --- embed + the disk cache --------------------------------------------------------------

test("embed: fake provider returns aligned vectors; cache hit avoids re-spawning", () => {
  const root = tmp();
  const log = join(root, "spawns.log");
  withEnv({ FORGE_EMBED: fakeCmd(), FAKE_EMBED_LOG: log }, () => {
    const v1 = embed(["delete a user account", "write a css toggle"], { root });
    assert.ok(v1);
    assert.equal(v1.length, 2);
    assert.ok(v1.every((v) => Array.isArray(v) && v.length === 32));
    assert.equal(spawnCount(log), 1);
    assert.ok(existsSync(embedCachePath(root)), "vectors persisted to .forge/embed-cache.jsonl");

    // Same texts again: fully served from disk — the provider is NOT re-spawned.
    const v2 = embed(["delete a user account", "write a css toggle"], { root });
    assert.deepEqual(v2, v1);
    assert.equal(spawnCount(log), 1, "cache hit avoided a provider spawn");

    // A new text spawns once more, embedding ONLY the miss.
    const v3 = embed(["delete a user account", "something brand new"], { root });
    assert.deepEqual(v3[0], v1[0]);
    assert.equal(spawnCount(log), 2);
  });
});

test("embed cache: corrupt lines are skipped, oversized file truncates oldest-first", () => {
  const root = tmp();
  withEnv({ FORGE_EMBED: fakeCmd() }, () => {
    embed(["alpha"], { root });
    writeFileSync(embedCachePath(root), "garbage not json\n", { flag: "a" });
    assert.ok(embed(["alpha", "beta"], { root }), "corrupt line tolerated");

    // Blow past the cap; the next append rewrites keeping the newest half.
    writeFileSync(embedCachePath(root), `${"x".repeat(CACHE_MAX_BYTES + 1024)}\n`, { flag: "a" });
    embed(["gamma"], { root });
    const size = readFileSync(embedCachePath(root), "utf8").length;
    assert.ok(size < CACHE_MAX_BYTES, "cache truncated back under the cap");
    assert.ok(embed(["gamma"], { root }), "newest entries survived the truncation");
  });
});

test("embed: no provider → null; crash / garbage / timeout → null (clean, no throw)", () => {
  const root = tmp();
  withEnv({ FORGE_EMBED: undefined }, () => assert.equal(embed(["x"], { root }), null));
  withEnv({ FORGE_EMBED: fakeCmd("--crash") }, () => assert.equal(embed(["x"], { root }), null));
  withEnv({ FORGE_EMBED: fakeCmd("--garbage") }, () => assert.equal(embed(["x"], { root }), null));
  withEnv({ FORGE_EMBED: fakeCmd("--sleep 5000"), FORGE_EMBED_TIMEOUT_MS: "300" }, () =>
    assert.equal(embed(["x"], { root }), null),
  );
});

// --- the load-bearing proof: a near-hit MinHash misses, the provider finds ---------------

// Two short specs, one changed word. MinHash's honest limit: 4 tokens make ONE shingle
// each, the shingles differ, so estimated Jaccard ≈ 0 — far below ADAPT_J.
const STORED = "delete a user account";
const REWORDED = "remove a user account";

const verifiedArtifactRoot = () => {
  const root = tmp();
  const m = mintArtifact(
    repoLedger(root),
    { spec: STORED, code: { path: "src/users.js", sha256: "a".repeat(64) } },
    { evidence: { oracle: "test.run", result: "confirm", ref: "run:1" }, t: 0 },
  );
  assert.equal(m.ok, true);
  return root;
};

test("reuseQuery: short reworded spec — MinHash misses, the embedding provider near-hits", () => {
  const root = verifiedArtifactRoot();

  // Baseline (no provider): the documented weakness — a one-word change is a miss.
  const miss = withEnv({ FORGE_EMBED: undefined }, () => reuseQuery(root, REWORDED, { nowDay: 0 }));
  assert.equal(miss.tier, "miss");
  assert.equal(miss.sim, "minhash");

  // With the provider: same query becomes a near hit above the 0.85 cosine bar.
  const hit = withEnv({ FORGE_EMBED: fakeCmd() }, () => reuseQuery(root, REWORDED, { nowDay: 0 }));
  assert.equal(hit.tier, "near");
  assert.equal(hit.sim, "embed(cmd)");
  assert.equal(hit.simBackend, "embed");
  assert.ok(hit.similarity >= 0.85, `cosine ${hit.similarity} clears NEAR_COS`);
  assert.equal(hit.jaccard, undefined, "jaccard keeps its honest meaning on the embed backend");
});

test("reuseQuery: provider crash/timeout → clean MinHash fallback, zero behavior change", () => {
  const root = verifiedArtifactRoot();
  for (const flags of ["--crash", "--garbage"]) {
    const r = withEnv({ FORGE_EMBED: fakeCmd(flags) }, () =>
      reuseQuery(root, STORED, { nowDay: 0 }),
    );
    assert.equal(r.tier, "exact", `provider ${flags} did not break the lexical path`);
    assert.equal(r.sim, "minhash", "a failed provider is reported as the MinHash backend");
    const miss = withEnv({ FORGE_EMBED: fakeCmd(flags) }, () =>
      reuseQuery(root, REWORDED, { nowDay: 0 }),
    );
    assert.equal(miss.tier, "miss", "no silent half-backend: fallback IS the MinHash result");
  }
});

test("lookup: per-candidate fallback — a candidate with no vector still ranks by Jaccard", () => {
  const LONG =
    "implement a token bucket rate limiter for the public api gateway with configurable " +
    "burst size and sliding window fallback";
  const verified = (spec) => {
    const c = artifactClaim({ spec, code: { path: "src/x.js", sha256: "b".repeat(64) } }, 0).claim;
    c.evidence = [
      {
        oracle: "test.run",
        result: "confirm",
        ref: "run:1",
        author: "ci",
        t: 0,
        w: 0.8,
        h: "d".repeat(64),
      },
    ];
    return c;
  };
  const a = verified(LONG); // vector "missing" → MinHash decides (reworded → near by Jaccard)
  const b = verified("render the marketing landing page hero section"); // embed says adapt-close
  const sim = (_q, c) => (c.id === b.id ? 0.75 : null);
  const r = lookup([a, b], LONG.replace("fallback", "backup"), { nowDay: 0, sim });
  assert.equal(r.tier, "near", "MinHash near beats the embed adapt candidate");
  assert.equal(r.artifact.id, a.id);
  assert.equal(r.simBackend, "minhash");
  assert.ok(r.jaccard >= 0.8);
  // Without the lexical candidate, the embed-scored one serves at the adapt tier.
  const r2 = lookup([b], LONG, { nowDay: 0, sim });
  assert.deepEqual(
    { tier: r2.tier, backend: r2.simBackend, similarity: r2.similarity },
    { tier: "adapt", backend: "embed", similarity: 0.75 },
  );
});

// --- ledger retrieval (Eq. 3) -------------------------------------------------------------

const factClaim = (name, text) => {
  const m = mintClaim({ kind: "fact", body: { name, text }, scope: { level: "repo" }, t: 0 });
  assert.equal(m.ok, true);
  return m.claim;
};

test("score/retrieve: injected sim replaces rel; null and negatives degrade safely", () => {
  const a = factClaim("a", "delete a user account");
  const b = factClaim("b", "configure the linter rules");
  // sim says b is the semantic match — retrieval order flips vs. the lexical default.
  const sim = (_q, c) => (c.body.name === "b" ? 0.95 : 0.1);
  const lex = retrieve("delete a user account", [a, b], { nowDay: 0 });
  assert.equal(lex[0].claim.body.name, "a");
  const sem = retrieve("delete a user account", [a, b], { nowDay: 0, sim });
  assert.equal(sem[0].claim.body.name, "b");
  // Negative cosine clamps to 0 (irrelevant, not anti-relevant): equals rel=0 score.
  const neg = score("q", a, { nowDay: 0, sim: () => -0.9 });
  const zero = score("q", a, { nowDay: 0, sim: () => 0 });
  assert.equal(neg, zero);
  // sim → null falls back to MinHash rel per claim.
  const viaNull = score("delete a user account", a, { nowDay: 0, sim: () => null });
  const viaLex = score("delete a user account", a, { nowDay: 0 });
  assert.equal(viaNull, viaLex);
});

test("claimSim: one provider call covers query+candidates; unset/failure → null", () => {
  const root = tmp();
  const a = factClaim("a", STORED);
  const b = factClaim("b", "unrelated build tooling notes");
  withEnv({ FORGE_EMBED: undefined }, () =>
    assert.equal(
      claimSim(root, REWORDED, [a, b], (c) => c.body.text),
      null,
    ),
  );
  withEnv({ FORGE_EMBED: fakeCmd("--crash") }, () =>
    assert.equal(
      claimSim(root, REWORDED, [a, b], (c) => c.body.text),
      null,
    ),
  );
  withEnv({ FORGE_EMBED: fakeCmd() }, () => {
    const sim = claimSim(root, REWORDED, [a, b], (c) => c.body.text);
    assert.ok(sim);
    assert.ok(sim(REWORDED, a) > 0.85, "designated pair is close");
    assert.ok(sim(REWORDED, b) < 0.7, "unrelated text stays below the adapt bar");
    assert.equal(simLabel(sim), "embed(cmd)");
    assert.equal(simLabel(null), "minhash");
  });
});

// --- CLI: the backend line ------------------------------------------------------------------

test("forge ledger query / reuse query print which similarity backend served", () => {
  const cwd = tmp();
  const dir = repoLedger(cwd);
  const claim = factClaim("users", STORED);
  putClaim(dir, claim);
  appendEvidence(dir, claim.id, {
    oracle: "test.run",
    result: "confirm",
    ref: "run:1",
    t: 0,
    w: 0.8,
    h: "c".repeat(64),
  });
  // The reuse path needs a verified ARTIFACT (specSim only embeds artifact claims);
  // evidence is stamped TODAY because the spawned CLI evaluates val at epochDay().
  const m = mintArtifact(
    dir,
    { spec: STORED, code: { path: "src/users.js", sha256: "e".repeat(64) } },
    { evidence: { oracle: "test.run", result: "confirm", ref: "run:2" }, t: epochDay() },
  );
  assert.equal(m.ok, true);

  const run = (args, env) =>
    spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

  const lex = run(["ledger", "query", REWORDED], { FORGE_EMBED: "" });
  assert.equal(lex.status, 0);
  assert.match(lex.stdout, /sim: minhash/);

  const sem = run(["ledger", "query", REWORDED], { FORGE_EMBED: fakeCmd() });
  assert.equal(sem.status, 0);
  assert.match(sem.stdout, /sim: embed\(cmd\)/);

  const reuse = run(["reuse", "query", REWORDED], { FORGE_EMBED: fakeCmd() });
  assert.equal(reuse.status, 0);
  assert.match(reuse.stdout, /sim: embed\(cmd\)/);
  assert.match(reuse.stdout, /NEAR hit/, "the CLI end-to-end near-hit that MinHash misses");
  const reuseLex = run(["reuse", "query", REWORDED], { FORGE_EMBED: "" });
  assert.match(reuseLex.stdout, /sim: minhash/);
  assert.match(reuseLex.stdout, /miss —/);
});
