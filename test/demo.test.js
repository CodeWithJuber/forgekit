import assert from "node:assert/strict";
import { test } from "node:test";
import { demo } from "../src/demo.js";

test("forge demo: green → broken → green, the gate catches the defect (item 11)", () => {
  const r = demo();
  assert.deepEqual(
    r.steps.map((s) => s.status),
    ["PASS", "FAIL", "PASS"],
    "the middle step must FAIL — a demo that never catches the defect proves nothing",
  );
  assert.equal(r.ok, true);
});
