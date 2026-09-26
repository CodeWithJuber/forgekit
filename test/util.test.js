import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp01, slug, stripTrailingSlashes } from "../src/util.js";

test("clamp01 regression (E5): NaN and non-numeric input fail to 0, never propagate", () => {
  // Math.max(0, Math.min(1, NaN)) is NaN — one NaN signal poisoned every score it touched.
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(undefined), 0);
  assert.equal(clamp01("not a number"), 0);
  assert.equal(clamp01(null), 0);
  // the ordinary contract is unchanged
  assert.equal(clamp01(0.3), 0.3);
  assert.equal(clamp01(-2), 0);
  assert.equal(clamp01(5), 1);
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 1);
  assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
  assert.equal(clamp01("0.5"), 0.5);
});

test("slug: ASCII names slug exactly as before", () => {
  assert.equal(slug("DB port quirk"), "db-port-quirk");
  assert.equal(slug("Hello, World!!"), "hello-world");
  assert.equal(slug("  --lead & trail--  "), "lead-trail");
  assert.equal(slug("src/app.js"), "src-app-js");
  assert.equal(slug(""), "", "blank stays blank so callers' own fallbacks still apply");
  assert.equal(slug("   "), "");
});

test("slug regression (E5): non-ASCII names get distinct slugs instead of all colliding on ''", () => {
  const arabic = slug("مفتاح الواجهة");
  const chinese = slug("数据库地址");
  const hindi = slug("नमस्ते दुनिया");
  for (const s of [arabic, chinese, hindi]) assert.ok(s.length > 0, "not empty");
  assert.equal(new Set([arabic, chinese, hindi]).size, 3, "no collisions");
  assert.equal(arabic, "مفتاح-الواجهة");
  assert.equal(chinese, "数据库地址");
  assert.equal(slug("ＡＢＣ"), "abc", "NFKC folds full-width forms");
  // no letter or digit at all → a content hash, still distinct and filename-safe
  const a = slug("🔥🔥");
  const b = slug("🎉");
  assert.match(a, /^h-[0-9a-f]{10}$/);
  assert.notEqual(a, b);
  assert.equal(slug("🔥🔥"), a, "deterministic");
  for (const s of [arabic, chinese, hindi, a]) assert.ok(!/[\\/:*?"<>|\s]/.test(s), s);
});

test("stripTrailingSlashes removes only trailing slashes, in linear time", () => {
  assert.equal(stripTrailingSlashes("a/b///"), "a/b");
  assert.equal(stripTrailingSlashes("///"), "");
  assert.equal(stripTrailingSlashes("a//b"), "a//b");
  assert.equal(stripTrailingSlashes(null), "");
  const t0 = performance.now();
  assert.equal(stripTrailingSlashes(`${"/".repeat(300000)}x`).length, 300001);
  assert.ok(performance.now() - t0 < 1000);
});
