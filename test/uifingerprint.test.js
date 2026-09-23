import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadClaims, repoLedger } from "../src/ledger_store.js";
import { ASSERTABLE_CHECKS } from "../src/uicheck.js";
import {
  activeTasteStyle,
  conformance,
  findThemeSources,
  fingerprintFiles,
  fingerprintText,
  GENERIC_SIGNATURES,
  hasDesignSignal,
  inferSpacingBase,
  loadProjectFingerprint,
  loadTasteProfile,
  loadThemeTokens,
  mintProjectFingerprint,
  nearestGeneric,
  onScaleFraction,
  overallVerdict,
  profileChecks,
  resolveCssVars,
  rgbToHsl,
  scaleChecks,
  slopDistance,
  themeFromCss,
  themeFromTailwindConfig,
  themeSourcesFor,
  UI_GATE_DEFAULTS,
  uiGate,
} from "../src/uifingerprint.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const runCli = (args, cwd) => spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "forge-uifp-"));

// The generic-template look: default-Tailwind blue/indigo, flat 8px spacing, one
// font, uniform rounded-xl, one soft shadow — must FAIL the gate.
const GENERIC_CSS = `
.card { background: #ffffff; color: #3b82f6; border: 1px solid #6366f1;
  padding: 16px; margin: 8px; gap: 32px;
  font-family: Inter, sans-serif;
  border-radius: 12px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
.hero { background: #6366f1; padding: 32px 16px; border-radius: 12px; }
`;

// A distinctive custom system: warm ink/paper neutrals + a red accent, 4-based
// spacing with real jumps, two deliberate faces, near-square corners, no shadows —
// must PASS.
const CUSTOM_CSS = `
:root { --ink: #1c1b18; --paper: #f5f1e8; --accent: #e63946; }
h1 { font-family: "Fraunces", serif; margin: 4px 0 20px; }
body { font-family: "Atkinson Hyperlegible", sans-serif; color: #1c1b18;
  background: #f5f1e8; padding: 12px 28px; }
.note { border-radius: 2px; gap: 44px; border: 2px solid #e63946; }
`;

const TW_JSX = `export const Card = () => (
  <div className="bg-blue-500 text-white p-4 m-2 gap-6 rounded-xl shadow-lg font-sans">
    <button className="px-8 py-2 bg-indigo-500 rounded-xl shadow-lg">Go</button>
  </div>);`;

test("fingerprintText: CSS fixture — palette normalized to HSL, spacing/type/shape extracted", () => {
  const fp = fingerprintText(GENERIC_CSS);
  // #fff, #3b82f6, #6366f1 (deduped), rgba(0,0,0) from the shadow.
  assert.equal(fp.paletteSize, 4);
  assert.ok(
    fp.palette.some((c) => c.h === 217 && c.s === 91),
    "blue-500 hex lands on h217",
  );
  assert.ok(
    fp.palette.some((c) => c.h === 239),
    "indigo-500 hex lands on h239",
  );
  assert.equal(fp.hueBuckets[7], 2, "both chromatic hues fall in the 210–239 bin");
  assert.deepEqual(fp.spacing, [8, 16, 32]);
  assert.equal(fp.spacingBase, 8);
  assert.equal(fp.spacingOnScale, 1);
  assert.deepEqual(fp.fontFamilies, ["inter"]);
  assert.deepEqual(fp.radii, [12]);
  assert.equal(fp.radiusLevels, 1);
  assert.equal(fp.shadowLevels, 1);
});

test("fingerprintText: Tailwind-class JSX — classes map to px / hues without any CSS", () => {
  const fp = fingerprintText(TW_JSX);
  assert.deepEqual(fp.spacing, [8, 16, 24, 32], "p-4/m-2/gap-6/px-8/py-2 → n×4 px");
  assert.equal(fp.spacingBase, 8);
  assert.ok(
    fp.palette.some((c) => c.h === 217),
    "bg-blue-500 → h217",
  );
  assert.ok(
    fp.palette.some((c) => c.s === 0 && c.l === 100),
    "text-white → neutral white",
  );
  assert.deepEqual(fp.fontFamilies, ["sans-serif"]);
  assert.deepEqual(fp.radii, [12], "rounded-xl → 12px");
  assert.equal(fp.shadowLevels, 1, "shadow-lg twice is ONE level");
});

test("fingerprintText is deterministic (same text → deep-equal vector)", () => {
  assert.deepEqual(fingerprintText(CUSTOM_CSS), fingerprintText(CUSTOM_CSS));
});

// A token-driven stylesheet: the whole 4px scale lives in custom properties and is
// only ever consumed through var() — extraction must see the full scale anyway.
const TOKEN_CSS = `
:root { --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s6: 24px; --s8: 32px;
  --r: var(--s1); --accent: #e63946; }
.card { padding: var(--s3) var(--s6); margin: var(--s2); gap: var(--s4);
  border-radius: var(--r); color: var(--accent); }
.hero { padding: var(--s8); margin-bottom: var(--s1); }
`;

test("resolveCssVars: declared tokens substitute into their var() uses", () => {
  const out = resolveCssVars(":root { --pad: 12px; } .a { padding: var(--pad); }");
  assert.match(out, /padding: 12px/);
});

test("fingerprintText: a var()-consumed 4px token scale fingerprints as the FULL scale", () => {
  const fp = fingerprintText(TOKEN_CSS);
  assert.deepEqual(fp.spacing, [4, 8, 12, 16, 24, 32], "all six token values extracted");
  assert.equal(fp.spacingBase, 4);
  assert.equal(fp.spacingOnScale, 1);
  assert.deepEqual(fp.radii, [4], "one level of nesting: --r: var(--s1) resolves");
  assert.ok(
    fp.palette.some((c) => c.h === 355),
    "the accent hex reaches color extraction through var()",
  );
});

test("resolveCssVars: var() fallback used when undeclared; declared value beats fallback", () => {
  const fp = fingerprintText(
    ":root { --gap: 24px; } .a { padding: var(--nope, 12px); margin: var(--gap, 99px); }",
  );
  assert.deepEqual(fp.spacing, [12, 24]);
  // A nested-var fallback resolves too (bounded extra text passes).
  const nested = fingerprintText(":root { --s: 20px; } .a { gap: var(--nope, var(--s, 2px)); }");
  assert.deepEqual(nested.spacing, [20]);
});

test("resolveCssVars: unresolvable var() left as-is and ignored by extractors", () => {
  const fp = fingerprintText(".a { padding: var(--ghost); margin: 8px; }");
  assert.deepEqual(fp.spacing, [8], "the unresolved var contributes nothing");
});

test("resolveCssVars: a custom-property cycle terminates (bounded loop, no hang)", () => {
  const cyclic = ":root { --a: var(--b); --b: var(--a); } .x { padding: var(--a); gap: 16px; }";
  const fp = fingerprintText(cyclic); // returning at all IS the test
  assert.deepEqual(fp.spacing, [16], "cyclic values stay invisible to extraction");
});

test("inferSpacingBase: largest base that fits wins; off-scale falls back to argmin", () => {
  assert.equal(inferSpacingBase([8, 16, 32]), 8);
  assert.equal(inferSpacingBase([4, 12, 20]), 4, "multiples of 4 but not 8 → 4, not 2");
  assert.equal(inferSpacingBase([5, 13, 21]), 2, "nothing fits cleanly → smallest residual");
  assert.equal(inferSpacingBase([]), null);
  assert.equal(onScaleFraction([8, 16, 31], 8), 2 / 3);
});

test("slopDistance: the generic fixture sits ON a signature; the custom one is far", () => {
  const generic = fingerprintText(GENERIC_CSS);
  const custom = fingerprintText(CUSTOM_CSS);
  assert.ok(slopDistance(generic) < UI_GATE_DEFAULTS.tauSlop, "generic is inside the slop radius");
  assert.equal(nearestGeneric(generic)?.id, "tailwind-default");
  assert.ok(slopDistance(custom) >= UI_GATE_DEFAULTS.tauSlop, "custom clears the slop radius");
  assert.equal(slopDistance({}), 1, "nothing measurable is not generic");
});

test("uiGate: known-generic FAILS with named, actionable violations", () => {
  const gate = uiGate(fingerprintText(GENERIC_CSS));
  assert.equal(gate.pass, false);
  const byFeature = Object.fromEntries(gate.violations.map((v) => [v.feature, v]));
  assert.ok(byFeature.palette, "the default-Tailwind palette is named");
  assert.match(byFeature.palette.hint, /brand hue/);
  assert.ok(byFeature.spacing);
  assert.match(byFeature.spacing.hint, /8px/);
  for (const v of gate.violations) assert.ok(v.hint.length > 0, "every violation carries a fix");
});

test("uiGate: distinctive custom fixture PASSES (slop-only and vs its own system)", () => {
  const custom = fingerprintText(CUSTOM_CSS);
  assert.equal(uiGate(custom).pass, true);
  const gate = uiGate(custom, { projectFp: custom });
  assert.equal(gate.pass, true);
  assert.equal(gate.conform, 0, "a fingerprint conforms perfectly to itself");
});

test("conformance: flags divergence from a provided project fingerprint", () => {
  const generic = fingerprintText(GENERIC_CSS);
  const project = fingerprintText(CUSTOM_CSS);
  assert.equal(conformance(project, project), 0);
  assert.ok(conformance(generic, project) > UI_GATE_DEFAULTS.tauConform);
  const gate = uiGate(generic, { projectFp: project });
  assert.equal(gate.pass, false);
  const type = gate.violations.find((v) => v.feature === "type" && /project/.test(v.detail));
  assert.ok(type, "font divergence from the project is a named violation");
  assert.match(type.hint, /fraunces/);
});

test("scaleChecks: off-scale spacing, level sprawl, and palette bloat all fail with hints", () => {
  const messy = {
    palette: [],
    paletteSize: 12,
    spacing: [8, 16, 31],
    spacingBase: 8,
    fontFamilies: [],
    radii: [1, 2, 3, 4, 6],
    radiusLevels: 5,
    shadowLevels: 5,
  };
  const byId = Object.fromEntries(scaleChecks(messy).map((c) => [c.id, c]));
  assert.equal(byId["spacing-scale"].pass, false);
  assert.match(byId["spacing-scale"].hint, /31/);
  assert.equal(byId["radius-levels"].pass, false);
  assert.equal(byId["shadow-levels"].pass, false);
  assert.equal(byId["palette-size"].pass, false);
  assert.ok(scaleChecks(fingerprintText(CUSTOM_CSS)).every((c) => c.pass));
});

test("scaleChecks ids are wired into uicheck's ASSERTABLE_CHECKS (no drift)", () => {
  const assertable = new Set(ASSERTABLE_CHECKS.map((c) => c.id));
  for (const c of scaleChecks(fingerprintText(GENERIC_CSS)))
    assert.ok(assertable.has(c.id), `${c.id} missing from ASSERTABLE_CHECKS`);
  assert.ok(assertable.has("contrast"), "the existing WCAG surface is untouched");
});

test("generic signatures document their rationale", () => {
  for (const sig of GENERIC_SIGNATURES) {
    assert.ok(sig.why.length > 20, `${sig.id} needs a why`);
    assert.ok(sig.hues.length >= 1);
  }
});

test("mintProjectFingerprint: claim lands in the ledger; id stable for the same inputs", () => {
  const root = tmp();
  writeFileSync(join(root, "app.css"), CUSTOM_CSS);
  const a = mintProjectFingerprint(root, ["app.css"], { t: 1 });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.existed, false);
  const b = mintProjectFingerprint(root, ["app.css"], { t: 2 });
  if (!b.ok) assert.fail(b.reason);
  else {
    assert.equal(b.id, a.id, "content-addressed: same UI surface → same claim id");
    assert.equal(b.existed, true);
  }
  const claims = loadClaims(repoLedger(root)).filter((c) => c.kind === "fingerprint");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].provenance.agent, "uicheck");
  assert.deepEqual(loadProjectFingerprint(root), a.fingerprint);
});

test("fingerprintFiles: argument order never changes the vector; missing files are skipped", () => {
  const root = tmp();
  writeFileSync(join(root, "a.css"), GENERIC_CSS);
  writeFileSync(join(root, "b.jsx"), TW_JSX);
  assert.deepEqual(
    fingerprintFiles(root, ["a.css", "b.jsx", "ghost.css"]),
    fingerprintFiles(root, ["b.jsx", "a.css"]),
  );
});

test("cli: legacy `uicheck <fg> <bg>` and new `uicheck contrast <fg> <bg>` both work", () => {
  const cwd = tmp();
  const legacy = runCli(["uicheck", "#000000", "#ffffff"], cwd);
  assert.equal(legacy.status, 0);
  assert.match(legacy.stdout, /21:1/);
  const named = runCli(["uicheck", "contrast", "#000000", "#ffffff"], cwd);
  assert.equal(named.status, 0);
  assert.match(named.stdout, /21:1/);
});

test("cli: `uicheck design` exits 1 on the generic fixture, names the fixes", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "generic.css"), GENERIC_CSS);
  const r = runCli(["uicheck", "design", "generic.css"], cwd);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /slop distance/);
  assert.match(r.stdout, /fix:/);
  assert.match(r.stdout, /FAIL/);
});

test("loadTasteProfile: all five profiles load with full constraint sets; unknown → null", () => {
  for (const name of ["brutalist", "corporate", "editorial", "minimalist", "playful"]) {
    const p = loadTasteProfile(name);
    assert.ok(p, `${name}.json loads`);
    assert.ok(p.why.length > 40, `${name} documents its rationale`);
    assert.ok(p.palette.max_hues >= 1);
    assert.ok(p.palette.chroma[0] >= 0 && p.palette.chroma[1] <= 1, "chroma is a 0-1 s-proxy");
    assert.ok(p.space.base.every((b) => [4, 8].includes(b)));
    assert.ok(p.type.max_families >= 1);
    assert.ok(p.shape.radius_levels[0] <= p.shape.radius_levels[1]);
    assert.ok(p.shape.shadow_levels[0] <= p.shape.shadow_levels[1]);
    assert.ok(p.gate.tau_slop > 0 && p.gate.tau_conform > 0);
  }
  assert.equal(loadTasteProfile("nope"), null);
  assert.equal(loadTasteProfile("../brand"), null, "a name, never a path");
});

test("taste profiles encode their prose: brutalist is square+strict, playful is rounder+looser", () => {
  const brutalist = loadTasteProfile("brutalist");
  const playful = loadTasteProfile("playful");
  const corporate = loadTasteProfile("corporate");
  assert.deepEqual(brutalist.shape.radius_levels, [0, 0], "DON'T round corners");
  assert.ok(
    brutalist.gate.tau_slop > UI_GATE_DEFAULTS.tauSlop,
    "brutalist demands MORE distance from generic",
  );
  assert.ok(playful.palette.max_hues > brutalist.palette.max_hues, "playful allows more hues");
  assert.ok(playful.shape.radius_levels[0] >= 1, "playful REQUIRES rounding");
  assert.ok(
    corporate.gate.tau_slop < UI_GATE_DEFAULTS.tauSlop,
    "corporate deliberately sits near convention",
  );
});

test("profileChecks: brutalist flags rounded/shadowed output; the custom fixture fits editorial", () => {
  const generic = fingerprintText(GENERIC_CSS); // rounded-12, one shadow, 8px base
  const byId = Object.fromEntries(
    profileChecks(generic, loadTasteProfile("brutalist")).map((c) => [c.id, c]),
  );
  assert.equal(byId["taste-radius"].pass, false, "12px radius breaks radius_levels [0,0]");
  assert.match(byId["taste-radius"].hint, /square corners/);
  assert.equal(byId["taste-spacing-base"].pass, true, "8 is in brutalist's base list");
  const custom = fingerprintText(CUSTOM_CSS); // ink/paper + one accent, 4-base, 2 faces
  assert.ok(
    profileChecks(custom, loadTasteProfile("editorial")).every((c) => c.pass),
    "the editorial-ish fixture passes the editorial constraint set",
  );
  // playful REQUIRES elevation the flat custom fixture lacks — lower bounds bind too.
  const playful = Object.fromEntries(
    profileChecks(custom, loadTasteProfile("playful")).map((c) => [c.id, c]),
  );
  assert.equal(playful["taste-shadow"].pass, false);
  assert.match(playful["taste-shadow"].hint, /at least 1/);
});

test("uiGate: taste thresholds override the defaults (same vector, different verdict)", () => {
  const custom = fingerprintText(CUSTOM_CSS);
  const slop = slopDistance(custom);
  assert.equal(uiGate(custom).pass, true, "passes the default tau");
  const strict = uiGate(custom, { tauSlop: slop + 0.01 });
  assert.equal(strict.pass, false, "a stricter profile tau flips the verdict");
  assert.ok(strict.violations.length > 0, "and still names the driving features");
});

test("cli: `uicheck design --taste <name>` uses the profile's thresholds and checks", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "app.css"), CUSTOM_CSS);
  const r = runCli(["uicheck", "design", "app.css", "--taste", "editorial", "--json"], cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.taste, "editorial");
  assert.equal(out.tauSlop, loadTasteProfile("editorial").gate.tau_slop);
  assert.ok(
    out.checks.some((c) => c.id === "taste-radius"),
    "profile checks ride along",
  );
  // brutalist's [0,0] radius bound fails the same file (it has a 2px radius).
  const b = runCli(["uicheck", "design", "app.css", "--taste", "brutalist", "--json"], cwd);
  assert.equal(b.status, 1);
  const bout = JSON.parse(b.stdout);
  assert.equal(bout.checks.find((c) => c.id === "taste-radius").pass, false);
  // An unknown explicit profile is an error, not a silent default.
  const bad = runCli(["uicheck", "design", "app.css", "--taste", "nope"], cwd);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown taste profile/);
});

test("cli: a forge-taste-managed DESIGN.md auto-picks the profile when --taste is absent", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "app.css"), CUSTOM_CSS);
  const applied = runCli(["taste", "editorial"], cwd);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(activeTasteStyle(cwd), "editorial");
  const r = runCli(["uicheck", "design", "app.css", "--json"], cwd);
  const out = JSON.parse(r.stdout);
  assert.equal(out.taste, "editorial", "the pinned style is picked up");
  assert.equal(out.tauSlop, loadTasteProfile("editorial").gate.tau_slop);
  // A hand-written (unmanaged) DESIGN.md pins nothing.
  writeFileSync(join(cwd, "DESIGN.md"), "# my own design notes\n");
  assert.equal(activeTasteStyle(cwd), null);
});

test("cli: fingerprint --mint stores the project claim; design then gates against it", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "app.css"), CUSTOM_CSS);
  const mint = runCli(["uicheck", "fingerprint", "app.css", "--mint", "--json"], cwd);
  assert.equal(mint.status, 0);
  const out = JSON.parse(mint.stdout);
  assert.equal(out.minted.ok, true);
  assert.ok(out.fingerprint.paletteSize > 0);
  const design = runCli(["uicheck", "design", "app.css", "--json"], cwd);
  assert.equal(design.status, 0, design.stdout);
  const gate = JSON.parse(design.stdout);
  assert.equal(gate.pass, true);
  assert.equal(gate.hasProjectFingerprint, true);
  assert.equal(gate.conform, 0);
});

// ---------------------------------------------------------------------------
// Token-based Tailwind: theme tokens, arbitrary values, insufficient signal.
// ---------------------------------------------------------------------------

// A Tailwind v4 stylesheet in the shape real projects ship: semantic tokens in
// `@theme inline` pointing at `:root` vars, shadcn's `hsl(var(--x))`, an oklch
// accent, a redefined default key, calc() radii and a `--color-*` reset line.
const V4_THEME_CSS = `@import "tailwindcss";
:root {
  --hl-brand: #0b6aac; --hl-fg: #0d1624; --radius: 1rem; --border: 210 21% 87%;
  --hl-shadow-2: 0 1px 2px rgb(13 22 36 / 0.06),   0 10px 28px -10px rgb(15 60 110 / 0.18);
  --color-outside: #123456;
}
@theme inline {
  --color-brand: var(--hl-brand);
  --color-fg: var(--hl-fg);
  --color-rule: hsl(var(--border));
  --color-accent: oklch(0.65 0.2 30);
  --color-blue-500: #0f75bc;
  --shadow-lift: var(--hl-shadow-2);
}
@theme {
  --color-*: initial;
  --font-display: "Fraunces", serif;
  --radius-control: 0.625rem;
  --radius-card: 1rem;
  --radius-md: calc(var(--radius) - 2px);
  --radius-pill: calc(infinity * 1px);
}
`;

// Token utilities ONLY — before this fix the fingerprint saw nothing here and the
// gate printed PASS.
const TOKEN_ONLY_TSX = `export const Card = () => (
  <div className="rounded-card bg-brand/40 text-fg shadow-lift" />
);`;

const TOKEN_TSX = `export const Card = () => (
  <div className="rounded-card bg-brand text-fg border border-rule/60 shadow-lift p-4">
    <button className="rounded-control rounded-t-md bg-blue-500 text-[#fff] ring-accent">Go</button>
  </div>
);`;

const hex = (h) =>
  rgbToHsl(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));

test("themeFromCss: @theme --color-*/--radius-*/--shadow-* land with var(), hsl(var()), oklch and calc() resolved", () => {
  const theme = themeFromCss(V4_THEME_CSS);
  assert.deepEqual(theme.colors.get("brand"), hex("#0b6aac"));
  assert.deepEqual(theme.colors.get("fg"), hex("#0d1624"));
  assert.deepEqual(theme.colors.get("rule"), hex("#d7dee5"), "shadcn hsl(var(--border))");
  assert.ok(theme.colors.get("accent"), "oklch token parsed");
  assert.deepEqual(theme.colors.get("blue-500"), hex("#0f75bc"));
  assert.equal(theme.colors.has("outside"), false, "only @theme declarations are tokens");
  assert.equal(theme.colors.has("*"), false, "the --color-* reset line is not a key");
  assert.equal(theme.radius.get("control"), 10);
  assert.equal(theme.radius.get("card"), 16);
  assert.equal(theme.radius.get("md"), 14, "calc(1rem - 2px)");
  assert.equal(theme.radius.get("pill"), 9999, "calc(infinity * 1px) is a pill");
  assert.equal(
    theme.shadow.get("lift"),
    "0 1px 2px rgb(13 22 36 / 0.06), 0 10px 28px -10px rgb(15 60 110 / 0.18)",
    "whitespace-normalized value",
  );
  assert.equal(theme.vars.get("--radius"), "1rem", "the sources' custom properties ride along");
});

test("fingerprintText: token utilities resolve through the theme (rounded-*/shadow-*/bg|text|border|ring-*)", () => {
  const theme = themeFromCss(V4_THEME_CSS);
  const fp = fingerprintText(TOKEN_TSX, { theme });
  assert.deepEqual(
    fp.radii,
    [10, 14, 16],
    "rounded-control, rounded-t-md (theme md), rounded-card",
  );
  assert.equal(fp.shadowLevels, 1, "shadow-lift");
  for (const c of ["#0b6aac", "#0d1624", "#d7dee5", "#0f75bc", "#ffffff"])
    assert.ok(
      fp.palette.some((p) => JSON.stringify(p) === JSON.stringify(hex(c))),
      `${c} in palette`,
    );
  assert.ok(
    !fp.palette.some((p) => p.h === 217 && p.s === 91),
    "a theme-redefined blue-500 replaces the default-family approximation",
  );
  assert.equal(fp.paletteSize, 6, "brand, fg, rule, accent, blue-500, #fff");
  // The same markup without the theme only sees the default-key utilities.
  const bare = fingerprintText(TOKEN_TSX);
  assert.deepEqual(bare.radii, [6], "only rounded-t-md, at Tailwind's default 6px");
  assert.equal(bare.shadowLevels, 0);
});

test("hasDesignSignal: token-only markup is empty without its theme, measurable with it", () => {
  assert.equal(hasDesignSignal(fingerprintText("")), false, "an empty file");
  assert.equal(hasDesignSignal(fingerprintText("export const C = () => <div/>;")), false);
  assert.equal(hasDesignSignal(fingerprintText(TOKEN_ONLY_TSX)), false, "no theme → nothing");
  const fp = fingerprintText(TOKEN_ONLY_TSX, { theme: themeFromCss(V4_THEME_CSS) });
  assert.equal(hasDesignSignal(fp), true);
  assert.deepEqual(fp.radii, [16]);
  assert.equal(fp.shadowLevels, 1);
  assert.equal(fp.paletteSize, 2, "bg-brand/40 (opacity modifier ignored) + text-fg");
});

test("fingerprintText: arbitrary values — rounded-[..], shadow-[..], p-[..], text-[#..], bg-[oklch(..)]", () => {
  const fp = fingerprintText(
    `<div className="rounded-[13px] rounded-tl-[0.5rem] shadow-[0_1px_2px_#000] shadow-[0_8px_30px_#0003] p-[13px] mt-[7px] px-[3px_5px] text-[#abcdef] bg-[oklch(0.6_0.1_250)] bg-[rgb(10_20_30)] text-[13px] bg-[url(/x.png)]" />`,
  );
  assert.deepEqual(fp.radii, [8, 13]);
  assert.equal(fp.shadowLevels, 2);
  assert.deepEqual(fp.spacing, [3, 5, 7, 13]);
  assert.ok(fp.palette.some((p) => JSON.stringify(p) === JSON.stringify(hex("#abcdef"))));
  assert.ok(fp.palette.some((p) => JSON.stringify(p) === JSON.stringify(hex("#0a141e"))));
  // #abcdef, oklch, rgb(10 20 30), and #000 / #0003 inside the arbitrary shadows;
  // text-[13px] (a size) and bg-[url()] are not colors.
  assert.equal(fp.paletteSize, 4, JSON.stringify(fp.palette));
});

test("fingerprintText: oklch() in plain CSS counts as a color (Tailwind v4's default syntax)", () => {
  const fp = fingerprintText(".a { color: oklch(62.8% 0.2577 29.23); }");
  assert.equal(fp.paletteSize, 1);
  assert.equal(fp.palette[0].h, 0, "sRGB red");
});

test("resolveCssVars: `vars` seeds outside declarations; the text's own still win", () => {
  const vars = new Map([["--brand", "#123456"]]);
  assert.match(resolveCssVars(".a { color: var(--brand); }", { vars }), /color: #123456/);
  assert.match(
    resolveCssVars(":root { --brand: #abcdef; } .a { color: var(--brand); }", { vars }),
    /color: #abcdef/,
  );
});

const V3_CONFIG = `/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors");
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ...colors,
        brand: { DEFAULT: "#0f75bc", soft: 'hsl(var(--brand-soft))', 900: "#00355b" },
        "on-brand": "#ffffff", // trailing comment
        /* block comment */ dynamic: \`\${"x"}\`,
        computed: someFn("#000", { nested: true }),
        [key]: "#111111",
      },
      borderRadius: { DEFAULT: "6px", card: "1rem", huge: "calc(infinity * 1px)", half: "50%" },
      boxShadow: { lift: "0 10px 28px -10px rgba(15, 60, 110, 0.18)" },
    },
  },
  plugins: [require("@tailwindcss/forms")],
};
`;

test("themeFromTailwindConfig: v3 objects read statically — nested families, DEFAULT, var() via stylesheet vars", () => {
  const vars = new Map([["--brand-soft", "205 90% 95%"]]);
  const theme = themeFromTailwindConfig(V3_CONFIG, { vars });
  assert.deepEqual([...theme.colors.keys()].sort(), [
    "brand",
    "brand-900",
    "brand-soft",
    "on-brand",
  ]);
  assert.deepEqual(theme.colors.get("brand"), hex("#0f75bc"));
  assert.ok(theme.colors.get("brand-soft"), "hsl(var(--brand-soft)) resolved through vars");
  assert.equal(theme.radius.get(""), 6, "DEFAULT → the bare `rounded`");
  assert.equal(theme.radius.get("card"), 16);
  assert.equal(theme.radius.get("huge"), 9999);
  assert.equal(theme.radius.has("half"), false, "a % radius is not an absolute length");
  assert.equal(theme.shadow.get("lift"), "0 10px 28px -10px rgba(15, 60, 110, 0.18)");
  // Spreads, template literals with ${}, calls and computed keys are skipped, not run.
  assert.equal(theme.colors.has("dynamic"), false);
  assert.equal(theme.colors.has("computed"), false);
  const fp = fingerprintText(`<b className="rounded bg-brand-900 shadow-lift" />`, { theme });
  assert.deepEqual(fp.radii, [6], "bare rounded uses the configured DEFAULT");
});

/** A little Next.js-shaped project with a v4 theme and decoys discovery must skip. */
function themeRepo() {
  const root = tmp();
  mkdirSync(join(root, "src", "app"), { recursive: true });
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".claude", "worktrees", "old", "src"), { recursive: true });
  writeFileSync(join(root, "src", "app", "globals.css"), V4_THEME_CSS);
  writeFileSync(join(root, "src", "app", "plain.css"), ".x { color: red; }");
  writeFileSync(join(root, "src", "components", "Card.tsx"), TOKEN_TSX);
  writeFileSync(join(root, "src", "components", "Token.tsx"), TOKEN_ONLY_TSX);
  writeFileSync(join(root, "node_modules", "pkg", "theme.css"), "@theme { --radius-x: 1px; }");
  writeFileSync(
    join(root, ".claude", "worktrees", "old", "src", "globals.css"),
    "@theme { --radius-card: 99px; }",
  );
  return root;
}

test("findThemeSources: @theme/@tailwind stylesheets + tailwind.config; node_modules and dot-dirs skipped", () => {
  const root = themeRepo();
  assert.deepEqual(findThemeSources(root), ["src/app/globals.css"]);
  writeFileSync(join(root, "tailwind.config.ts"), V3_CONFIG);
  writeFileSync(join(root, "src", "app", "legacy.css"), "@tailwind base;\n@tailwind utilities;");
  assert.deepEqual(findThemeSources(root), [
    "src/app/globals.css",
    "src/app/legacy.css",
    "tailwind.config.ts",
  ]);
  assert.deepEqual(findThemeSources(root, { maxDepth: 0 }), ["tailwind.config.ts"]);
});

test("themeSourcesFor: explicit --theme replaces discovery; a theme-bearing input always counts", () => {
  const root = themeRepo();
  writeFileSync(join(root, "tokens.css"), "@theme { --radius-card: 2px; }");
  assert.deepEqual(themeSourcesFor(root, ["src/components/Card.tsx"]), [
    "src/app/globals.css",
    "tokens.css",
  ]);
  assert.deepEqual(themeSourcesFor(root, ["src/components/Card.tsx"], ["./tokens.css"]), [
    "tokens.css",
  ]);
  assert.deepEqual(
    themeSourcesFor(root, ["./src/app/globals.css", "src/components/Card.tsx"], ["tokens.css"]),
    ["src/app/globals.css", "tokens.css"],
    "normalized + deduplicated",
  );
});

test("loadThemeTokens: stylesheets read together, config merged under them, unreadable paths dropped", () => {
  const root = themeRepo();
  writeFileSync(join(root, "tailwind.config.js"), V3_CONFIG);
  // brand is #0f75bc in the config but var(--hl-brand) = #0b6aac in the v4 @theme.
  const theme = loadThemeTokens(root, ["tailwind.config.js", "src/app/globals.css", "ghost.css"]);
  assert.deepEqual(theme.sources, ["src/app/globals.css", "tailwind.config.js"]);
  assert.deepEqual(theme.colors.get("brand"), hex("#0b6aac"), "@theme wins on conflict");
  assert.deepEqual(theme.colors.get("brand-900"), hex("#00355b"), "config-only keys survive");
  assert.equal(theme.radius.get("card"), 16);
  assert.equal(theme.shadow.has("lift"), true);
});

test("uiGate: an empty vector is insufficient-signal — not PASS — with a named fix", () => {
  const gate = uiGate(fingerprintText("export const C = () => <div/>;"));
  assert.equal(gate.pass, false);
  assert.equal(gate.verdict, "insufficient-signal");
  assert.equal(gate.violations[0].feature, "signal");
  assert.match(gate.violations[0].hint, /--theme/);
  // Even against a project fingerprint, nothing measured is not "conforming".
  const vsProject = uiGate(fingerprintText(""), { projectFp: fingerprintText(CUSTOM_CSS) });
  assert.equal(vsProject.verdict, "insufficient-signal");
  assert.equal(uiGate(fingerprintText(CUSTOM_CSS)).verdict, "pass");
  assert.equal(uiGate(fingerprintText(GENERIC_CSS)).verdict, "fail");
});

test("overallVerdict: failing checks turn a gate PASS into FAIL; insufficient-signal always survives", () => {
  const ok = [{ pass: true }];
  const bad = [{ pass: false }];
  assert.equal(overallVerdict({ pass: true, verdict: "pass" }, ok), "pass");
  assert.equal(overallVerdict({ pass: true, verdict: "pass" }, bad), "fail");
  assert.equal(overallVerdict({ pass: false, verdict: "fail" }, ok), "fail");
  assert.equal(
    overallVerdict({ pass: false, verdict: "insufficient-signal" }, ok),
    "insufficient-signal",
  );
});

test("mintProjectFingerprint: the minted vector includes theme-resolved tokens", () => {
  const root = themeRepo();
  const theme = loadThemeTokens(root, ["src/app/globals.css"]);
  const m = mintProjectFingerprint(root, ["src/components/Card.tsx"], { t: 1, theme });
  assert.equal(m.ok, true);
  assert.ok(m.ok);
  assert.deepEqual(m.fingerprint.radii, [10, 14, 16]);
  assert.deepEqual(loadProjectFingerprint(root).radii, [10, 14, 16]);
});

test("cli: `uicheck design` on an empty file is INSUFFICIENT SIGNAL with a non-zero exit", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "empty.tsx"), "");
  const r = runCli(["uicheck", "design", "empty.tsx"], cwd);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /INSUFFICIENT SIGNAL/);
  assert.doesNotMatch(r.stdout, /✓ PASS/);
  const j = runCli(["uicheck", "design", "empty.tsx", "--json"], cwd);
  assert.equal(j.status, 1);
  const out = JSON.parse(j.stdout);
  assert.equal(out.verdict, "insufficient-signal");
  assert.equal(out.pass, false);
});

test("cli: `uicheck design|fingerprint` discover a Tailwind v4 @theme and resolve token utilities", () => {
  const cwd = themeRepo();
  const fp = runCli(["uicheck", "fingerprint", "src/components/Card.tsx", "--json"], cwd);
  assert.equal(fp.status, 0, fp.stderr);
  const vec = JSON.parse(fp.stdout);
  assert.deepEqual(vec.radii, [10, 14, 16]);
  assert.equal(vec.shadowLevels, 1);
  const text = runCli(["uicheck", "fingerprint", "src/components/Card.tsx"], cwd);
  assert.match(text.stdout, /theme: +src\/app\/globals\.css \(\d+ color · 4 radius · 1 shadow/);
  // The token-only component: PASS-by-emptiness before; measured (and gated) now.
  const d = runCli(["uicheck", "design", "src/components/Token.tsx", "--json"], cwd);
  const out = JSON.parse(d.stdout);
  assert.notEqual(out.verdict, "insufficient-signal");
  assert.deepEqual(out.theme.sources, ["src/app/globals.css"]);
  assert.equal(out.theme.radius, 4);
});

test("cli: `--theme <file>` names the theme explicitly; a valueless --theme is a usage error", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".design"));
  // Hidden from discovery (dot-dir) — only the explicit flag can find it.
  writeFileSync(join(cwd, ".design", "theme.css"), V4_THEME_CSS);
  writeFileSync(join(cwd, "Token.tsx"), TOKEN_ONLY_TSX);
  const none = runCli(["uicheck", "design", "Token.tsx", "--json"], cwd);
  assert.equal(JSON.parse(none.stdout).verdict, "insufficient-signal");
  const named = runCli(
    ["uicheck", "design", "Token.tsx", "--theme", ".design/theme.css", "--json"],
    cwd,
  );
  const out = JSON.parse(named.stdout);
  assert.notEqual(out.verdict, "insufficient-signal");
  assert.deepEqual(out.theme.sources, [".design/theme.css"]);
  const bad = runCli(["uicheck", "design", "Token.tsx", "--theme"], cwd);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: .*--theme <css\|tailwind\.config>/);
  const ghost = runCli(["uicheck", "design", "Token.tsx", "--theme", "nope.css"], cwd);
  assert.equal(ghost.status, 1, "a named theme that isn't there is an error, not a no-op");
  assert.match(ghost.stderr, /theme source not found: nope\.css/);
});
