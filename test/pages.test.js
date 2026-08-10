import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collect, render } from "../scripts/build-pages.mjs";
import { BRAND, spaceScaleCss, typeScaleCss } from "../src/brand.js";

const repo = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
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
  const hexes = (palette) => Object.values(palette).filter((v) => v.startsWith("#"));
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
    assert.ok(status.includes(norm(decl)), `status missing space token ${decl}`);
});

test("landing declares no webfont it fails to load (no phantom Inter)", () => {
  const sans = landing.match(/--sans:\s*([^;]+);/)?.[1] ?? "";
  assert.ok(sans.includes("system-ui"), "landing --sans should be a system stack");
  // If the CSS names a webfont family, it must actually load it (@font-face / <link>).
  if (/\bInter\b/.test(landing)) {
    assert.match(landing, /@font-face|rel=["']?stylesheet/, "Inter named but never loaded");
  }
});

test("status page 'Latest changes' list is never empty", async () => {
  const status = render(await collect({ live: false }));
  const list = status.match(/Latest repo changes<\/h2>[\s\S]*?<ul class="list">([\s\S]*?)<\/ul>/);
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
  const metrics = [...landing.matchAll(/data-benchmark="(\d+(?:\.\d+)?)\s*(ms|µs|s)"/g)];
  assert.ok(metrics.length > 0, "landing exposes at least one measured benchmark");
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
  const shown = [...landing.matchAll(/forgekit v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(shown.length > 0, "landing states its package version");
  for (const v of shown)
    assert.equal(v, version, `landing shows v${v}, package.json is ${version}`);
  const schemaVersion = landing.match(/"softwareVersion"\s*:\s*"(\d+\.\d+\.\d+)"/)?.[1];
  assert.equal(schemaVersion, version, "landing structured data matches package.json");
});

test("sticky-nav blur stays compositor-light (<=8px)", () => {
  for (const [, px] of landing.matchAll(/backdrop-filter:\s*blur\((\d+)px\)/g))
    assert.ok(Number(px) <= 8, `backdrop blur ${px}px > 8px is repaint-heavy on scroll`);
});

test("landing runtime is source-owned and dependency-free", () => {
  assert.doesNotMatch(
    landing,
    /cdn\.jsdelivr\.net|fonts\.googleapis\.com|esm\.sh/,
    "landing must not depend on an external runtime or webfont",
  );
  const scripts = [...landing.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["./app.js"], "landing loads only its readable local runtime");
  assert.ok(
    existsSync(fileURLToPath(new URL("../landing/app.js", import.meta.url))),
    "the local landing runtime exists",
  );
});

test("pinned landing chunks form a complete closure (no dangling imports)", () => {
  // A pin can name an entry chunk that exists while one of its static imports does not —
  // the shell then loads, the SPA 404s a chunk, and the site dies with a green build.
  // Walk the import graph from the pinned entry (and the pinned CSS) through
  // landing/assets and require every referenced file to exist on disk. History-free:
  // works in shallow CI checkouts where git ancestry is unavailable.
  const pins = [
    ...landing.matchAll(
      /cdn\.jsdelivr\.net\/gh\/CodeWithJuber\/forgekit@[0-9a-f]{40}\/landing\/assets\/([^"']+)/g,
    ),
  ].map((m) => m[1]);
  const entry = pins.find((f) => /^index-.*\.js$/.test(f));
  assert.ok(entry, "landing pins exactly one entry chunk");
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const path = fileURLToPath(new URL(`../landing/assets/${file}`, import.meta.url));
    assert.ok(existsSync(path), `landing/assets/${file} is pinned/imported but missing`);
    if (!file.endsWith(".js")) continue;
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*["']\.\/([^"']+)["']/g)) queue.push(m[1]);
    for (const m of src.matchAll(/import\(\s*["']\.\/([^"']+)["']\s*\)/g)) queue.push(m[1]);
  }
});

test("jsDelivr pin is never older than the newest landing/assets commit", async (t) => {
  // The pin is only re-cut when a chunk actually changes — so the newest commit touching
  // landing/assets/ must be the pinned commit itself or one of its ancestors. If someone
  // commits rebuilt chunks without re-cutting the pin, the deployed site silently serves
  // the old build with a green deploy, and only this check notices. Requires history;
  // the quality gate checks out with fetch-depth: 0, which is where this bites.
  const { execFileSync } = await import("node:child_process");
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    t.skip("shallow checkout — pin-vs-assets ancestry needs fetch-depth: 0");
    return;
  }
  const pinSha = landing.match(
    /cdn\.jsdelivr\.net\/gh\/CodeWithJuber\/forgekit@([0-9a-f]{40})\//,
  )?.[1];
  assert.ok(pinSha, "landing pins at least one asset to a full commit SHA");
  const newestAssets = git(["log", "-1", "--format=%H", "--", "landing/assets"]);
  assert.ok(newestAssets, "landing/assets has at least one commit");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", newestAssets, pinSha], {
      cwd: repoRoot,
    });
  } catch {
    assert.fail(
      `landing/assets changed in ${newestAssets.slice(0, 8)} after the pin was cut at ` +
        `${pinSha.slice(0, 8)} — re-cut the jsDelivr pin in landing/index.html to the ` +
        `newest chunk commit (the deployed site is serving stale chunks)`,
    );
  }
});

test("deployed site serves the same chunks the repo pins", async (t) => {
  if (process.env.RUN_INTEGRATION !== "1") {
    t.skip("set RUN_INTEGRATION=1 to hit the deployed site");
    return;
  }
  // The end-to-end smoke: what Pages serves must equal what the repo pins. Catches a
  // failed/partial deploy that every in-repo check is blind to. Retried like the
  // build-time fetch in scripts/build-pages.mjs — a transient network blip must not
  // masquerade as a deploy failure.
  let res;
  let lastErr;
  for (let i = 0; i < 3 && !res; i++) {
    try {
      res = await fetch("https://codewithjuber.github.io/forgekit/");
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  assert.ok(res, `deployed site unreachable after 3 attempts: ${lastErr}`);
  assert.ok(res.ok, `deployed site returned HTTP ${res.status}`);
  const deployed = await res.text();
  const repoPins = [
    ...landing.matchAll(
      /cdn\.jsdelivr\.net\/gh\/CodeWithJuber\/forgekit@[0-9a-f]{40}\/landing\/assets\/[^"']+/g,
    ),
  ];
  assert.ok(repoPins.length > 0, "repo pins at least one asset");
  for (const [pin] of repoPins)
    assert.ok(deployed.includes(pin), `deployed site is missing pinned asset ${pin}`);
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
