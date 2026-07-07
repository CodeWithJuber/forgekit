import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fingerprintText } from "../src/uifingerprint.js";
import {
  computedStylesToCss,
  DEFAULT_VIEWPORTS,
  renderedFingerprint,
  resolvePlaywright,
  resolveTarget,
  visualGate,
} from "../src/uivisual.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const DASH = fileURLToPath(new URL("../src/dash.html", import.meta.url));
const runCli = (args, cwd, env = {}) =>
  spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const tmp = () => mkdtempSync(join(tmpdir(), "forge-uiv-"));

// Run a block with FORGE_PLAYWRIGHT forced to a value (undefined = unset), restored
// even on failure — resolution must be deterministic regardless of the machine.
async function withPw(value, fn) {
  const prev = process.env.FORGE_PLAYWRIGHT;
  if (value === undefined) delete process.env.FORGE_PLAYWRIGHT;
  else process.env.FORGE_PLAYWRIGHT = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_PLAYWRIGHT;
    else process.env.FORGE_PLAYWRIGHT = prev;
  }
}

// ---------------------------------------------------------------------------
// resolveTarget — the security guard (no browser involved).
// ---------------------------------------------------------------------------

test("resolveTarget: local file → file:// URL; missing file refused", () => {
  const ok = resolveTarget(DASH);
  assert.equal(ok.ok, true);
  assert.ok(ok.url.startsWith("file://") && ok.url.endsWith("dash.html"));
  const rel = resolveTarget("src/dash.html", { cwd: join(DASH, "..", "..") });
  assert.equal(rel.ok, true);
  const missing = resolveTarget("no/such/page.html", { cwd: tmp() });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no such file/);
  assert.equal(resolveTarget("").ok, false);
});

test("resolveTarget: loopback http allowed, non-local refused by default, --remote overrides", () => {
  for (const u of [
    "http://localhost:3000/app",
    "http://127.0.0.1:8080",
    "http://127.1.2.3/x",
    "http://foo.localhost/x",
    "http://[::1]:5173/",
  ])
    assert.equal(resolveTarget(u).ok, true, u);
  const refused = resolveTarget("https://example.com/page");
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /exfiltration/);
  assert.match(refused.reason, /--remote/);
  // a lookalike host must NOT pass the .localhost suffix rule
  assert.equal(resolveTarget("http://evil-localhost.example.com").ok, false);
  assert.equal(resolveTarget("https://example.com/page", { remote: true }).ok, true);
  // non-web schemes are never navigated
  assert.equal(resolveTarget("ftp://example.com/x").ok, false);
  assert.equal(resolveTarget("javascript:alert(1)").ok, false);
});

// ---------------------------------------------------------------------------
// Computed styles → the shared fingerprint vector (mocked records, no browser).
// ---------------------------------------------------------------------------

// What Chromium's getComputedStyle would hand back for a dash.html-like system:
// resolved rgb() colors, px-resolved spacing, two radius levels on a 4px base.
const DASH_LIKE = [
  {
    color: "rgb(242, 237, 231)",
    backgroundColor: "rgb(32, 26, 21)",
    margin: "0px 0px 12px",
    padding: "12px 24px",
    gap: "16px",
    fontFamily: "ui-monospace, Menlo, monospace",
    borderRadius: "10px",
    boxShadow: "none",
  },
  {
    color: "rgb(242, 100, 48)",
    backgroundColor: "rgba(0, 0, 0, 0)", // transparent — must NOT vote black
    margin: "0px",
    padding: "4px 8px",
    gap: "normal",
    fontFamily: "system-ui, sans-serif",
    borderRadius: "4px",
    boxShadow: "none",
  },
];

test("computedStylesToCss: maps records onto fingerprintText's exact vector shape", () => {
  const css = computedStylesToCss(DASH_LIKE);
  const fp = fingerprintText(css);
  assert.deepEqual(fp.spacing, [4, 8, 12, 16, 24]); // zeros skipped, px resolved
  assert.equal(fp.spacingBase, 4);
  assert.deepEqual(fp.radii, [4, 10]);
  assert.equal(fp.radiusLevels, 2);
  assert.deepEqual(fp.fontFamilies, ["system-ui", "ui-monospace"]); // first face of each stack
  assert.equal(fp.shadowLevels, 0); // "none" never becomes a level
  // 3 colors: fg, panel bg, ember — the rgba(0,0,0,0) background is filtered
  assert.equal(fp.paletteSize, 3);
  assert.ok(!fp.palette.some((c) => c.l === 0 && c.s === 0), "transparent must not read as black");
});

test("computedStylesToCss: dedupes identical records, skips empty ones", () => {
  const one = computedStylesToCss([DASH_LIKE[0]]);
  const twice = computedStylesToCss([DASH_LIKE[0], { ...DASH_LIKE[0] }]);
  assert.equal(twice, one);
  assert.equal(computedStylesToCss([]), "");
  assert.equal(computedStylesToCss([{ color: "", boxShadow: "none", gap: "normal normal" }]), "");
});

// ---------------------------------------------------------------------------
// Graceful absence — the optional tier missing is a note, never a crash.
// ---------------------------------------------------------------------------

test("resolvePlaywright: FORGE_PLAYWRIGHT at a nonexistent module → null, and rendering skips", async () => {
  await withPw("/nonexistent/pw-module", async () => {
    assert.equal(await resolvePlaywright(), null);
    const r = await renderedFingerprint(DASH, { root: tmp() });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /playwright/i);
  });
});

test("cli: uicheck visual without a browser runtime exits 0 with a skipped note", () => {
  const r = runCli(["uicheck", "visual", DASH], tmp(), { FORGE_PLAYWRIGHT: "/nonexistent/pw" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped \(no browser runtime\)/);
  assert.match(r.stdout, /npm i -D playwright-core/);
  assert.match(r.stdout, /FORGE_PLAYWRIGHT/);
  const j = runCli(["uicheck", "visual", DASH, "--json"], tmp(), {
    FORGE_PLAYWRIGHT: "/nonexistent/pw",
  });
  assert.equal(j.status, 0);
  assert.equal(JSON.parse(j.stdout).skipped, true);
});

test("cli: uicheck visual refuses non-local URLs (exit 1) before any browser work", () => {
  const r = runCli(["uicheck", "visual", "https://example.com/x"], tmp(), {
    FORGE_PLAYWRIGHT: "/nonexistent/pw", // guard must fire even without a runtime
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing non-local URL/);
  assert.match(r.stderr, /--remote/);
});

test("cli: uicheck visual usage errors (no target, valueless --taste, unknown taste)", () => {
  const env = { FORGE_PLAYWRIGHT: "/nonexistent/pw" };
  const none = runCli(["uicheck", "visual"], tmp(), env);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /usage: .*uicheck visual/);
  const dangling = runCli(["uicheck", "visual", DASH, "--taste"], tmp(), env);
  assert.equal(dangling.status, 1);
  // an unknown EXPLICIT taste fails before rendering, mirroring `design --taste`
  const unknown = runCli(["uicheck", "visual", DASH, "--taste", "nope"], tmp(), env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown taste profile "nope"/);
});

test("visualGate: unresolvable target is a plain error, not a skip", async () => {
  await withPw("/nonexistent/pw-module", async () => {
    const r = await visualGate("no/such.html", { root: tmp() });
    assert.equal(r.ok, false);
    assert.notEqual(r.skipped, true);
    assert.match(r.reason, /no such file/);
  });
});

// ---------------------------------------------------------------------------
// The live loop — auto-skips unless a playwright runtime resolves (point
// FORGE_PLAYWRIGHT at an install, e.g. .../node_modules/playwright-core, to run it).
// ---------------------------------------------------------------------------

test("live: renders dash.html and the computed styles fingerprint to the same system the static gate sees", async (t) => {
  const pw = await resolvePlaywright();
  if (!pw) {
    t.skip("no playwright runtime — set FORGE_PLAYWRIGHT=/path/to/node_modules/playwright-core");
    return;
  }
  const root = tmp();
  const r = await visualGate(DASH, { root, pw });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.ok(r.ok); // narrow
  // The rendered reality must agree with what the static fingerprint found in the
  // source: dash.html's 4px spacing base and its two deliberate radius levels.
  assert.equal(r.fingerprint.spacingBase, 4);
  assert.ok(
    r.fingerprint.radiusLevels <= 2,
    `expected ≤2 rendered radius levels, got ${r.fingerprint.radiusLevels} [${r.fingerprint.radii}]`,
  );
  assert.ok(r.elements > 20, "should have fingerprinted many visible elements");
  assert.equal(r.screenshots.length, DEFAULT_VIEWPORTS.length);
  for (const s of r.screenshots) {
    assert.ok(s.includes(`${sep}.forge${sep}ui${sep}`), s);
    assert.ok(existsSync(s), `screenshot missing: ${s}`);
  }
  assert.match(r.screenshots[0], /dash-1280x800\.png$/);
  assert.match(r.screenshots[1], /dash-390x844\.png$/);
});
