import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendDecision, decisionsPath, listDecisions, parseDecisions } from "../src/decide.js";
import { loadClaims } from "../src/ledger_store.js";
import { fakeAnthropic } from "./_fixtures.js";

test("appendDecision numbers sequentially and never rewrites prior lines", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-decide-"));
  const r1 = appendDecision(root, "use exemplar k-NN over keyword lists — decisions stay math");
  assert.equal(r1.ok, true);
  assert.equal(r1.id, "D-0001");
  const r2 = appendDecision(root, "state.md is rewritten, decisions.md is append-only");
  assert.equal(r2.id, "D-0002");
  const text = readFileSync(decisionsPath(root), "utf8");
  assert.match(text, /D-0001/);
  assert.match(text, /D-0002/);
  assert.ok(text.indexOf("D-0001") < text.indexOf("D-0002"), "chronological append order");
  assert.match(text, /# Decisions/, "header written once");
  assert.equal((text.match(/# Decisions/g) || []).length, 1);
});

test("listDecisions returns the most recent entries; empty on a fresh repo", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-decide-"));
  assert.deepEqual(listDecisions(root), []);
  for (let i = 0; i < 12; i += 1) appendDecision(root, `decision number ${i} — because`);
  const last = listDecisions(root, { limit: 10 });
  assert.equal(last.length, 10);
  assert.match(last[9].text, /number 11/);
});

test("appendDecision refuses empty text and secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-decide-"));
  assert.equal(appendDecision(root, "  ").ok, false);
  const s = appendDecision(root, `store ${fakeAnthropic("AAAAbbbbCCCCddddEEEEffff")} in env`);
  assert.equal(s.ok, false);
  assert.match(s.reason, /secret/);
});

test("a decision mints a machine-readable ledger twin (best-effort)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-decide-"));
  const r = appendDecision(root, "gate blocks once per session — repeated nagging trains bypass");
  assert.equal(r.ok, true);
  const claims = loadClaims(join(root, ".forge", "ledger"));
  const twin = claims.find((c) => c.kind === "decision");
  assert.ok(twin, "decision claim exists");
  assert.match(twin.body.text, /blocks once per session/);
});

test("a corrupted decisions file is tolerated — numbering restarts from parseable max", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-decide-"));
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    decisionsPath(root),
    "# Decisions\n\ngarbage line no entry\n- **D-0007** (2026-01-01): earlier decision\nmore garbage\n",
  );
  const r = appendDecision(root, "new decision after corruption");
  assert.equal(r.id, "D-0008", "continues from the max parseable id");
  const parsed = parseDecisions(readFileSync(decisionsPath(root), "utf8"));
  assert.equal(parsed.length, 2, "garbage ignored, both real entries parse");
});

test("concurrent appends never duplicate ids or headers (mkdir lock)", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-decide-"));
  const { spawn } = await import("node:child_process");
  const one = (i) =>
    new Promise((resolve) => {
      const p = spawn(
        "node",
        [
          "-e",
          `import("${process.cwd()}/src/decide.js").then(m => m.appendDecision(process.argv[1], "parallel decision ${"n"}${i} — race test"))`,
          root,
        ],
        { stdio: "ignore" },
      );
      p.on("exit", resolve);
    });
  await Promise.all(Array.from({ length: 8 }, (_, i) => one(i)));
  const text = readFileSync(decisionsPath(root), "utf8");
  const ids = [...text.matchAll(/\*\*D-(\d{4,})\*\*/g)].map((m) => m[1]);
  assert.equal(ids.length, 8, `all 8 decisions written: ${text}`);
  assert.equal(new Set(ids).size, 8, `ids unique: ${ids.join(",")}`);
  assert.equal((text.match(/# Decisions/g) || []).length, 1, "exactly one header");
});
