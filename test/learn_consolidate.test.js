// A13 (research-to-code audit): bin/learn-consolidate.sh asked a model to "DROP anything …
// contradicted" and rewrote the learned-lessons store from its answer — memory pruned by the
// model's own judgment, which the research rejects. Consolidation is now deterministic:
// duplicates merge, and a lesson is dropped only when the ledger refutes it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONSOLIDATE_TAU,
  consolidateDir,
  consolidateLearned,
  learnedDir,
  ledgerClaimsFor,
  parseLearned,
  renderConsolidated,
} from "../src/learn_consolidate.js";
import { isDormant, jaccard, mintClaim, outcomeRecord, sketch } from "../src/ledger.js";
import {
  appendEvidence,
  loadClaims,
  pruneToAttic,
  putClaim,
  repoLedger,
  tombstone,
} from "../src/ledger_store.js";

const SCRIPT = fileURLToPath(new URL("../bin/learn-consolidate.sh", import.meta.url));
const tmp = (p = "forge-learn-") => mkdtempSync(join(tmpdir(), p));

const FLAKY = "Run the db migration before the integration tests or they fail with a missing table";
const TRIVIA = "The staging deploy needs VPN access from the office network first";
const RETRY = "The HTTP client retries three times with exponential backoff before giving up";

/** A repo named `name` whose ledger holds `text` as a lesson claim, optionally refuted. */
function repoWith(name, text, { refute = false, retract = false } = {}) {
  const root = join(tmp(), name);
  mkdirSync(root, { recursive: true });
  const dir = repoLedger(root);
  const minted = mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: text,
      trigger: { action: "edit", files: [], keywords: [], symbols: [] },
      whatWentWrong: "",
    },
    scope: { level: "repo" },
    provenance: { agent: "cortex", author: "t", task: `lsn_${name}` },
    t: 100,
  });
  assert.equal(minted.ok, true);
  assert.equal(putClaim(dir, minted.claim).ok, true);
  if (refute)
    for (const ref of ["human:alice@shop-review", "human:bob@shop-review"]) {
      const o = outcomeRecord({ oracle: "human.revert", result: "contradict", ref, t: 101 });
      assert.equal(o.ok, true);
      assert.equal(appendEvidence(dir, minted.claim.id, o.outcome).ok, true);
    }
  if (retract) tombstone(dir, minted.claim.id, { author: "t", reason: "wrong", t: 101 });
  return { root, claim: minted.claim };
}

test("parseLearned reads the session-learner and consolidated shapes", () => {
  const entries = parseLearned(
    [
      "# Learned — consolidated 2026-09-01",
      "",
      "## General",
      `- ${TRIVIA}`,
      "## 2026-09-10 14:02 — shop",
      `- ${FLAKY}`,
      "  (seen twice)",
      "* use pnpm, not npm",
    ].join("\n"),
  );
  assert.deepEqual(entries, [
    { project: "General", text: TRIVIA },
    { project: "shop", text: `${FLAKY} (seen twice)` },
    { project: "shop", text: "use pnpm, not npm" },
  ]);
});

test("exact duplicates merge; near-duplicates are kept and proposed; nothing dropped without evidence", () => {
  const ALWAYS = FLAKY.replace("Run", "Always run");
  const r = consolidateLearned(
    [
      { project: "shop", text: FLAKY },
      { project: "shop", text: `${FLAKY}.` }, // exact: one trailing sentence period only
      { project: "shop", text: `  ${FLAKY} ` }, // exact: the text's own edge whitespace
      // review N02 round 2: whitespace INSIDE a statement is never folded (a double space
      // can be data) — a near-duplicate, kept and reported, never merged
      { project: "shop", text: FLAKY.replace(" before", "   before") },
      { project: "shop", text: ALWAYS }, // near-duplicate — review N02: proposed, not merged
      { project: "blog", text: FLAKY }, // another project keeps its own copy
      { project: "shop", text: TRIVIA }, // "trivial" is not a reason to delete
    ],
    { claims: [] },
  );
  const SPACED = FLAKY.replace(" before", "   before");
  assert.deepEqual(
    r.kept.map((k) => `${k.project}: ${k.text}`),
    [`shop: ${FLAKY}`, `shop: ${SPACED}`, `shop: ${ALWAYS}`, `blog: ${FLAKY}`, `shop: ${TRIVIA}`],
  );
  assert.equal(r.merged.length, 2);
  assert.deepEqual(
    r.proposed.map((p) => [p.text, p.similar]),
    [[ALWAYS, FLAKY]],
  );
  assert.deepEqual(
    r.conflicts.map((c) => [c.text, c.other, c.conflicts.split(":")[0]]),
    [
      [SPACED, FLAKY, "layout"],
      [ALWAYS, SPACED, "layout"],
    ],
    "the spaced copy differs in layout from both",
  );
  assert.equal(r.dropped.length, 0, "no claim matched, so nothing is refuted");
});

// Review N02: a token-level guard cannot see WHICH action applies to WHICH subject. These pairs
// share every behaviour-bearing token (polarity words included) and mean different things.
// Each shares a long instruction tail, so it clears the similarity threshold the old
// consolidation merged at (asserted below) — similarity alone must never collapse them.
const TAIL =
  " for every incoming webhook request before processing the payload or allowing the request to access any internal application service or write changes to durable storage in the production environment";
const WEBHOOK = ` access${TAIL}`;
const SWAPS = [
  // the review's counterexample: a permission subject/action swap
  [`Allow admins and deny guests${WEBHOOK}`, `Deny admins and allow guests${WEBHOOK}`],
  // source/destination
  [
    `Copy snapshots from staging to archive${TAIL}`,
    `Copy snapshots from archive to staging${TAIL}`,
  ],
  // swapped numeric bindings
  [
    `Use a 5s read timeout and 30s write timeout${TAIL}`,
    `Use a 30s read timeout and 5s write timeout${TAIL}`,
  ],
  // moved negation scope
  [
    `Do not retry payments and log declines${TAIL}`,
    `Retry payments and do not log declines${TAIL}`,
  ],
];
const similarity = (a, b) => jaccard(sketch(a), sketch(b));

test("N02: role, direction, number and negation-scope swaps are never merged", () => {
  for (const [a, b] of SWAPS) {
    assert.ok(similarity(a, b) >= CONSOLIDATE_TAU, `precondition — near-duplicates: ${a}`);
    const r = consolidateLearned(
      [
        { project: "ops", text: a },
        { project: "ops", text: b },
      ],
      { claims: [] },
    );
    assert.deepEqual(
      r.kept.map((k) => k.text),
      [a, b],
      `both rules survive: ${a.slice(0, 44)}…`,
    );
    assert.equal(r.merged.length, 0);
    assert.equal(r.proposed.length + r.conflicts.length, 1, "the pair is surfaced for review");
  }
});

test("N02: true paraphrases are PROPOSED for merging (recommendation), never merged unseen", () => {
  const PARAPHRASES = [
    [`Validate the signature header${TAIL}`, `Always validate the signature header${TAIL}`],
    [`Check the request signature${TAIL}`, `Check the request's signature${TAIL}`],
  ];
  for (const [a, b] of PARAPHRASES) {
    assert.ok(similarity(a, b) >= CONSOLIDATE_TAU, `precondition — near-duplicates: ${b}`);
    const r = consolidateLearned(
      [
        { project: "ops", text: a },
        { project: "ops", text: b },
      ],
      { claims: [] },
    );
    assert.equal(r.kept.length, 2);
    assert.deepEqual(
      r.proposed.map((p) => p.text),
      [b],
      `recommended for review: ${b.slice(0, 44)}…`,
    );
  }
});

test("N02: whitespace inside a literal is not a duplicate's whitespace", () => {
  const r = consolidateLearned(
    [
      { project: "ops", text: 'Join the CSV fields with the separator "a  b" in every export' },
      { project: "ops", text: 'Join the CSV fields with the separator "a b" in every export' },
    ],
    { claims: [] },
  );
  assert.equal(r.kept.length, 2);
  assert.equal(r.merged.length, 0);
  assert.match(r.conflicts[0]?.conflicts ?? "", /literals/);
});

test("N02: a refuted SIMILAR claim never drops a lesson — it is kept and flagged", () => {
  const [allow, deny] = SWAPS[0];
  const refuted = repoWith("shop", allow, { refute: true });
  const r = consolidateLearned([{ project: "shop", text: deny }], {
    claims: ledgerClaimsFor([refuted.root]),
    nowDay: 102,
  });
  assert.deepEqual(
    r.kept.map((k) => k.text),
    [deny],
  );
  assert.equal(r.dropped.length, 0);
  assert.equal(r.flagged.length, 1);
  assert.match(r.flagged[0].reason, /may be the opposite rule/);
});

test("a lesson is dropped only when its matching ledger claim is dormant or retracted", () => {
  const refuted = repoWith("shop", FLAKY, { refute: true });
  assert.ok(isDormant(ledgerClaimsFor([refuted.root])[0], 102), "fixture claim is dormant");
  const confirmedish = repoWith("shop", RETRY); // live, never refuted
  const retracted = repoWith("shop", TRIVIA, { retract: true });
  const claims = ledgerClaimsFor([refuted.root, confirmedish.root, retracted.root]);
  const r = consolidateLearned(
    [
      { project: "shop", text: FLAKY },
      { project: "shop", text: RETRY },
      { project: "shop", text: TRIVIA },
      { project: "shop", text: "an unrelated lesson the ledger knows nothing about" },
    ],
    { claims, nowDay: 102 },
  );
  assert.deepEqual(
    r.kept.map((k) => k.text),
    [RETRY, "an unrelated lesson the ledger knows nothing about"],
  );
  assert.deepEqual(
    r.dropped.map((d) => d.reason),
    ["dormant in the ledger (oracle evidence refuted it)", "retracted in the ledger"],
  );
  assert.equal(r.dropped[0].claim, refuted.claim.id.slice(0, 12), "the drop cites its claim");
});

test("ledger evidence is scoped to its project", () => {
  const refutedElsewhere = repoWith("blog", FLAKY, { refute: true });
  const r = consolidateLearned([{ project: "shop", text: FLAKY }], {
    claims: ledgerClaimsFor([refutedElsewhere.root]),
    nowDay: 102,
  });
  assert.equal(r.kept.length, 1, "refuted in blog does not drop it from shop");
});

test("renderConsolidated groups by project, General first", () => {
  const md = renderConsolidated(
    [
      { project: "shop", text: "a" },
      { project: "General", text: "b" },
      { project: "shop", text: "c" },
    ],
    { date: "2026-09-22" },
  );
  assert.equal(md, "# Learned — consolidated 2026-09-22\n\n## General\n- b\n\n## shop\n- a\n- c\n");
});

test("consolidateDir archives originals, rewrites CONSOLIDATED.md, removes monthly files", () => {
  const dir = tmp();
  writeFileSync(
    join(dir, "lessons-2026-09.md"),
    `\n## 2026-09-10 14:02 — shop\n- ${FLAKY}\n- ${FLAKY}\n`,
  );
  const dry = consolidateDir({ dir, dryRun: true });
  assert.equal(dry.row, "dry-run");
  assert.ok(existsSync(join(dir, "lessons-2026-09.md")), "a dry run writes nothing");
  const r = consolidateDir({ dir, date: "2026-09-22" });
  assert.equal(r.kept.length, 1);
  assert.equal(
    readFileSync(join(dir, "CONSOLIDATED.md"), "utf8"),
    `# Learned — consolidated 2026-09-22\n\n## shop\n- ${FLAKY}\n`,
  );
  assert.ok(!existsSync(join(dir, "lessons-2026-09.md")));
  assert.equal(readdirSync(join(dir, "archive")).length, 1, "the original is archived");
  assert.equal(consolidateDir({ dir: tmp() }).row, "nothing");
});

// The bash learner writes under $HOME; on Windows node's homedir() reads USERPROFILE, so the
// consolidator read a different folder whenever Git Bash's HOME differed from it.
test("learnedDir follows HOME, the folder the bash session learner writes to", () => {
  const saved = process.env.HOME;
  const home = tmp("forge-learn-homevar-");
  try {
    process.env.HOME = home;
    assert.equal(learnedDir(), join(home, ".claude", "skills", "learned"));
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});

// A STUB `claude` sits first on PATH, so no real model is ever called from the suite: the
// default path must never invoke it, and the opt-in `--llm` path reaches the stub only.
test("the script runs deterministically with no model call; --llm is opt-in", {
  skip: process.platform === "win32" && "bash script test",
}, () => {
  const home = tmp("forge-learn-home-");
  const dir = join(home, ".claude", "skills", "learned");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lessons-2026-09.md"), `## 2026-09-10 14:02 — shop\n- ${FLAKY}\n`);
  const stubBin = tmp("forge-learn-bin-");
  const calls = join(stubBin, "calls.log");
  writeFileSync(
    join(stubBin, "claude"),
    `#!/bin/sh\necho called >> "${calls}"\necho "Not logged in - please run /login"\n`,
  );
  chmodSync(join(stubBin, "claude"), 0o755);
  const refuted = repoWith("shop", FLAKY, { refute: true });
  const env = { ...process.env, HOME: home, PATH: `${stubBin}${delimiter}${process.env.PATH}` };
  const run = spawnSync("bash", [SCRIPT, "--repo", refuted.root], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /dropped on ledger evidence: 1/);
  assert.doesNotMatch(readFileSync(join(dir, "CONSOLIDATED.md"), "utf8"), /migration/);
  assert.equal(existsSync(calls), false, "the default path never calls a model");
  const llm = spawnSync("bash", [SCRIPT, "--llm"], { env, encoding: "utf8" });
  assert.equal(readFileSync(calls, "utf8").trim(), "called", "only --llm reaches the model");
  assert.equal(llm.status, 1, "the stub's login error keeps the originals");
  assert.match(llm.stdout, /by model judgment/);
  assert.match(llm.stdout, /originals kept/);
});

// Review 2026-09-26 — F16: similar is not the same. These two rules overlap almost entirely
// and say the OPPOSITE; MinHash merged them and one silently disappeared.
const ENABLE =
  "Enable authentication for every admin route and require a signed session token before serving any page";
const DISABLE = ENABLE.replace("Enable", "Disable");

test("F16: opposite rules stay two claims, with the conflict exposed; exact duplicates still merge", () => {
  const r = consolidateLearned(
    [
      { project: "shop", text: ENABLE },
      { project: "shop", text: DISABLE },
      { project: "shop", text: `${ENABLE}.` }, // exact after normalization
    ],
    { claims: [] },
  );
  assert.deepEqual(
    r.kept.map((k) => k.text),
    [ENABLE, DISABLE],
    "neither rule is dropped as a 'duplicate' of the other",
  );
  assert.equal(r.merged.length, 1, "the exact duplicate still merges deterministically");
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0].conflicts, /polarity: enable ≠ disable/i);
});

test("N02 round 2: a lesson is dropped only when EVERY claim with its exact text is refuted", () => {
  const retracted = repoWith("shop", RETRY, { retract: true });
  const live = repoWith("blog", RETRY); // another repo holds the same rule live
  const both = ledgerClaimsFor([retracted.root, live.root]);
  const r = consolidateLearned([{ project: "General", text: RETRY }], {
    claims: both,
    nowDay: 102,
  });
  assert.deepEqual(
    r.kept.map((k) => k.text),
    [RETRY],
    "one repo's retraction does not outvote a live claim",
  );
  assert.equal(r.dropped.length, 0);
  assert.equal(r.flagged.length, 1);
  assert.match(r.flagged[0].reason, /retracted .* kept: claim \w+ with the same text is live/);
  // With the live copy gone too, it is dropped.
  const only = ledgerClaimsFor([retracted.root]);
  const r2 = consolidateLearned([{ project: "General", text: RETRY }], {
    claims: only,
    nowDay: 102,
  });
  assert.equal(r2.dropped.length, 1);
});

test("F16: a refuted OPPOSITE claim does not drop a lesson", () => {
  const refuted = repoWith("shop", ENABLE, { refute: true });
  const r = consolidateLearned([{ project: "shop", text: DISABLE }], {
    claims: ledgerClaimsFor([refuted.root]),
    nowDay: 102,
  });
  assert.deepEqual(
    r.kept.map((k) => k.text),
    [DISABLE],
  );
  assert.equal(r.dropped.length, 0);
});

// F15: archived is storage lifecycle, not a truth verdict.
test("F15: an idle-archived claim does not refute; a retracted or dormant one does", () => {
  const idle = repoWith("shop", RETRY);
  pruneToAttic(repoLedger(idle.root), idle.claim.id, {
    cause: "idle",
    reason: "idle 90 d",
    t: 200,
  });
  const retracted = repoWith("shop", TRIVIA, { retract: true });
  pruneToAttic(repoLedger(retracted.root), retracted.claim.id, {
    cause: "tombstoned",
    reason: "tombstoned",
    t: 200,
  });
  const claims = ledgerClaimsFor([idle.root, retracted.root]);
  assert.ok(
    claims.every((c) => c.attic),
    "both are read back from the attic with their logs",
  );
  const r = consolidateLearned(
    [
      { project: "shop", text: RETRY },
      { project: "shop", text: TRIVIA },
    ],
    { claims, nowDay: 200 },
  );
  assert.deepEqual(
    r.kept.map((k) => k.text),
    [RETRY],
    "the idle claim's lesson survives",
  );
  assert.deepEqual(
    r.dropped.map((d) => d.reason),
    ["retracted in the ledger"],
  );
});

test("F15: a deduplicated claim defers to the claim that survived it", () => {
  const { root } = repoWith("shop", FLAKY);
  const dir = repoLedger(root);
  const [survivor] = loadClaims(dir);
  const dupe = mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: `${FLAKY} again`,
      trigger: { action: "edit", files: [], keywords: [], symbols: [] },
      whatWentWrong: "",
    },
    scope: { level: "repo" },
    provenance: { agent: "cortex", author: "t", task: "lsn_dupe" },
    t: 100,
  }).claim;
  putClaim(dir, dupe);
  pruneToAttic(dir, dupe.id, { cause: "duplicate", survivor: survivor.id, reason: "dup", t: 150 });
  const live = consolidateLearned([{ project: "shop", text: `${FLAKY} again` }], {
    claims: ledgerClaimsFor([root]),
    nowDay: 150,
  });
  assert.equal(live.dropped.length, 0, "the survivor is live — the duplicate refutes nothing");
  tombstone(dir, survivor.id, { author: "t", reason: "wrong", t: 151 });
  const gone = consolidateLearned([{ project: "shop", text: `${FLAKY} again` }], {
    claims: ledgerClaimsFor([root]),
    nowDay: 152,
  });
  assert.equal(gone.dropped.length, 1);
  assert.match(gone.dropped[0].reason, /via the claim it was deduplicated into/);
});
