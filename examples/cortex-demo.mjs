#!/usr/bin/env node
// Forge Cortex — runnable proof-of-life. Simulates two coding sessions where the SAME
// mistake recurs, shows Cortex learn a lesson, inject it, then a human reversal retire it.
// Run:  node examples/cortex-demo.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lessonsForContext,
  recordContradiction,
  summary,
} from "../src/cortex.js";
import { processSession } from "../src/cortex_hook.js";
import { confidenceOf } from "../src/lessons.js";
import { load } from "../src/lessons_store.js";

const root = mkdtempSync(join(tmpdir(), "cortex-demo-"));
const line = (s = "") => console.log(s);
const h = (s) => line(`\n\x1b[1m${s}\x1b[0m`);

// A session where the dev changes computeTax, breaks tests, edits repeatedly, then green.
const brokenSession = () => [
  { type: "bash", command: "npm test", exitCode: 1 },
  { type: "edit", file: "src/tax.ts" },
  { type: "edit", file: "src/tax.ts" },
  { type: "edit", file: "src/tax.ts" },
  { type: "bash", command: "npm test", exitCode: 0 },
];

h("SESSION 1 — the mistake happens for the first time");
processSession(root, brokenSession(), 1);
line(
  `  lesson state: ${load(root)[0]?.status}  (a candidate — not yet trusted)`,
);

h("SESSION 2 — the SAME mistake recurs");
processSession(root, brokenSession(), 2);
const lesson = load(root)[0];
line(`  lesson state: ${lesson.status}  (recurrence promoted it)`);
line(`  learned:      "${lesson.correctedBehavior}"`);
line(`  evidence:     ${lesson.evidenceCount} independent confirmation(s)`);

h("SESSION 3 — Cortex injects the lesson the moment you touch src/tax.ts");
const { block } = lessonsForContext(
  root,
  { files: ["src/tax.ts"], symbols: [] },
  { nowDay: 3 },
);
line(
  block
    ? block
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    : "  (nothing)",
);

h(
  "Later — the human decides differently and reverts. Cortex does NOT fight it.",
);
line(
  `  confidence before reversal:  ${confidenceOf(load(root)[0], 4).toFixed(2)}`,
);
recordContradiction(root, {
  context: { files: ["src/tax.ts"] },
  nowDay: 4,
  episodeId: "rev1",
});
line(
  `  confidence after 1 reversal: ${confidenceOf(load(root)[0], 4).toFixed(2)}  (one dissent isn't a purge)`,
);
// keep reverting: a wrong lesson can't ossify — it quarantines, then retires.
for (let i = 0; i < 8; i++) {
  recordContradiction(root, {
    context: { files: ["src/tax.ts"] },
    nowDay: 4,
    episodeId: `rev${i + 2}`,
  });
}
const after = summary(root, 4);
line(
  `  after sustained reversal:    active ${after.active} · quarantined ${after.quarantined}`,
);
line(
  "  → a green build / human reversal always wins; a wrong lesson decays out, it never ossifies.\n",
);

line(`\x1b[2m(demo store: ${root})\x1b[0m`);
