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
  consolidateDir,
  consolidateLearned,
  ledgerClaimsFor,
  parseLearned,
  renderConsolidated,
} from "../src/learn_consolidate.js";
import { isDormant, mintClaim, outcomeRecord } from "../src/ledger.js";
import { appendEvidence, putClaim, repoLedger, tombstone } from "../src/ledger_store.js";

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

test("duplicates merge; nothing is dropped without ledger evidence", () => {
  const r = consolidateLearned(
    [
      { project: "shop", text: FLAKY },
      { project: "shop", text: `${FLAKY}.` }, // exact after normalization
      { project: "shop", text: FLAKY.replace("Run", "Always run") }, // near-duplicate
      { project: "blog", text: FLAKY }, // another project keeps its own copy
      { project: "shop", text: TRIVIA }, // "trivial" is not a reason to delete
    ],
    { claims: [] },
  );
  assert.deepEqual(
    r.kept.map((k) => `${k.project}: ${k.text}`),
    [`shop: ${FLAKY}`, `blog: ${FLAKY}`, `shop: ${TRIVIA}`],
  );
  assert.equal(r.merged.length, 2);
  assert.equal(r.dropped.length, 0, "no claim matched, so nothing is refuted");
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
