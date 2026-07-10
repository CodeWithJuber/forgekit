import assert from "node:assert/strict";
import { test } from "node:test";
import { setOverlap, shannonEntropy } from "../src/math.js";

test("shannonEntropy: empty and single-char strings", () => {
  assert.equal(shannonEntropy(""), 0);
  assert.equal(shannonEntropy("a"), 0);
  assert.equal(shannonEntropy("aaaaaaaa"), 0);
});

test("shannonEntropy: two equiprobable symbols → exactly 1 bit", () => {
  assert.equal(shannonEntropy("abababab"), 1);
  assert.equal(shannonEntropy("ab"), 1);
});

test("shannonEntropy: uniform 4-symbol alphabet → exactly 2 bits", () => {
  assert.equal(shannonEntropy("abcdabcd"), 2);
});

test("shannonEntropy: random-looking credential scores far above English", () => {
  const credential = ["xK9mQ2vT7pL4", "wN8jR3bZ6cF1", "hD5gY0sA"].join("");
  const english = "the quick brown fox jumps over the lazy dog again";
  assert.ok(shannonEntropy(credential) > 4.5, "credential entropy should exceed 4.5 bits");
  assert.ok(shannonEntropy(english) < 4.5, "prose entropy should stay below 4.5 bits");
  assert.ok(shannonEntropy(credential) > shannonEntropy(english));
});

test("shannonEntropy: counts code points, not UTF-16 units", () => {
  // Surrogate pairs: two identical emoji = one distinct symbol = 0 bits.
  assert.equal(shannonEntropy("😀😀"), 0);
  assert.equal(shannonEntropy("😀😅"), 1);
});

test("setOverlap: containment, disjoint, empty, symmetric", () => {
  const small = new Set(["a"]);
  const large = new Set(["a", "b", "c", "d"]);
  assert.equal(setOverlap(small, large), 1, "full containment of the smaller set → 1");
  assert.equal(setOverlap(large, small), 1, "symmetric");
  assert.equal(setOverlap(new Set(["x"]), large), 0);
  assert.equal(setOverlap(new Set(), large), 0);
  // |{a,b}∩{b,c}| = 1, min size 2
  assert.equal(setOverlap(new Set(["a", "b"]), new Set(["b", "c"])), 0.5);
});
