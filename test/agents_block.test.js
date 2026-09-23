// AGENTS.md is shared with people: forge owns only the block between
// <!-- forge:begin --> and <!-- forge:end -->. These tests pin the contract for every path
// that writes AGENTS.md (sync, init, the Stop-hook auto-sync, doctor --fix): a person's text
// is never rewritten, moved aside or reverted, the block itself is still repaired, and a
// repo whose AGENTS.md is fully generated today converts without losing a byte.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doctor } from "../src/doctor.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  findManagedBlock,
  hashContent,
  hasManagedBlock,
  managedBlock,
  managedContent,
  mdHeader,
  splitLegacyManaged,
} from "../src/emit/_shared.js";
import { init } from "../src/init.js";
import { agentsMdStatus, assemble, autoSyncIfDrifted, canonical, sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-block-"));
const agentsOf = (root) => readFileSync(join(root, "AGENTS.md"), "utf8");
const HAND =
  "# HostLelo agents\n\n- Lint: `npm run lint`\n- Never call the WHMCS API from the client.\n";

/** The file the pre-block forge wrote: the generated header, then the whole body. */
const legacyFile = (body) => managedContent(mdHeader(hashContent(body)), body);

/** Change the canonical source (a per-repo rule) so the block goes stale. */
function addRule(root, rule) {
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "rules.json"),
    JSON.stringify({ sections: [{ title: "Repo", rules: [rule] }] }),
  );
}

// ---------------------------------------------------------------------------
// The block helpers
// ---------------------------------------------------------------------------

test("findManagedBlock locates a whole-line block and flags a half-open one as damaged", () => {
  const block = managedBlock(mdHeader("abcdefabcdef"), "# body\n");
  assert.ok(block.startsWith(`${BLOCK_BEGIN}\n`) && block.endsWith(`${BLOCK_END}\n`));
  const text = `mine above\n\n${block}mine below\n`;
  const found = findManagedBlock(text);
  assert.equal(found?.damaged, false);
  if (found?.damaged !== false) return;
  assert.equal(text.slice(found.start, found.end), block, "extent is exactly the block");
  assert.equal(hasManagedBlock(text), true);

  assert.equal(findManagedBlock("no markers here\n"), null);
  assert.deepEqual(findManagedBlock(`${BLOCK_BEGIN}\nno end\n`), { damaged: true });
  assert.deepEqual(findManagedBlock(`no begin\n${BLOCK_END}\n`), { damaged: true });
  assert.deepEqual(findManagedBlock(`${BLOCK_END}\n${BLOCK_BEGIN}\n`), { damaged: true });
  assert.equal(hasManagedBlock(`${BLOCK_BEGIN}\nno end\n`), false);
  // A marker quoted inside prose is not a block boundary.
  assert.equal(findManagedBlock(`forge writes \`${BLOCK_BEGIN}\` then its rules\n`), null);
});

test("splitLegacyManaged separates a person's text from a fully generated body by its hash", () => {
  const body = assemble({ title: "t", sections: [{ title: "Workflow", rules: ["do X"] }] });
  const pristine = legacyFile(body);
  assert.deepEqual(splitLegacyManaged(pristine), { lossless: true, before: "", after: "" });

  const withNotes = `Notes on top\n${pristine}## My notes\n- keep me\n`;
  assert.deepEqual(splitLegacyManaged(withNotes), {
    lossless: true,
    before: "Notes on top\n",
    after: "## My notes\n- keep me\n",
  });

  const edited = pristine.replace("- do X", "- do X, but carefully");
  assert.equal(splitLegacyManaged(edited)?.lossless, false, "edit inside the generated text");
  assert.equal(splitLegacyManaged(HAND), null, "hand-written file is not legacy");
  assert.equal(splitLegacyManaged(managedBlock(mdHeader(hashContent(body)), body)), null);
});

// ---------------------------------------------------------------------------
// A hand-written AGENTS.md is preserved by init, sync and auto-sync
// ---------------------------------------------------------------------------

test("sync appends the block to a hand-written AGENTS.md and never rewrites the person's text", () => {
  const root = fixture();
  writeFileSync(join(root, "AGENTS.md"), HAND);
  const r = sync({ targetRoot: root });
  const after = agentsOf(root);
  assert.ok(after.startsWith(HAND), "hand-written text first, byte for byte");
  assert.equal(after.slice(HAND.length), `\n${agentsMdStatus(root).block}`);
  assert.equal(r.backedUp, false);
  assert.ok(!readdirSync(root).some((f) => f.includes("forge-bak")), "no backup file at all");
  assert.equal(agentsMdStatus(root).state, "in-sync");
});

test("init preserves a hand-written AGENTS.md", () => {
  const root = fixture();
  writeFileSync(join(root, "AGENTS.md"), HAND);
  init({ targetRoot: root, noSettings: true });
  assert.ok(agentsOf(root).startsWith(HAND), "init kept the hand-written file");
  assert.ok(hasManagedBlock(agentsOf(root)), "and added forge's block");
});

test("auto-sync never adopts a hand-written AGENTS.md (no block → no write)", () => {
  const root = fixture();
  writeFileSync(join(root, "AGENTS.md"), HAND);
  assert.deepEqual(autoSyncIfDrifted(root), {
    synced: false,
    reason: "no managed AGENTS.md here",
  });
  assert.equal(agentsOf(root), HAND, "byte-identical");
});

test("a human edit OUTSIDE the block survives auto-sync; the stale block is refreshed", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const block = agentsOf(root);
  const edited = `# Repo notes\nRun \`npm run e2e\` against port 3100.\n\n${block}\n## Deploy\n- Vercel only.\n`;
  writeFileSync(join(root, "AGENTS.md"), edited);
  assert.equal(autoSyncIfDrifted(root).synced, false, "an edit outside the block is not drift");
  assert.equal(agentsOf(root), edited);

  addRule(root, "always frob the widget");
  const r = autoSyncIfDrifted(root);
  assert.equal(r.synced, true);
  const after = agentsOf(root);
  assert.ok(after.startsWith("# Repo notes\nRun `npm run e2e` against port 3100.\n\n"));
  assert.ok(after.endsWith("\n## Deploy\n- Vercel only.\n"), "text below the block kept");
  assert.match(after, /always frob the widget/, "block now carries the new rule");
  assert.equal(autoSyncIfDrifted(root).synced, false, "second pass: in sync");
});

test("drift INSIDE the block is repaired by auto-sync without touching the text around it", () => {
  const root = fixture();
  writeFileSync(join(root, "AGENTS.md"), HAND);
  sync({ targetRoot: root });
  const good = agentsOf(root);
  writeFileSync(join(root, "AGENTS.md"), good.replace("## Workflow", "## Workflow\n- SNEAKY"));
  assert.equal(agentsMdStatus(root).state, "drifted");
  assert.equal(autoSyncIfDrifted(root).synced, true);
  assert.equal(agentsOf(root), good, "block restored, hand-written text untouched");
});

test("auto-sync refreshes Continue's forge-owned rules copy only when it already exists", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const rules = join(root, ".continue", "rules", "00-forge.md");
  assert.ok(existsSync(rules));
  addRule(root, "continue sees this too");
  autoSyncIfDrifted(root);
  assert.match(readFileSync(rules, "utf8"), /continue sees this too/);

  const bare = fixture();
  sync({ targetRoot: bare, tools: ["claude"] });
  addRule(bare, "x");
  autoSyncIfDrifted(bare);
  assert.ok(!existsSync(join(bare, ".continue")), "auto-sync never creates tool config");
});

test("damaged markers: sync and auto-sync leave the file alone and say why", () => {
  const root = fixture();
  const broken = `${HAND}\n${BLOCK_BEGIN}\n# half a block, end marker deleted\n`;
  writeFileSync(join(root, "AGENTS.md"), broken);
  const r = sync({ targetRoot: root });
  assert.equal(r.report.find((row) => row.target === "AGENTS.md").action, "skipped");
  assert.ok(r.warnings.some((w) => /forge:begin marker without forge:end/.test(w)));
  assert.equal(autoSyncIfDrifted(root).synced, false);
  assert.equal(agentsOf(root), broken, "not a byte changed");
});

// ---------------------------------------------------------------------------
// Backwards compatibility: an AGENTS.md that forge fully generated before blocks existed
// ---------------------------------------------------------------------------

test("a legacy fully generated AGENTS.md converts to a block, keeping text a person added", () => {
  const root = fixture();
  const notes = "## Team notes\n- ship on Fridays? never.\n";
  writeFileSync(join(root, "AGENTS.md"), `${legacyFile(canonical(root))}${notes}`);
  assert.equal(agentsMdStatus(root).state, "legacy");
  const r = sync({ targetRoot: root });
  const after = agentsOf(root);
  assert.equal(after, `${agentsMdStatus(root).block}\n${notes}`, "block, then the notes");
  assert.equal(r.backedUp, false, "lossless: nothing to back up");
  assert.ok(!readdirSync(root).some((f) => f.includes("forge-bak")));
});

test("a stale legacy file converts losslessly on auto-sync too (old rules replaced)", () => {
  const root = fixture();
  const old = assemble({ title: "old", sections: [{ title: "Old", rules: ["stale rule"] }] });
  writeFileSync(join(root, "AGENTS.md"), legacyFile(old));
  const r = autoSyncIfDrifted(root);
  assert.deepEqual(r, { synced: true, reason: "converted to a Forge block" });
  assert.equal(agentsOf(root), agentsMdStatus(root).block);
  assert.doesNotMatch(agentsOf(root), /stale rule/);
});

test("a legacy file edited INSIDE the generated text: auto-sync refuses, sync backs up then converts", () => {
  const root = fixture();
  const edited = legacyFile(canonical(root)).replace(
    "## Workflow",
    "## Workflow\n- my edit in the generated text",
  );
  writeFileSync(join(root, "AGENTS.md"), edited);
  assert.equal(agentsMdStatus(root).state, "legacy-edited");
  const auto = autoSyncIfDrifted(root);
  assert.equal(auto.synced, false);
  assert.match(auto.reason, /run `forge sync`/);
  assert.equal(agentsOf(root), edited, "auto-sync wrote nothing");

  writeFileSync(join(root, "AGENTS.md.forge-bak"), HAND); // what an older forge left behind
  const r = sync({ targetRoot: root });
  assert.equal(r.backedUp, true);
  assert.match(r.backup, /AGENTS\.md\.forge-bak-\d{4}-\d\d-\d\dT/, "timestamped, never one name");
  assert.equal(readFileSync(r.backup, "utf8"), edited, "the whole previous file is kept");
  assert.equal(agentsOf(root), agentsMdStatus(root).block);
  const warning = r.warnings.find((w) => w.includes("forge-bak-"));
  assert.ok(warning, "the backup is named in a warning");
  assert.match(warning, /AGENTS\.md\.forge-bak \(the hand-written file an older forge replaced\)/);
  assert.equal(readFileSync(join(root, "AGENTS.md.forge-bak"), "utf8"), HAND, "old backup kept");
});

// ---------------------------------------------------------------------------
// doctor speaks the same states
// ---------------------------------------------------------------------------

test("doctor: hand-written AGENTS.md is 'not managed' and --fix appends the block, keeping it", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  writeFileSync(join(root, "AGENTS.md"), HAND);
  const row = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "AGENTS.md",
  );
  assert.equal(row.status, "warn");
  assert.match(row.note, /hand-written AGENTS\.md \(no Forge block\)/);
  assert.match(row.note, /leaves your text as is/);
  doctor({ targetRoot: root, settingsPath, fix: true });
  assert.ok(agentsOf(root).startsWith(HAND));
  const again = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "AGENTS.md",
  );
  assert.deepEqual([again.status, again.note], ["ok", "in sync (Forge block)"]);
});

test("doctor: a current legacy file is ok; a damaged block warns with no automatic fix", () => {
  const root = fixture();
  writeFileSync(join(root, "AGENTS.md"), legacyFile(canonical(root)));
  const legacy = doctor({ targetRoot: root }).results.find((r) => r.label === "AGENTS.md");
  assert.equal(legacy.status, "ok");
  assert.match(legacy.note, /pre-block format/);

  writeFileSync(join(root, "AGENTS.md"), `${BLOCK_BEGIN}\nno end\n`);
  const damaged = doctor({ targetRoot: root }).results.find((r) => r.label === "AGENTS.md");
  assert.equal(damaged.status, "warn");
  assert.match(damaged.note, /damaged Forge markers/);
  assert.equal(damaged.fix, undefined, "doctor --fix must not guess where forge's text ends");
});
