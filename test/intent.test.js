import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyIntent, INTENT_HELPERS, intentCard, PROTOCOL_CARDS } from "../src/intent.js";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));

test("unlabeled prompts in different languages never select a work protocol", () => {
  for (const prompt of [
    "fix the release crash",
    "ek naya profile page banao",
    "採用新模型",
    "what does it do?",
  ]) {
    assert.deepEqual(classifyIntent(prompt), {
      intent: "none",
      source: "unclassified",
      observations: 0,
    });
  }
  assert.equal(classifyIntent("/forge bugfix 日本語で").intent, "bugfix");
  assert.equal(classifyIntent("/forge nonexistent foo").source, "unrecognized");
  assert.equal(classifyIntent("/forge feature foo", { intent: "question" }).intent, "question");
});
test("explicitly selected protocols are deduplicated across a session", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-intent-"));
  assert.equal(intentCard(root, "s1", "fix the crash"), "");
  assert.match(intentCard(root, "s1", "/forge bugfix repair"), /Bugfix protocol/);
  assert.equal(intentCard(root, "s1", "/forge bugfix another task"), "");
  assert.match(intentCard(root, "s1", "/forge feature work"), /Feature protocol/);
  assert.match(intentCard(root, "s1", "/forge bugfix again"), /Bugfix protocol/);
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
  const typed = feed("/forge bugfix fix the crash in src/tax.ts when rounding");
  assert.match(JSON.parse(typed.stdout).hookSpecificOutput.additionalContext, /Bugfix protocol/);
});

test("preflight hook emits the card as additionalContext and dedupes on repeat", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-intent-"));
  const feed = (prompt) =>
    spawnSync("node", [ENTRY, "preflight"], {
      input: JSON.stringify({ session_id: "hook-1", cwd: root, prompt }),
      encoding: "utf8",
    });
  const first = feed("/forge bugfix fix the crash in src/tax.ts when rounding");
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Bugfix protocol/);
  const second = feed("/forge bugfix fix the crash in src/tax.ts when rounding");
  const again = second.stdout.trim() ? JSON.parse(second.stdout) : null;
  assert.ok(
    !again || !/Bugfix protocol/.test(again.hookSpecificOutput?.additionalContext ?? ""),
    "repeat intent does not re-inject the card",
  );
});

test("the host or user can mark conversational turns without a language classifier", async () => {
  const { isDialogueTurn } = await import("../src/intent.js");
  for (const kind of ["question", "acknowledgement", "continuation"]) {
    assert.equal(isDialogueTurn("…", { intent: kind }), true);
    assert.equal(isDialogueTurn(`/forge ${kind} …`), true);
  }
  assert.equal(isDialogueTurn("Question about question generation", { intent: "feature" }), false);
  assert.equal(isDialogueTurn("unlabeled free text"), false);
});
