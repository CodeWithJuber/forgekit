import assert from "node:assert/strict";
import { test } from "node:test";
import { clickPointExposed, intersectionArea, visibleFraction } from "../src/mathcore/occlusion.js";
import { dropRivals, rivalCount } from "../src/mathcore/rivals.js";
import { rankVulnerabilities, reachProbability } from "../src/mathcore/vulnrank.js";
import { rng } from "./_prng.js";

// ---- rivals ---------------------------------------------------------------------------
test("dropRivals keeps the latest value per key and names what superseded the rest", () => {
  const r = dropRivals([
    { id: "a", key: "db.host", value: "old.internal", at: 1 },
    { id: "b", key: "db.host", value: "new.internal", at: 5 },
    { id: "c", key: "db.port", value: 5432, at: 2 },
    { id: "d", key: "db.host", value: "mid.internal", at: 3 },
  ]);
  assert.deepEqual(
    r.keep.map((s) => s.id),
    ["b", "c"],
  );
  assert.deepEqual(r.superseded, [
    { id: "a", by: "b" },
    { id: "d", by: "b" },
  ]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(rivalCount(r.keep), 0);
});

test("dropRivals packs neither side of an unorderable conflict and reports the pair", () => {
  const r = dropRivals([
    { id: "a", key: "retry.limit", value: 3, at: 4 },
    { id: "b", key: "retry.limit", value: 5, at: 4 },
    { id: "c", key: "retry.limit", value: 1, at: 2 },
    { id: "d", key: "timeout", value: 30, at: 4 },
    { id: "e", key: "timeout", value: 30, at: 4 },
  ]);
  assert.deepEqual(r.conflicts, [{ key: "retry.limit", ids: ["a", "b"] }]);
  // Restating the same current value is not a conflict: one copy is kept.
  assert.deepEqual(
    r.keep.map((s) => s.id),
    ["d"],
  );
  assert.deepEqual(
    r.superseded.map((s) => s.id),
    ["c", "e"],
  );
});

test("dropRivals agrees with a direct per-key reference on random inputs, in any order", () => {
  const rand = rng(41);
  for (let round = 0; round < 400; round++) {
    const n = 1 + Math.floor(rand() * 14);
    const items = Array.from({ length: n }, (_, i) => ({
      id: `s${String(i).padStart(2, "0")}`,
      key: `k${Math.floor(rand() * 4)}`,
      value: Math.floor(rand() * 3),
      at: Math.floor(rand() * 5),
    }));
    // Reference: for each key, the set of values at the maximum time.
    const expectKept = new Map();
    for (const key of new Set(items.map((s) => s.key))) {
      const group = items.filter((s) => s.key === key);
      const top = Math.max(...group.map((s) => s.at));
      const values = new Set(group.filter((s) => s.at === top).map((s) => s.value));
      expectKept.set(key, values.size === 1 ? [...values][0] : undefined);
    }
    const shuffled = [...items].sort(() => rand() - 0.5);
    for (const input of [items, shuffled]) {
      const r = dropRivals(input);
      assert.equal(rivalCount(r.keep), 0);
      for (const [key, value] of expectKept) {
        const kept = r.keep.filter((s) => s.key === key);
        if (value === undefined) {
          assert.equal(kept.length, 0);
          assert.ok(r.conflicts.some((c) => c.key === key));
        } else {
          assert.equal(kept.length, 1);
          assert.equal(kept[0].value, value);
        }
      }
      // Every statement is accounted for exactly once.
      const conflictIds = r.conflicts.flatMap((c) => c.ids);
      assert.equal(r.keep.length + r.superseded.length + conflictIds.length, input.length);
    }
    assert.deepEqual(dropRivals(items), dropRivals(shuffled));
  }
});

// ---- vulnerability order --------------------------------------------------------------
test("an unknown or edge-less 'unreachable' finding is never scored zero", () => {
  assert.equal(reachProbability({ reach: "yes" }), 1);
  assert.equal(reachProbability({ reach: "no", graphComplete: true }), 0);
  assert.equal(reachProbability({ reach: "no", graphComplete: false }), 1);
  assert.equal(reachProbability({ reach: "no" }), 1);
  assert.equal(reachProbability({ reach: "unknown" }), 1);
  assert.equal(reachProbability({ reach: "unknown" }, { unknownPrior: 0.2 }), 0.2);
  assert.equal(reachProbability({ reach: "no", graphComplete: true }, { residual: 0.05 }), 0.05);
  assert.throws(() => reachProbability({ reach: /** @type {any} */ ("maybe") }), TypeError);
  assert.throws(() => reachProbability({ reach: "yes" }, { unknownPrior: 1.5 }), RangeError);
});

test("rankVulnerabilities orders by EPSS times reach and suppresses only proven-unreachable", () => {
  const ranked = rankVulnerabilities(
    [
      { id: "CVE-A", epss: 0.9, reach: "no", graphComplete: true },
      { id: "CVE-B", epss: 0.3, reach: "yes" },
      { id: "CVE-C", epss: 0.6, reach: "no", graphComplete: false },
      { id: "CVE-D", epss: 0.5, reach: "unknown" },
    ],
    { unknownPrior: 0.4, residual: 0.02 },
  );
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["CVE-B", "CVE-C", "CVE-D", "CVE-A"],
  );
  assert.deepEqual(
    ranked.map((r) => r.verdict),
    ["reachable", "unknown", "unknown", "unreachable"],
  );
  assert.deepEqual(
    ranked.map((r) => r.suppressible),
    [false, false, false, true],
  );
  const byId = Object.fromEntries(ranked.map((r) => [r.id, r.priority]));
  assert.ok(Math.abs(byId["CVE-A"] - 0.018) < 1e-12);
  assert.ok(Math.abs(byId["CVE-C"] - 0.24) < 1e-12);
  // With no graph at all, the default order is plain EPSS: nothing is hidden.
  const blind = rankVulnerabilities([
    { id: "x", epss: 0.2, reach: "unknown" },
    { id: "y", epss: 0.7, reach: "no" },
    { id: "z", epss: 0.7, reach: "unknown" },
  ]);
  assert.deepEqual(
    blind.map((r) => [r.id, r.priority]),
    [
      ["y", 0.7],
      ["z", 0.7],
      ["x", 0.2],
    ],
  );
  assert.ok(blind.every((r) => !r.suppressible));
});

// ---- occlusion ------------------------------------------------------------------------
test("visibleFraction is exact on hand cases, including overlapping covers", () => {
  const button = { x: 10, y: 10, w: 100, h: 40 };
  assert.equal(visibleFraction(button, []), 1);
  assert.equal(visibleFraction(button, [{ x: 0, y: 0, w: 500, h: 500 }]), 0);
  assert.equal(visibleFraction(button, [{ x: 10, y: 10, w: 50, h: 40 }]), 0.5);
  // Two covers that overlap each other: the shared strip is counted once.
  const twoCovers = visibleFraction(button, [
    { x: 10, y: 10, w: 60, h: 40 },
    { x: 50, y: 10, w: 30, h: 40 },
  ]);
  assert.ok(Math.abs(twoCovers - 0.3) < 1e-12, String(twoCovers));
  // A cover that only touches the edge hides nothing.
  assert.equal(visibleFraction(button, [{ x: 110, y: 10, w: 20, h: 40 }]), 1);
  assert.equal(visibleFraction({ x: 0, y: 0, w: 0, h: 10 }, []), 0);
});

test("visibleFraction matches a pixel count on random integer layouts", () => {
  const rand = rng(97);
  const int = (n) => Math.floor(rand() * n);
  let checked = 0;
  for (let round = 0; round < 300; round++) {
    const target = { x: int(20), y: int(20), w: 1 + int(30), h: 1 + int(30) };
    const covers = Array.from({ length: int(6) }, () => ({
      x: int(50) - 5,
      y: int(50) - 5,
      w: 1 + int(25),
      h: 1 + int(25),
    }));
    let free = 0;
    for (let px = target.x; px < target.x + target.w; px++)
      for (let py = target.y; py < target.y + target.h; py++)
        if (!covers.some((c) => px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h)) free++;
    const expected = free / (target.w * target.h);
    assert.ok(Math.abs(visibleFraction(target, covers) - expected) < 1e-9, `round ${round}`);
    checked++;
  }
  assert.equal(checked, 300);
});

test("a control can be mostly visible and still not clickable at its centre", () => {
  const button = { x: 0, y: 0, w: 100, h: 40 };
  const badge = { x: 35, y: 10, w: 30, h: 20 };
  assert.equal(visibleFraction(button, [badge]), 0.85);
  assert.equal(clickPointExposed(button, [badge]), false);
  assert.equal(clickPointExposed(button, [badge], { x: 5, y: 5 }), true);
  assert.equal(clickPointExposed(button, []), true);
  assert.equal(clickPointExposed(button, [], { x: 500, y: 5 }), false, "a point off the control");
  assert.equal(intersectionArea(button, badge), 600);
  assert.equal(intersectionArea(button, { x: 200, y: 0, w: 10, h: 10 }), 0);
});
