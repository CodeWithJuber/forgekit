import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyDistillation } from "../src/cortex.js";
import { buildPrompt, distill, parseDistilled } from "../src/cortex_distill.js";
import { processSession } from "../src/cortex_hook.js";
import { load } from "../src/lessons_store.js";

test("buildPrompt names the location and asks for strict JSON", () => {
  const p = buildPrompt({
    context: { symbols: ["computeTax"] },
    signals: ["S1", "S6"],
  });
  assert.match(p, /computeTax/);
  assert.match(p, /STRICT\s*\n?JSON|STRICT JSON/i);
  assert.match(p, /whatWentWrong/);
});

test("parseDistilled extracts fields, tolerates surrounding prose, rejects junk", () => {
  const ok = parseDistilled(
    'Sure!\n{"whatWentWrong":"broke callers","correctedBehavior":"grep callers first"} done',
  );
  assert.deepEqual(ok, {
    whatWentWrong: "broke callers",
    correctedBehavior: "grep callers first",
  });
  assert.equal(parseDistilled("no json here"), null);
  assert.equal(parseDistilled('{"whatWentWrong":""}'), null, "missing corrected → null");
});

test("parseDistilled refuses a secret-bearing lesson", () => {
  const leak = '{"whatWentWrong":"leaked","correctedBehavior":"use REDACTED_FIXTURE"}';
  assert.equal(parseDistilled(leak), null);
});

test("distill returns null when the runner fails (caller keeps the template)", () => {
  const boom = distill(
    { context: {}, signals: [] },
    {
      run: () => {
        throw new Error("no claude");
      },
    },
  );
  assert.equal(boom, null);
});

test("distill returns a parsed lesson from a fake runner", () => {
  const run = () =>
    '{"whatWentWrong":"changed a signature","correctedBehavior":"update all call sites"}';
  const d = distill({ context: { symbols: ["x"] }, signals: ["S1"] }, { run });
  assert.equal(d.correctedBehavior, "update all call sites");
});

test("applyDistillation rewrites a created lesson's body in place", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-distill-"));
  const s = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/a.ts" },
    { type: "edit", file: "src/a.ts" },
    { type: "edit", file: "src/a.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  const [res] = processSession(root, s(), 1); // creates a candidate with a template body
  const before = load(root)[0].correctedBehavior;
  const ok = applyDistillation(root, res.id, {
    whatWentWrong: "distilled cause",
    correctedBehavior: "distilled rule",
  });
  assert.equal(ok, true);
  const after = load(root)[0].correctedBehavior;
  assert.equal(after, "distilled rule");
  assert.notEqual(after, before, "the template was replaced");
});
