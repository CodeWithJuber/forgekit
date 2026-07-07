import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadClaims, repoLedger } from "../src/ledger_store.js";
import { ASSERTABLE_CHECKS } from "../src/uicheck.js";
import {
  conformance,
  fingerprintFiles,
  fingerprintText,
  GENERIC_SIGNATURES,
  inferSpacingBase,
  loadProjectFingerprint,
  mintProjectFingerprint,
  nearestGeneric,
  onScaleFraction,
  scaleChecks,
  slopDistance,
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
