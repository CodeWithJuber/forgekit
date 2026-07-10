import assert from "node:assert/strict";
import { test } from "node:test";
import { charsetClasses, setJaccard, shannonEntropy } from "../src/math.js";

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

test("charsetClasses: counts distinct character classes", () => {
  assert.equal(charsetClasses(""), 0);
  assert.equal(charsetClasses("hello"), 1);
  assert.equal(charsetClasses("Hello"), 2);
  assert.equal(charsetClasses("Hello1"), 3);
  assert.equal(charsetClasses("Hello1!"), 4);
  assert.equal(charsetClasses("12345"), 1);
});

test("setJaccard: identity, disjoint, empty, partial overlap", () => {
  const abc = new Set(["a", "b", "c"]);
  assert.equal(setJaccard(abc, new Set(["a", "b", "c"])), 1);
  assert.equal(setJaccard(abc, new Set(["x", "y"])), 0);
  assert.equal(setJaccard(new Set(), new Set()), 0);
  assert.equal(setJaccard(abc, new Set()), 0);
  // |{a,b}∩{b,c}| = 1, |∪| = 3
  assert.equal(setJaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
});

test("setJaccard: symmetric regardless of argument order", () => {
  const small = new Set(["a"]);
  const large = new Set(["a", "b", "c", "d"]);
  assert.equal(setJaccard(small, large), setJaccard(large, small));
  assert.equal(setJaccard(small, large), 0.25);
});
