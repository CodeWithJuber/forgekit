import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyIntent, intentCard, PROTOCOL_CARDS } from "../src/intent.js";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));

test("classifyIntent: each intent recognized from unseen phrasings (English)", () => {
  assert.equal(classifyIntent("fix the crash on the settings page").intent, "bugfix");
  assert.equal(classifyIntent("add a page to export invoices as csv").intent, "feature");
  assert.equal(
    classifyIntent("clean up the billing module and reduce duplication").intent,
    "refactor",
  );
  assert.equal(classifyIntent("cut a release and update the changelog").intent, "release");
  assert.equal(classifyIntent("how does the cache expiry work").intent, "question");
});

test("classifyIntent: Hinglish rows are data, not regexes — unseen variants match", () => {
  assert.equal(classifyIntent("login page thik karo error aa raha hai").intent, "bugfix");
  assert.equal(classifyIntent("ek naya profile page banao").intent, "feature");
  assert.equal(classifyIntent("deploy kar do production par").intent, "release");
});

test("classifyIntent: no resemblance → none (never a guess); neighbors attribute the call", () => {
  const vague = classifyIntent("hello there");
  assert.equal(vague.intent, "none");
  const r = classifyIntent("fix the race condition in the export queue");
  assert.equal(r.intent, "bugfix");
  assert.ok(
    r.neighbors.length > 0 && r.neighbors[0].sim >= r.confidence - 1e-9,
    "evidence rides along",
  );
});

test("intentCard: question and none are silent; work intents inject once per run", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-intent-"));
  assert.equal(intentCard(root, "s1", "why is startup slow"), "", "questions get no ceremony");
  const first = intentCard(root, "s1", "fix the crash when uploading");
  assert.match(first, /Bugfix protocol/);
  assert.match(first, /docs sync/, "card names real machinery");
  assert.equal(intentCard(root, "s1", "fix the other crash too"), "", "same intent deduped");
  const switched = intentCard(root, "s1", "now add a csv export feature");
  assert.match(switched, /Feature protocol/, "intent change re-injects");
  const back = intentCard(root, "s1", "fix the regression this caused");
  assert.match(back, /Bugfix protocol/, "returning to a prior intent re-injects");
});

test("intentCard: FORGE_INTENT=0 disables; cards exist only for work intents", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-intent-"));
  process.env.FORGE_INTENT = "0";
  try {
    assert.equal(intentCard(root, "s2", "fix the crash"), "");
  } finally {
    delete process.env.FORGE_INTENT;
  }
  assert.deepEqual(Object.keys(PROTOCOL_CARDS).sort(), [
    "bugfix",
    "feature",
    "refactor",
    "release",
  ]);
});

test("preflight hook emits the card as additionalContext and dedupes on repeat", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-intent-"));
  const feed = (prompt) =>
    spawnSync("node", [ENTRY, "preflight"], {
      input: JSON.stringify({ session_id: "hook-1", cwd: root, prompt }),
      encoding: "utf8",
    });
  const first = feed("fix the crash in src/tax.ts when rounding");
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Bugfix protocol/);
  const second = feed("fix the crash in src/tax.ts when rounding");
  const again = second.stdout.trim() ? JSON.parse(second.stdout) : null;
  assert.ok(
    !again || !/Bugfix protocol/.test(again.hookSpecificOutput?.additionalContext ?? ""),
    "repeat intent does not re-inject the card",
  );
});
