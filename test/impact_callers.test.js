// E03 (research-to-code audit): the everyday blast-radius callers ran the reverse-only walk
// the empirical refutation measured at recall 0.022, where 94.7% of the misses were sibling
// files. The recall-critical callers — the substrate check (and through it the ambient
// prompt hook and the enforce gate) and the Stop gate's repair checklist — now walk the
// sibling and forward relations too, at the frozen parameters in atlas.js, and tag every
// file with the relation that reached it. Fixture: serializer.js and deserializer.js both
// use wire_format.js; app.js imports both (test/fixtures/impact_repos.mjs, sibFiles).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  build,
  DEFAULT_IMPACT_RELATIONS,
  fileRelations,
  IMPACT_RELATIONS,
  impact,
} from "../src/atlas.js";
import { repairReason } from "../src/gate.js";
import {
  enforceDecision,
  renderSubstrate,
  substrateCheck,
  substrateContext,
} from "../src/substrate.js";
import { sibFiles, writeRepo } from "./fixtures/impact_repos.mjs";

const TASK = "Change serialize in src/serializer.js to add a version byte; update tests";
const HOOK = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));

function sibRepo() {
  const root = writeRepo(sibFiles);
  build({ root }); // writes the cached atlas the hook-grade (allowBuild:false) paths read
  return root;
}

test("substrateCheck reports the sibling file, tagged by relation", () => {
  const root = sibRepo();
  const r = substrateCheck(root, TASK, { allowBuild: false });
  assert.equal(r.impact.atlasFresh, true);
  assert.ok(r.impact.impactedFiles.includes("src/deserializer.js"), r.impact.impactedFiles.join());
  assert.equal(r.impact.fileRelations["src/deserializer.js"], "sibling");
  assert.equal(r.impact.fileRelations["src/app.js"], "reverse");
  assert.equal(r.impact.fileRelations["src/wire_format.js"], "forward");
  assert.deepEqual(r.impact.relations, [...IMPACT_RELATIONS]);
  assert.equal(r.impact.relationCounts.sibling, 1);
  const out = renderSubstrate(r);
  assert.match(out, /src\/deserializer\.js \(sibling\)/);
  assert.match(out, /1 reverse, 1 sibling, 1 forward/);
});

test("substrateCheck keeps an explicit reverse-only option", () => {
  const root = sibRepo();
  const r = substrateCheck(root, TASK, { allowBuild: false, relations: DEFAULT_IMPACT_RELATIONS });
  assert.ok(!r.impact.impactedFiles.includes("src/deserializer.js"));
  assert.ok(r.impact.impactedFiles.includes("src/app.js"));
  assert.deepEqual(Object.values(r.impact.fileRelations), ["reverse"]);
});

test("the ambient advisory names the sibling file and says what the tag means", () => {
  const root = sibRepo();
  const text = substrateContext(substrateCheck(root, TASK, { allowBuild: false }));
  assert.match(text, /Predicted blast radius \(3: 1 reverse, 1 sibling, 1 forward\)/);
  assert.match(text, /src\/app\.js \(reverse\), src\/deserializer\.js \(sibling\)/);
  assert.match(text, /sibling = shares a dependency with it/);
});

test("the ambient prompt hook itself surfaces the sibling file", () => {
  const root = sibRepo();
  const r = spawnSync("node", [HOOK, "preflight"], {
    input: JSON.stringify({ session_id: "s-e03", cwd: root, prompt: TASK }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /src\/deserializer\.js \(sibling\)/, ctx);
});

test("enforce gate: dependents drive the block count; co-change candidates are named", () => {
  const impactOf = (reverse, sibling) => {
    const files = [
      ...Array.from({ length: reverse }, (_, i) => `r${i}.js`),
      ...Array.from({ length: sibling }, (_, i) => `s${i}.js`),
    ];
    const fileRelations = Object.fromEntries(
      files.map((f) => [f, f.startsWith("r") ? "reverse" : "sibling"]),
    );
    return {
      assumption: { hardUnderspecified: false, questions: [] },
      impact: {
        impactedFiles: files,
        fileRelations,
        relationCounts: { reverse, sibling },
      },
    };
  };
  const opts = { enforce: true, blastThreshold: 25 };
  // 10 dependents + 40 siblings: the siblings alone never block (precision-first gate).
  assert.equal(enforceDecision(impactOf(10, 40), opts).block, false);
  const g = enforceDecision(impactOf(30, 5), opts);
  assert.equal(g.block, true);
  assert.match(
    g.reason,
    /30 files predicted, plus 5 co-change candidate\(s\): 30 reverse, 5 sibling/,
  );
  // The explicit option counts every relation toward the threshold.
  assert.equal(
    enforceDecision(impactOf(10, 40), { ...opts, blastRelations: IMPACT_RELATIONS }).block,
    true,
  );
  // The real substrate result carries the tags the gate reads.
  const root = sibRepo();
  const real = substrateCheck(root, TASK, { allowBuild: false });
  assert.equal(enforceDecision(real, { enforce: true, blastThreshold: 1 }).block, true);
  assert.equal(
    enforceDecision(real, { enforce: true, blastThreshold: 2 }).block,
    false,
    "1 dependent (app.js) — the sibling and forward files are not counted by default",
  );
  assert.equal(
    enforceDecision(real, { enforce: true, blastThreshold: 3, blastRelations: IMPACT_RELATIONS })
      .block,
    true,
  );
});

test("the Stop gate's repair checklist names the untouched sibling, tagged", () => {
  const root = sibRepo();
  const reason = repairReason(root, {
    codeFiles: ["src/serializer.js"],
    classes: { code: ["src/serializer.js"] },
  });
  assert.match(reason, /Co-change candidates the graph predicts/);
  assert.match(reason, /src\/app\.js \(reverse\), src\/deserializer\.js \(sibling\)/);
  assert.match(reason, /src\/wire_format\.js \(forward\)/);
  const touched = repairReason(root, {
    codeFiles: ["src/serializer.js", "src/deserializer.js"],
    classes: { code: ["src/serializer.js", "src/deserializer.js"] },
  });
  assert.doesNotMatch(touched, /deserializer\.js \(sibling\)/, "a changed file is not a candidate");
  const reverseOnly = repairReason(root, {
    codeFiles: ["src/serializer.js"],
    classes: { code: ["src/serializer.js"] },
    relations: ["reverse"],
  });
  assert.doesNotMatch(reverseOnly, /deserializer/, "reverse-only option: the old answer");
});

test("a wide walk adds files but never relabels a reverse dependent", () => {
  // b reaches a by a 4-hop reverse chain (b → x → y → z → a) AND is a's sibling via c. The
  // sibling path scores higher, but b stays a dependent.
  const mod = (name) => ({ id: `module:${name}`, name, kind: "module", file: `${name}.js` });
  const imp = (s, t) => ({
    source: `module:${s}`,
    target: `module:${t}`,
    kind: "imports",
    confidence: 1,
  });
  const atlas = {
    nodes: ["a", "b", "c", "x", "y", "z"].map(mod),
    edges: [
      imp("a", "c"),
      imp("b", "c"),
      imp("b", "x"),
      imp("x", "y"),
      imp("y", "z"),
      imp("z", "a"),
    ],
    symbols: [],
  };
  const wide = impact(atlas, "a.js", { threshold: 0.01, relations: IMPACT_RELATIONS });
  const rels = fileRelations([wide]);
  assert.equal(rels["b.js"], "reverse");
  const reverseOnly = impact(atlas, "a.js", { threshold: 0.01 });
  const reverseTagged = Object.keys(rels)
    .filter((f) => rels[f] === "reverse")
    .sort();
  assert.deepEqual(reverseTagged, reverseOnly.impactedFiles, "same dependents either way");
});
