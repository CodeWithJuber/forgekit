import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collect, render } from "../scripts/build-pages.mjs";
import { BRAND, spaceScaleCss, typeScaleCss } from "../src/brand.js";

const repo = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const landing = repo("landing/index.html");

test("pages renderer uses repo data and accessible landmarks", async () => {
  const data = await collect({ live: false });
  const html = render(data);
  assert.match(html, /<main id="top">/);
  assert.match(html, /aria-label="Primary"/);
  assert.match(html, /Data Sources/);
  assert.match(html, new RegExp(`v${data.version}`));
  assert.doesNotMatch(html, /lorem ipsum/i);
});

// One design system, enforced. The landing page and the generated status page must not
// drift apart the way they had (two palettes claiming to be one, a webfont that never
// loaded, an empty changes list, hardcoded metrics). Each assertion below is a defect that
// silently returned before nothing checked it.

test("landing + status derive the SAME palette from brand.json (one source, dark+light)", async () => {
  const status = render(await collect({ live: false }));
  // brand.json.colors is the single source of the palette. Every hex it defines — for BOTH
  // schemes — must appear verbatim on both public pages. Change a hex there and this fails
  // until every surface is updated, which is what makes brand.json the source of truth.
  const hexes = (palette) =>
    Object.values(palette).filter((v) => v.startsWith("#"));
  for (const [scheme, palette] of Object.entries(BRAND.colors)) {
    for (const hex of hexes(palette)) {
      assert.ok(
        landing.includes(hex),
        `landing missing ${scheme} token ${hex} (brand.json.colors.${scheme})`,
      );
      assert.ok(
        status.includes(hex),
        `status missing ${scheme} token ${hex} (brand.json.colors.${scheme})`,
      );
    }
  }
});

test("the status page derives its fluid type scale + spacing scale from the formula", async () => {
  // Same discipline as the color-parity test above, extended to typography and
  // spacing: src/brand.js computes every --fs-N / --sp-N token from a formula
  // (fluid clamp() interpolation for type, base-unit multiples for spacing), so the
  // page may not hand-pick its own font-size or margin/padding/gap magic numbers.
  //
  // Scope note: this is enforced on the generated status page only. The landing page
  // intentionally uses an editorial scale tuned for its product narrative. Color and
  // font-stack parity ARE still enforced on both pages above.
  const norm = (s) => s.replace(/\s+/g, "");
  const status = norm(render(await collect({ live: false })));
  for (const decl of typeScaleCss().split(";"))
    assert.ok(status.includes(norm(decl)), `status missing type token ${decl}`);
  for (const decl of spaceScaleCss().split(";"))
    assert.ok(
      status.includes(norm(decl)),
      `status missing space token ${decl}`,
    );
});

test("landing declares no webfont it fails to load (no phantom Inter)", () => {
  const sans = landing.match(/--sans:\s*([^;]+);/)?.[1] ?? "";
  assert.ok(
    sans.includes("system-ui"),
    "landing --sans should be a system stack",
  );
  // If the CSS names a webfont family, it must actually load it (@font-face / <link>).
  if (/\bInter\b/.test(landing)) {
    assert.match(
      landing,
      /@font-face|rel=["']?stylesheet/,
      "Inter named but never loaded",
    );
  }
});

test("status page 'Latest changes' list is never empty", async () => {
  const status = render(await collect({ live: false }));
  const list = status.match(
    /Latest repo changes<\/h2>[\s\S]*?<ul class="list">([\s\S]*?)<\/ul>/,
  );
  assert.ok(list, "the changes section renders");
  const items = [...list[1].matchAll(/<li>([\s\S]*?)<\/li>/g)];
  assert.ok(items.length > 0, "at least one change is listed");
  // Guard against the truncation bug (fragments ended mid-word with a trailing "," or an
  // unclosed "`") without demanding terminal punctuation, which would be its own brittle FP.
  for (const [, li] of items) {
    const t = li.trim();
    assert.ok(t.length > 15 && !/[,`]$/.test(t), `looks truncated: ${t}`);
  }
});

test("landing benchmark metrics are numbers reports/benchmarks.md actually measured", () => {
  const measured = new Set();
  for (const line of repo("reports/benchmarks.md").split("\n")) {
    if (!line.startsWith("|")) continue;
    for (const m of line.matchAll(/(\d+(?:\.\d+)?)\s*(ms|µs|s)\b/g))
      measured.add(`${m[1]} ${m[2]}`);
  }
  const metrics = [
    ...landing.matchAll(/data-benchmark="(\d+(?:\.\d+)?)\s*(ms|µs|s)"/g),
  ];
  assert.ok(
    metrics.length > 0,
    "landing exposes at least one measured benchmark",
  );
  for (const [, n, unit] of metrics)
    assert.ok(
      measured.has(`${n} ${unit}`),
      `landing claims ${n} ${unit} but no benchmark row measures it`,
    );
});

// Metadata + freshness enforcement — each assertion below is a defect this change
// fixed (blank social cards, missing favicon, canonical/og drift, stale landing
// version, a repaint-heavy nav blur, the generated status page shipping in the
// tarball). They stay fixed because the test fails the moment they regress.

test("both public pages ship social image + favicon (no blank cards)", async () => {
  const status = render(await collect({ live: false }));
  for (const [name, html] of [
    ["landing", landing],
    ["status", status],
  ]) {
    assert.match(
      html,
      /property="og:image"[^>]*content="https:\/\/[^"]+\.png"/,
      `${name}: absolute og:image`,
    );
    assert.match(
      html,
      /name="twitter:image"[^>]*content="https:\/\/[^"]+\.png"/,
      `${name}: twitter:image`,
    );
    assert.match(html, /rel="icon"[^>]*image\/svg/, `${name}: svg favicon`);
    assert.match(html, /rel="apple-touch-icon"/, `${name}: apple-touch-icon`);
  }
});

test("canonical == og:url on both pages", async () => {
  const status = render(await collect({ live: false }));
  for (const [name, html] of [
    ["landing", landing],
    ["status", status],
  ]) {
    const canon = html.match(/rel="canonical"\s+href="([^"]+)"/)?.[1];
    const ogUrl = html.match(/property="og:url"\s+content="([^"]+)"/)?.[1];
    assert.ok(canon, `${name}: has canonical`);
    assert.equal(canon, ogUrl, `${name}: canonical must equal og:url`);
  }
});

test("landing never states a stale package version", () => {
  const { version } = JSON.parse(repo("package.json"));
  const shown = [...landing.matchAll(/forgekit v(\d+\.\d+\.\d+)/g)].map(
    (m) => m[1],
  );
  assert.ok(shown.length > 0, "landing states its package version");
  for (const v of shown)
    assert.equal(v, version, `landing shows v${v}, package.json is ${version}`);
  const schemaVersion = landing.match(
    /"softwareVersion"\s*:\s*"(\d+\.\d+\.\d+)"/,
  )?.[1];
  assert.equal(
    schemaVersion,
    version,
    "landing structured data matches package.json",
  );
});

test("sticky-nav blur stays compositor-light (<=8px)", () => {
  for (const [, px] of landing.matchAll(/backdrop-filter:\s*blur\((\d+)px\)/g))
    assert.ok(
      Number(px) <= 8,
      `backdrop blur ${px}px > 8px is repaint-heavy on scroll`,
    );
});

test("landing runtime is source-owned and dependency-free", () => {
  assert.doesNotMatch(
    landing,
    /cdn\.jsdelivr\.net|fonts\.googleapis\.com|esm\.sh/,
    "landing must not depend on an external runtime or webfont",
  );
  const scripts = [...landing.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    scripts,
    ["./app.js"],
    "landing loads only its readable local runtime",
  );
  assert.ok(
    existsSync(fileURLToPath(new URL("../landing/app.js", import.meta.url))),
    "the local landing runtime exists",
  );
});

test("the generated status page is not shipped in the npm tarball", () => {
  const { files } = JSON.parse(repo("package.json"));
  assert.ok(
    !files.includes("public"),
    "public/ is a build artifact (regenerated at deploy), not a shipped file",
  );
});

test("pages optional integration can validate live GitHub data", async (t) => {
  if (process.env.RUN_INTEGRATION !== "1") {
    t.skip("set RUN_INTEGRATION=1 to hit GitHub API");
    return;
  }
  const data = await collect({ live: true });
  assert.equal(typeof data.github?.stars, "number");
});
