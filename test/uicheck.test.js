import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASSERTABLE_CHECKS,
  compositeOver,
  contrastRatio,
  contrastReport,
  parseColor,
  relativeLuminance,
  toHex,
  wcagLevel,
} from "../src/uicheck.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const runCli = (args) =>
  spawnSync("node", [CLI, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "forge-uicheck-")),
    encoding: "utf8",
  });

test("relativeLuminance: black=0, white=1", () => {
  assert.equal(Math.round(relativeLuminance("#000000") * 1000), 0);
  assert.equal(Math.round(relativeLuminance("#ffffff") * 1000), 1000);
});

test("contrastRatio: black-on-white is the max 21:1; identical colors are 1:1", () => {
  assert.equal(Math.round(contrastRatio("#000", "#fff")), 21);
  assert.equal(Math.round(contrastRatio("#777", "#777")), 1);
});

test("wcagLevel: #999 on white FAILS AA (~2.85); #595959 passes AA; #000 is AAA", () => {
  assert.equal(wcagLevel(contrastRatio("#999999", "#ffffff")).level, "fail");
  assert.equal(wcagLevel(contrastRatio("#595959", "#ffffff")).passesAA, true);
  assert.equal(wcagLevel(contrastRatio("#000000", "#ffffff")).level, "AAA");
});

test("wcagLevel: the large-text threshold is looser (3:1)", () => {
  const r = contrastRatio("#949494", "#ffffff"); // ~3.0
  assert.equal(wcagLevel(r, { large: true }).passesAA, true);
  assert.equal(wcagLevel(r, { large: false }).passesAA, false);
});

test("bad hex throws (never silently mis-report a color)", () => {
  assert.throws(() => contrastRatio("nope", "#fff"));
});

test("the assertable checklist is exposed for the verifier + docs", () => {
  assert.ok(ASSERTABLE_CHECKS.some((c) => c.id === "contrast"));
  assert.ok(ASSERTABLE_CHECKS.some((c) => c.id === "focus-visible"));
});

// Channel-wise closeness: oklch/hsl → sRGB is float math; ±1 of 255 is exact enough.
const near = (actual, [r, g, b], tol = 1) =>
  assert.ok(
    Math.abs(actual.r - r) <= tol && Math.abs(actual.g - g) <= tol && Math.abs(actual.b - b) <= tol,
    `${JSON.stringify(actual)} ≉ [${r}, ${g}, ${b}]`,
  );

test("parseColor: hex in every length — #rgb, #rgba, #rrggbb, #rrggbbaa, and a bare (unquoted-shell) form", () => {
  assert.deepEqual(parseColor("#777"), { r: 119, g: 119, b: 119, a: 1 });
  assert.deepEqual(parseColor("777"), { r: 119, g: 119, b: 119, a: 1 }, "`#` is a shell comment");
  assert.deepEqual(parseColor("#0f75bc"), { r: 15, g: 117, b: 188, a: 1 });
  assert.equal(parseColor("#fff8").a, 0x88 / 255);
  assert.equal(parseColor("#00000080").a, 0x80 / 255);
});

test("parseColor: rgb()/hsl() in legacy comma and modern `/ alpha` syntax", () => {
  assert.deepEqual(parseColor("rgb(0 0 0 / 50%)"), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor("rgba(255, 0, 0, .25)"), { r: 255, g: 0, b: 0, a: 0.25 });
  near(parseColor("rgb(100% 0% 0%)"), [255, 0, 0]);
  // hsl(210 21% 87%) is shadcn's `hsl(var(--border))` shape; #d7dee5 cross-checked
  // against Python's colorsys.hls_to_rgb.
  assert.equal(toHex(parseColor("hsl(210 21% 87%)")), "#d7dee5");
  assert.equal(toHex(parseColor("hsl(210deg, 21%, 87%)")), "#d7dee5");
  assert.equal(toHex(parseColor("hsl(0.5turn 50 50)")), "#40bfbf", "bare s/l numbers are %");
  assert.equal(parseColor("hsla(0, 0%, 0%, 0.3)").a, 0.3);
});

test("parseColor: oklch()/oklab() convert to sRGB (CSS Color 4 reference points)", () => {
  // The CSS Color 4 spec's worked example: sRGB red is oklch(62.8% 0.2577 29.23).
  near(parseColor("oklch(62.8% 0.2577 29.23)"), [255, 0, 0]);
  near(parseColor("oklab(0.628 0.2249 0.1258)"), [255, 0, 0]);
  near(parseColor("oklch(1 0 0)"), [255, 255, 255]);
  near(parseColor("oklch(0 0 0)"), [0, 0, 0]);
  // Tailwind v4's default blue-500 (its documented sRGB fallback is #2b7fff).
  assert.equal(toHex(parseColor("oklch(0.623 0.214 259.815)")), "#2b7fff");
  assert.equal(parseColor("oklch(0.5 0.1 250 / 40%)").a, 0.4);
});

test("parseColor: named black/white/transparent; anything unrecognized throws, never guesses", () => {
  assert.deepEqual(parseColor("White"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor("transparent").a, 0);
  for (const bad of ["nope", "#12345", "rgb(1 2)", "rgb(1,2,3,4,5)", "hsl(x y z)", "rgb(1 2 3 / )"])
    assert.throws(() => parseColor(bad), /bad color/, bad);
});

test("compositeOver: source-over in sRGB — 50% black on white paints mid-grey", () => {
  const out = compositeOver(parseColor("rgb(0 0 0 / 50%)"), parseColor("#fff"));
  assert.equal(out.a, 1);
  assert.equal(toHex(out), "#808080");
});

test("contrastRatio: a translucent foreground is measured on what it paints", () => {
  // 50% black over white paints #808080 → 3.95:1, NOT black's 21:1.
  const r = contrastRatio("rgb(0 0 0 / 50%)", "#ffffff");
  assert.equal(Math.round(r * 100) / 100, Math.round(contrastRatio("#808080", "#fff") * 100) / 100);
  assert.ok(r < 4.5, "the opaque-black ratio would have hidden this AA failure");
  // A translucent background is composited over white first.
  assert.equal(Math.round(contrastRatio("#000", "rgb(0 0 0 / 0%)")), 21);
  assert.equal(Math.round(relativeLuminance("#ffffff80") * 1000), 1000, "over white");
});

test("contrastReport: verdict, thresholds, composited hexes and notes in one object", () => {
  const r = contrastReport("#777", "#fff");
  assert.equal(r.ratio, 4.48);
  assert.equal(r.passesAA, false);
  assert.equal(r.level, "fail");
  assert.deepEqual(r.required, { aa: 4.5, aaa: 7 });
  assert.deepEqual(r.notes, []);
  const large = contrastReport("#777", "#fff", { large: true });
  assert.equal(large.passesAA, true, "3:1 is the large-text bar");
  assert.equal(large.level, "AA");
  assert.deepEqual(large.required, { aa: 3, aaa: 4.5 });
  const alpha = contrastReport("rgb(0 0 0 / 50%)", "rgb(255 255 255 / 50%)");
  assert.equal(alpha.bgHex, "#ffffff");
  assert.equal(alpha.fgHex, "#808080");
  assert.equal(alpha.notes.length, 2, "both compositing steps are disclosed");
});

test("cli: `uicheck contrast` exits 1 when AA fails, 0 when it passes", () => {
  const fail = runCli(["uicheck", "contrast", "#777", "#fff"]);
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  assert.match(fail.stdout, /4\.48:1/);
  assert.match(fail.stdout, /FAILS AA/);
  const legacy = runCli(["uicheck", "#777", "#fff"]);
  assert.equal(legacy.status, 1, "the bare legacy form gates too");
  const pass = runCli(["uicheck", "contrast", "#595959", "#fff"]);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
});

test("cli: `uicheck contrast --large` applies the 3:1 bar", () => {
  const r = runCli(["uicheck", "contrast", "#777", "#fff", "--large"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /passes AA for large text/);
  const worse = runCli(["uicheck", "contrast", "--large", "#aaa", "#fff"]);
  assert.equal(worse.status, 1, "flags may come first; #aaa is 2.32:1, under 3:1 too");
});

test("cli: `uicheck contrast --json` emits the report; oklch/rgb-alpha inputs are accepted", () => {
  const r = runCli(["uicheck", "contrast", "rgb(0 0 0 / 50%)", "#fff", "--json"]);
  assert.equal(r.status, 1, "3.95:1 fails AA");
  const out = JSON.parse(r.stdout);
  assert.equal(out.passesAA, false);
  assert.equal(out.fgHex, "#808080");
  assert.equal(out.large, false);
  assert.equal(out.notes.length, 1);
  const ok = runCli(["uicheck", "contrast", "oklch(0.2 0.02 250)", "oklch(0.98 0 0)", "--json"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).passesAA, true);
});

test("cli: `uicheck contrast` usage and bad-color errors exit 1 (JSON error under --json)", () => {
  const usage = runCli(["uicheck", "contrast", "#777"]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: .*contrast <fg> <bg> \[--large\] \[--json\]/);
  const bad = runCli(["uicheck", "contrast", "nope", "#fff", "--json"]);
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /bad color: nope/);
});
