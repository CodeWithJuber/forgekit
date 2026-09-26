import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build as buildAtlas } from "../src/atlas.js";
import { assemble, renderContext, requiredSet, tokensOf } from "../src/context.js";
import { mintClaim, outcomeRecord } from "../src/ledger.js";
import { appendEvidence, putClaim, repoLedger } from "../src/ledger_store.js";
import { enforceDecision } from "../src/substrate.js";

// A small repo where the required-knowledge set is unambiguous: computeTax is defined
// in src/tax.js, called from src/checkout.js (the hop-1 dependent), covered by a
// sibling test — and one team lesson about it is trusted past the floor.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-context-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "tax.js"),
    "export function computeTax(amount) {\n  return amount * 0.2;\n}\n",
  );
  writeFileSync(
    join(root, "src", "checkout.js"),
    'import { computeTax } from "./tax.js";\nexport function checkout(cart) {\n  return cart.total + computeTax(cart.total);\n}\n',
  );
  writeFileSync(
    join(root, "src", "tax.test.js"),
    'import { computeTax } from "./tax.js";\n// asserts the 20% rate\n',
  );
  const atlas = buildAtlas({ root });
  return { root, atlas };
}

const trustedLesson = (root) => {
  const dir = repoLedger(root);
  const minted = mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: "Never change the tax rate without updating the checkout snapshot tests.",
      trigger: { symbols: ["computeTax"], files: [], keywords: [], action: "edit" },
      whatWentWrong: "A rate change silently broke checkout totals.",
    },
    scope: { level: "symbol" },
    t: 0,
  });
  putClaim(dir, minted.claim);
  // Four confirmations: val = (1 + 4·0.9)/(2 + 4·0.9) ≈ 0.82 — past the 0.8 floor.
  // (Three lands at 0.787 and is correctly NOT trusted enough to be required.) The refs
  // must be git objects that resolve in this repo — the only ref type forge re-derives —
  // and FOUR DISTINCT events: four spellings of one commit are one event (review F06).
  const g = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  g("init");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  g("add", "-A");
  g("commit", "-m", "fixture");
  for (let n = 1; n <= 4; n++) {
    if (n > 1) g("commit", "--allow-empty", "-m", `review ${n}`);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    appendEvidence(
      dir,
      minted.claim.id,
      outcomeRecord({ oracle: "human.accept", result: "confirm", ref: `git:${head}`, t: 0 })
        .outcome,
    );
  }
  return minted.claim;
};

test("requiredSet: defs, hop-1 dependents, sibling tests, and trusted lessons — computed", () => {
  const { root, atlas } = fixture();
  const lesson = trustedLesson(root);
  const R = requiredSet(root, "update computeTax in src/tax.js to support regional rates", {
    atlas,
    claims: [
      {
        ...lesson,
        evidence: ["h1", "h2", "h3", "h4"].map((h) => ({
          oracle: "human.accept",
          result: "confirm",
          ref: `git:${Buffer.from(h).toString("hex").repeat(4)}`,
          t: 0,
          w: 0.9,
          h,
        })),
      },
    ],
    nowDay: 0,
  });
  const keys = R.map((r) => r.key);
  assert.ok(keys.includes("def:computeTax"), "the symbol's definition is required");
  assert.ok(keys.includes("deps:computeTax"), "its direct dependents are required");
  assert.ok(keys.includes("file:src/tax.js"), "the named file is required");
  assert.ok(
    keys.some((k) => k.startsWith("tests:")),
    "the sibling test is required",
  );
  assert.ok(
    keys.some((k) => k.startsWith("lesson:")),
    "a trusted team lesson about the target is required context",
  );
  assert.ok(
    R.every((r) => r.resolvable),
    "everything here is supplyable from the repo",
  );
});

test("requiredSet: an untrusted lesson (val at the prior) is NOT required", () => {
  const { root, atlas } = fixture();
  const lesson = trustedLesson(root);
  const R = requiredSet(root, "update computeTax", {
    atlas,
    claims: [{ ...lesson, evidence: [] }], // no oracle history → val 0.5 < 0.8
    nowDay: 0,
  });
  assert.ok(!R.some((r) => r.kind === "lesson"));
});

test("assemble: complete context — everything required is covered within budget", () => {
  const { root, atlas } = fixture();
  trustedLesson(root);
  const r = assemble(root, "update computeTax in src/tax.js", { atlas, nowDay: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.ok(r.tokens <= r.budget);
  assert.ok(r.selection.some((s) => s.id.startsWith("deps:")));
  assert.ok(r.block.includes("checkout"), "the dependent is IN the assembled context");
  assert.ok(r.block.includes("Never change the tax rate"), "the team lesson rides along");
});

test("assemble: a tight budget downgrades before dropping — and says what it no longer delivers", () => {
  const { root, atlas } = fixture();
  const roomy = assemble(root, "update computeTax in src/tax.js", { atlas, nowDay: 0 });
  const tight = assemble(root, "update computeTax in src/tax.js", {
    atlas,
    nowDay: 0,
    budget: 60,
  });
  assert.ok(tight.tokens <= 60, "the rendered block fits the budget");
  assert.ok(tight.tokens < roomy.tokens);
  assert.ok(
    tight.selection.some((s) => s.gran !== "full"),
    "compression ladder engaged (a lossy move chosen explicitly, not by scroll-off)",
  );
  assert.deepEqual(tight.missing, [], "nothing required vanished — it is pointed at…");
  assert.ok(tight.pending.length > 0, "…as a pending read, not as delivered coverage (F03)");
  assert.equal(tight.ok, false, "a pointer-only item is not a complete context");
  for (const k of tight.covered) assert.ok(roomy.covered.includes(k));
});

// Review 2026-09-26 — F02: a hard budget is never exceeded while claiming success.
test("F02: when even pointers cannot fit, the result is OVERFLOW, never ok", () => {
  const { root, atlas } = fixture();
  for (const budget of [1, 8, 20]) {
    const r = assemble(root, "update computeTax in src/tax.js", { atlas, nowDay: 0, budget });
    assert.ok(r.tokens <= budget, `budget ${budget}: rendered ${r.tokens}`);
    assert.equal(r.ok, false, `budget ${budget}`);
    assert.equal(r.overflow, true);
    assert.ok(r.dropped.length > 0);
    assert.ok(r.missing.length > 0, "what was dropped is reported missing");
    assert.match(r.tokenEstimate, /estimate/);
  }
});

// F03: availability is not delivery. The definition sits below 100 lines of padding.
test("F03: a definition below line 100 is delivered by a span, or stays pending — never 'covered' by a pointer or head", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-context-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const padding = Array.from({ length: 100 }, (_, i) => `// padding line ${i}`).join("\n");
  writeFileSync(
    join(root, "src", "calc.js"),
    `${padding}\nexport function calcTotal(items) {\n  return items.length;\n}\n${padding}\n`,
  );
  const atlas = buildAtlas({ root });
  const task = "change calcTotal in src/calc.js";
  const pointerOnly = assemble(root, task, { atlas, nowDay: 0, budget: 8 });
  assert.equal(pointerOnly.ok, false, "a `- read src/calc.js` line is not the definition");
  assert.ok(!pointerOnly.covered.includes("def:calcTotal"));
  assert.ok(
    pointerOnly.pending.includes("def:calcTotal") || pointerOnly.missing.includes("def:calcTotal"),
  );
  // A mid-size budget cannot hold the whole file but CAN hold the definition's span.
  const mid = assemble(root, task, { atlas, nowDay: 0, budget: 400 });
  const item = mid.selection.find((s) => s.id === "def:src/calc.js");
  assert.equal(item.gran, "span", JSON.stringify(mid.selection));
  assert.ok(mid.covered.includes("def:calcTotal"), "the span delivers the definition");
  assert.ok(mid.block.includes("export function calcTotal"));
  assert.ok(mid.pending.includes("file:src/calc.js"), "the rest of the named file is still owed");
  assert.equal(mid.ok, false);
  assert.ok(mid.truncated.some((t) => t.id === "def:src/calc.js" && t.totalLines > 200));
});

test("F03: dependents beyond the listed twelve stay visible as omitted", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-context-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "core.js"), "export function coreFn(x) {\n  return x;\n}\n");
  for (let i = 0; i < 15; i++)
    writeFileSync(
      join(root, "src", `user${i}.js`),
      `import { coreFn } from "./core.js";\nexport function use${i}() {\n  return coreFn(${i});\n}\n`,
    );
  const atlas = buildAtlas({ root });
  const r = assemble(root, "change coreFn", { atlas, nowDay: 0 });
  const t = r.truncated.find((x) => x.id === "deps:coreFn");
  assert.ok(t, JSON.stringify(r.truncated));
  assert.equal(t.shown, 12);
  assert.equal(t.omitted.length, t.total - 12);
  assert.match(r.block, /more, omitted here/);
});

test("assemble: an unknown symbol becomes a DERIVED question, and the gate can block on it", () => {
  const { root, atlas } = fixture();
  const r = assemble(root, "refactor the applyDiscountMatrix flow", { atlas, nowDay: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("def:applyDiscountMatrix"));
  assert.match(r.questions[0], /applyDiscountMatrix.*doesn't define it/);
  // The enforcing gate turns the computed missing-set into a block:
  const decision = enforceDecision(
    { context: { ok: false, missing: r.missing, questions: r.questions } },
    { enforce: true },
  );
  assert.equal(decision.block, true);
  assert.match(decision.reason, /applyDiscountMatrix/);
  const advisory = enforceDecision(
    { context: { ok: false, missing: r.missing, questions: r.questions } },
    { enforce: false },
  );
  assert.equal(advisory.block, false, "advisory by default — enforcing is opt-in");
});

test("assemble: deterministic — same repo, same task, same bytes", () => {
  const { root, atlas } = fixture();
  const a = assemble(root, "update computeTax in src/tax.js", { atlas, nowDay: 0 });
  const b = assemble(root, "update computeTax in src/tax.js", { atlas, nowDay: 0 });
  assert.deepEqual(a, b);
});

test("renderContext + tokensOf: sane output surface", () => {
  const { root, atlas } = fixture();
  const r = assemble(root, "update computeTax in src/tax.js", { atlas, nowDay: 0 });
  const out = renderContext(r);
  assert.match(out, /COMPLETE/);
  assert.match(out, /\+ deps:computeTax/);
  assert.equal(tokensOf("x".repeat(36)), 10);
});

test("assemble regression (E5): a source's 4th+ optional item is dropped — not its 7th", () => {
  // The per-source discount is δ^(j−1), δ = 0.7: the 4th item is worth 0.34 and "has decayed
  // away" per the code's own comment, but the old loop only broke AFTER taking a 6th item.
  const root = mkdtempSync(join(tmpdir(), "forge-context-"));
  const facts = Array.from(
    { length: 10 },
    (_, i) =>
      mintClaim({
        kind: "fact",
        body: { name: `f${i}`, text: `fact number ${i}` },
        scope: { level: "repo" },
        t: 0,
      }).claim,
  );
  const r = assemble(root, "do something", { claims: facts, budget: 6000 });
  const taken = r.selection.filter((s) => s.source === "fact");
  assert.equal(taken.length, 3, "three optional facts, then the source is spent");
  assert.ok(r.tokens <= 6000);
});
