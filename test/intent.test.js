import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyIntent,
  INTENT_HELPERS,
  intentCard,
  isDialogueTurn,
  PROTOCOL_CARDS,
} from "../src/intent.js";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));

test("classifyIntent: confidence belongs to the winning intent (deep review D9)", () => {
  // Two release rows outvote one closer question row; the reported confidence used to be the
  // question row's similarity — evidence for an intent that lost.
  const r = classifyIntent("what does the release script do");
  const best = Math.max(...r.neighbors.filter((n) => n.intent === r.intent).map((n) => n.sim));
  assert.ok(Math.abs(r.confidence - best) < 1e-3, `confidence ${r.confidence} vs best ${best}`);
  const top = r.neighbors[0];
  if (top.intent !== r.intent)
    assert.ok(r.confidence < top.sim, "and it is not the losing neighbor's similarity");
});

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
    "research",
    "security",
  ]);
});

test("every protocol card names skills and crew that ship with the plugin", () => {
  const ships = (path) => existsSync(new URL(path, import.meta.url));
  const skill = (name) =>
    ships(`../global/tools/${name}/SKILL.md`) || ships(`../skills/${name}/SKILL.md`);
  assert.deepEqual(Object.keys(INTENT_HELPERS).sort(), Object.keys(PROTOCOL_CARDS).sort());
  for (const [intent, { skills, crew }] of Object.entries(INTENT_HELPERS)) {
    const card = PROTOCOL_CARDS[intent];
    assert.ok(skills.length > 0 && crew.length > 0, intent);
    for (const [name] of skills) {
      assert.ok(skill(name), `${intent}: skill ${name} ships`);
      assert.ok(card.includes(`${name} (`), `${intent} card names skill ${name}`);
    }
    for (const [name] of crew) {
      assert.ok(ships(`../global/crew/${name}.md`), `${intent}: crew agent ${name} ships`);
      assert.ok(card.includes(`${name} (`), `${intent} card names crew agent ${name}`);
    }
    // One UserPromptSubmit payload is capped at 6,000 bytes and the card shares it.
    assert.ok(
      Buffer.byteLength(card) <= 1200,
      `${intent} card is ${Buffer.byteLength(card)} bytes`,
    );
  }
});

test("preflight says nothing for a message the harness submits by itself", () => {
  // A subagent's hand-back and a background-task notice go through UserPromptSubmit like a
  // typed prompt. They are reports, not requests: no card, no advisory, no lookups.
  const root = mkdtempSync(join(tmpdir(), "forge-intent-"));
  const feed = (prompt) =>
    spawnSync("node", [ENTRY, "preflight"], {
      input: JSON.stringify({ session_id: "hook-2", cwd: root, prompt }),
      encoding: "utf8",
    });
  for (const prompt of [
    '<agent-message from="a1">\n[Subagent hand-back] The report follows:\n  fix the crash in src/tax.ts when rounding\n</agent-message>',
    "<task-notification>\n<result>fix the crash in src/tax.ts when rounding</result>\n</task-notification>",
    "[SYSTEM NOTIFICATION - NOT USER INPUT]\nfix the crash in src/tax.ts when rounding",
  ]) {
    const r = feed(prompt);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "", prompt.slice(0, 30));
  }
  // The same words typed by a person still get the card.
  const typed = feed("fix the crash in src/tax.ts when rounding");
  assert.match(JSON.parse(typed.stdout).hookSpecificOutput.additionalContext, /Bugfix protocol/);
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

test("questions and acknowledgements skip pre-action guidance while requests retain it", () => {
  for (const prompt of [
    "Which language is this?",
    "What happened?",
    "Why are the tests failing?",
    "Can you explain the error?",
    "Kya hua?",
    "Thanks!",
    "continue",
    "where is the config loaded from",
  ]) {
    assert.equal(isDialogueTurn(prompt), true, prompt);
  }
  for (const prompt of [
    "Fix the parser.",
    "Can you fix the parser?",
    "Why is CI red? Fix it.",
    "Do the work.",
    "Implement pagination",
  ]) {
    assert.equal(isDialogueTurn(prompt), false, prompt);
  }
  assert.equal(isDialogueTurn("ambiguous", "question"), true);
  assert.equal(isDialogueTurn("why?", "bugfix"), false);
});

test("classifyIntent: research and security work get their own protocols", () => {
  assert.equal(
    classifyIntent("research a better approach for caching sessions").intent,
    "research",
  );
  assert.equal(classifyIntent("compare the options for a pdf parser").intent, "research");
  assert.equal(classifyIntent("fix the sql injection in the login form").intent, "security");
  assert.equal(classifyIntent("rotate the leaked stripe key").intent, "security");
  assert.equal(classifyIntent("xss vulnerability patch karo").intent, "security");
  const root = mkdtempSync(join(tmpdir(), "forge-intent-"));
  assert.match(
    intentCard(root, "s3", "patch the xss in the profile page"),
    /Security fix protocol/,
  );
  assert.match(intentCard(root, "s3", "research a faster way to index logs"), /Research protocol/);
});
