#!/usr/bin/env node
/**
 * The project's diagrams, rendered by Archify (https://github.com/tt-a1i/archify, MIT) from
 * typed JSON sources — node stdlib + git only, like the rest of scripts/.
 *
 *   docs/diagrams/src/<id>.<type>.json   the typed sources (the only hand-edited diagram files)
 *   docs/diagrams/<id>.svg               the dual-theme static export the docs embed
 *   mintlify/images/diagrams/<id>.svg    byte-identical copies for the docs site, which can
 *                                        only serve files under mintlify/ (git stores the
 *                                        identical blob once)
 *   docs/diagrams/diagrams.json          the manifest: each diagram's id, type, title, the docs
 *                                        that embed it, and the receipt of its last verified
 *                                        render (source + artifact sha256, the archify pin)
 *
 * The interactive HTML (~0.8 MB per diagram, byte-deterministic for a given source and archify
 * commit) is not committed: the Pages build renders it from the pinned commit and refuses to
 * publish any file whose sha256 differs from its receipt, so the site serves exactly what was
 * validated here.
 *
 * Usage:
 *   node scripts/diagrams.mjs check                  offline: sources match their receipts,
 *                                                    every source is registered, SVGs present
 *   node scripts/diagrams.mjs validate [id…]         archify showcase validation
 *   node scripts/diagrams.mjs build [id…] [--no-svg] validate + render + re-export the SVG and
 *                                                    rewrite the receipts (after editing a source)
 *   node scripts/diagrams.mjs sync                   offline: refresh the docs-site SVG copies
 *   node scripts/diagrams.mjs site <outDir>          Pages: render every HTML (verified against
 *                                                    its receipt), copy the SVGs, write a gallery
 *
 * Environment: FORGE_ARCHIFY_DIR — an existing archify checkout at the pinned commit (skips
 * the fetch); ARCHIFY_CHROME — Chrome/Chromium for the SVG export (else archify's own lookup).
 *
 * Exit codes: 0 ok · 1 a check, validation or render failed · 2 usage error.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The archify release every receipt was produced with. Bumping it means re-running
 *  `build` for every diagram: the artifact hashes change with the renderer. */
export const ARCHIFY = Object.freeze({
  repo: "https://github.com/tt-a1i/archify",
  commit: "9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993",
});

export const MANIFEST_PATH = "docs/diagrams/diagrams.json";
export const SOURCE_DIR = "docs/diagrams/src";
export const TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"];

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** `<id>.<type>.json` → {id, type}; null for anything else. */
export function parseSourceName(file) {
  const m = /^([a-z0-9][a-z0-9-]*)\.([a-z]+)\.json$/.exec(path.basename(file));
  return m && TYPES.includes(m[2]) ? { id: m[1], type: m[2] } : null;
}

export function sourcePath(entry) {
  return `${SOURCE_DIR}/${entry.id}.${entry.type}.json`;
}
export function svgPath(entry) {
  return `docs/diagrams/${entry.id}.svg`;
}
export const MINTLIFY_SVG_DIR = "mintlify/images/diagrams";
export function mintlifySvgPath(entry) {
  return `${MINTLIFY_SVG_DIR}/${entry.id}.svg`;
}
/** The docs site embeds a diagram only through its copy under mintlify/. */
const onDocsSite = (entry) => (entry.usedIn ?? []).some((rel) => rel.startsWith("mintlify/"));

/** @param {string} root */
export function readManifest(root) {
  return JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
}

/**
 * Offline consistency check (no archify, no network): every source is registered and still
 * byte-identical to the one its receipt was rendered from, and its SVG exists.
 * @param {string} root
 * @returns {string[]} problems; empty means consistent
 */
export function checkDiagrams(root) {
  const problems = [];
  let manifest;
  try {
    manifest = readManifest(root);
  } catch (e) {
    return [`${MANIFEST_PATH}: ${/** @type {Error} */ (e).message}`];
  }
  if (manifest.archify?.commit !== ARCHIFY.commit)
    problems.push(
      `${MANIFEST_PATH}: receipts were rendered with archify ${manifest.archify?.commit ?? "?"}, scripts/diagrams.mjs pins ${ARCHIFY.commit} — run \`node scripts/diagrams.mjs build\``,
    );
  const seen = new Set();
  for (const entry of manifest.diagrams ?? []) {
    const where = `diagram "${entry.id}"`;
    if (seen.has(entry.id)) problems.push(`${where}: duplicate id`);
    seen.add(entry.id);
    if (!TYPES.includes(entry.type)) problems.push(`${where}: unknown type "${entry.type}"`);
    const src = path.join(root, sourcePath(entry));
    if (!existsSync(src)) {
      problems.push(`${where}: source ${sourcePath(entry)} is missing`);
      continue;
    }
    if (sha256(readFileSync(src)) !== entry.receipt?.specSha256)
      problems.push(
        `${where}: ${sourcePath(entry)} changed since its last verified render — run \`node scripts/diagrams.mjs build ${entry.id}\``,
      );
    const svg = path.join(root, svgPath(entry));
    if (!existsSync(svg))
      problems.push(
        `${where}: ${svgPath(entry)} is missing — run \`node scripts/diagrams.mjs build ${entry.id}\``,
      );
    else if (onDocsSite(entry)) {
      const copy = path.join(root, mintlifySvgPath(entry));
      if (!existsSync(copy) || !readFileSync(copy).equals(readFileSync(svg)))
        problems.push(
          `${where}: ${mintlifySvgPath(entry)} is not a byte-identical copy of ${svgPath(entry)} — run \`node scripts/diagrams.mjs sync\``,
        );
    }
    if (!/^[0-9a-f]{64}$/.test(entry.receipt?.artifactSha256 ?? ""))
      problems.push(`${where}: receipt has no artifact sha256`);
    for (const rel of entry.usedIn ?? []) {
      let text = "";
      try {
        text = readFileSync(path.join(root, rel), "utf8");
      } catch {
        problems.push(`${where}: usedIn names ${rel}, which does not exist`);
        continue;
      }
      if (!text.includes(`diagrams/${entry.id}.`))
        problems.push(`${where}: usedIn names ${rel}, which does not embed it`);
    }
  }
  const dir = path.join(root, SOURCE_DIR);
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const parsed = parseSourceName(f);
    if (!parsed) problems.push(`${SOURCE_DIR}/${f}: not a <id>.<type>.json diagram source`);
    else if (!seen.has(parsed.id))
      problems.push(`${SOURCE_DIR}/${f}: not registered in ${MANIFEST_PATH}`);
  }
  const wanted = new Set((manifest.diagrams ?? []).filter(onDocsSite).map((e) => `${e.id}.svg`));
  const copies = path.join(root, MINTLIFY_SVG_DIR);
  for (const f of existsSync(copies) ? readdirSync(copies) : [])
    if (!wanted.has(f))
      problems.push(
        `${MINTLIFY_SVG_DIR}/${f}: no docs-site page embeds it — run \`node scripts/diagrams.mjs sync\``,
      );
  return problems;
}

/** Make mintlify/images/diagrams/ hold exactly the SVGs the docs site embeds. */
export function syncDocsSiteCopies(root, manifest) {
  const dir = path.join(root, MINTLIFY_SVG_DIR);
  const wanted = (manifest.diagrams ?? []).filter(onDocsSite);
  if (wanted.length) mkdirSync(dir, { recursive: true });
  const keep = new Set(wanted.map((e) => `${e.id}.svg`));
  for (const f of existsSync(dir) ? readdirSync(dir) : [])
    if (!keep.has(f)) rmSync(path.join(dir, f));
  for (const e of wanted)
    copyFileSync(path.join(root, svgPath(e)), path.join(root, mintlifySvgPath(e)));
}

// --- archify -------------------------------------------------------------------------------

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The pinned archify checkout: FORGE_ARCHIFY_DIR, else fetched once into .cache/. */
export function ensureArchify(root) {
  const override = process.env.FORGE_ARCHIFY_DIR;
  const dir = override
    ? path.resolve(override)
    : path.join(root, ".cache", "archify", ARCHIFY.commit);
  const cli = path.join(dir, "archify", "bin", "archify.mjs");
  if (!existsSync(cli)) {
    if (override) throw new Error(`FORGE_ARCHIFY_DIR=${dir} has no archify/bin/archify.mjs`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(["init", "-q"], dir);
    git(["fetch", "-q", "--depth", "1", ARCHIFY.repo, ARCHIFY.commit], dir);
    git(["checkout", "-q", "--detach", "FETCH_HEAD"], dir);
  }
  const head = git(["rev-parse", "HEAD"], dir).trim();
  if (head !== ARCHIFY.commit)
    throw new Error(`archify at ${dir} is ${head}, not the pinned ${ARCHIFY.commit}`);
  return { dir, cli };
}

/** Run one archify command that prints a JSON receipt; a non-zero exit is a failure. */
function archify(cli, args) {
  try {
    const out = execFileSync(process.execPath, [cli, ...args, "--json"], {
      cwd: path.dirname(path.dirname(cli)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (e) {
    const err = /** @type {any} */ (e);
    let detail = String(err.stdout || err.stderr || err.message).trim();
    try {
      const j = JSON.parse(err.stdout);
      detail = JSON.stringify(j.diagnostics ?? j.errors ?? j, null, 2).slice(0, 4000);
    } catch {}
    throw new Error(`archify ${args.slice(0, 2).join(" ")} failed:\n${detail}`);
  }
}

/** Validate, then render one diagram to `out`; returns the delivery receipt. */
export function render(root, cli, entry, out) {
  const src = path.join(root, sourcePath(entry));
  archify(cli, ["validate", entry.type, src, "--quality", "showcase"]);
  const r = archify(cli, ["deliver", entry.type, src, out, "--quality", "showcase"]);
  if (!r.ok) throw new Error(`archify deliver ${entry.id}: not ok`);
  return r;
}

/** Export the dual-theme SVG through the viewer's own Export menu, headless (archify's
 *  pipe-CDP Chrome driver — no browser automation dependency). */
async function exportSvg(archifyDir, html, target) {
  const vc = await import(
    pathToFileURL(path.join(archifyDir, "archify", "bin", "visual-check.mjs")).href
  );
  const chrome = process.env.ARCHIFY_CHROME || vc.findChrome();
  if (!chrome) throw new Error("no Chrome/Chromium found — set ARCHIFY_CHROME");
  const downloads = mkdtempSync(path.join(tmpdir(), "forge-diagram-svg-"));
  const browser = new vc.ChromeVisualBrowser(chrome);
  try {
    const sid = await browser.sessionPromise;
    const send = (method, params) => browser.cdp.send(method, params, sid);
    await browser.cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloads,
      eventsEnabled: true,
    });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: pathToFileURL(html).href });
    const evaluate = async (expression) =>
      (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
        .result?.value;
    for (let i = 0; i < 100 && !(await evaluate("!!document.getElementById('btn-export')")); i++)
      await new Promise((r) => setTimeout(r, 100));
    const clicked = await evaluate(`(() => {
      document.getElementById('btn-export')?.click();
      const b = [...document.querySelectorAll('[data-format="svg"]')].find((e) => !e.dataset.variant);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`${html}: the viewer has no SVG export control`);
    let file;
    for (let i = 0; i < 150 && !file; i++) {
      await new Promise((r) => setTimeout(r, 100));
      file = readdirSync(downloads).find((f) => f.endsWith(".svg"));
    }
    if (!file) throw new Error(`${html}: the SVG export did not arrive`);
    copyFileSync(path.join(downloads, file), target);
  } finally {
    await browser.close();
    rmSync(downloads, { recursive: true, force: true });
  }
}

// --- site ----------------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) =>
      /** @type {Record<string,string>} */ ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      })[c],
  );

const DESCRIPTION =
  "Interactive diagrams of how forgekit works, rendered by Archify from typed sources.";

/** The /diagrams/ gallery page: one card per diagram, the SVG as its preview. */
export function galleryHtml(manifest, { site = "", repo = "", tokensCss = "" } = {}) {
  const cards = manifest.diagrams
    .map(
      (d) =>
        `<li><a href="${esc(d.id)}.html"><img src="${esc(d.id)}.svg" alt="" loading="lazy" width="540" height="294"><span class="t">${esc(d.title)}</span><span class="k">${esc(d.type)}</span></a></li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>forgekit diagrams</title><meta name="description" content="${DESCRIPTION}"><meta name="theme-color" content="#171310"><link rel="icon" type="image/svg+xml" href="${esc(site)}/favicon.svg"><link rel="canonical" href="${esc(site)}/diagrams/"><meta property="og:type" content="website"><meta property="og:site_name" content="forgekit"><meta property="og:title" content="How forgekit works — interactive diagrams"><meta property="og:description" content="${DESCRIPTION}"><meta property="og:url" content="${esc(site)}/diagrams/"><meta property="og:image" content="${esc(site)}/og.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(site)}/og.jpg"><style>${tokensCss}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:48px 16px 64px}h1{font-size:2rem;margin:0 0 .5rem}p{color:var(--muted);max-width:720px}
a{color:var(--brand)}ul{list-style:none;padding:0;margin:32px 0 0;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))}
li a{display:flex;flex-direction:column;gap:6px;height:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);text-decoration:none}
li a:hover,li a:focus-visible{border-color:var(--brand)}img{width:100%;height:auto;border-radius:6px;background:var(--bg-2)}
.t{font-weight:600}.k{font:12px ui-monospace,monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
footer{margin-top:40px;font-size:.9rem;color:var(--muted)}</style></head><body><main>
<h1>How forgekit works</h1><p>Each diagram opens as an interactive page: pan and zoom, search with <kbd>/</kbd>, press <kbd>?</kbd> for the guide, and trace a node's upstream and downstream relationships. They are rendered by <a href="${esc(ARCHIFY.repo)}">Archify</a> from typed sources in <a href="${esc(repo)}/tree/HEAD/docs/diagrams">docs/diagrams</a>, and each file is checked against the receipt of its validated render.</p>
<ul>${cards}</ul>
<footer><a href="${esc(site)}/">forgekit</a> · <a href="${esc(site)}/status/">status</a> · diagrams rendered by Archify (MIT)</footer>
</main></body></html>
`;
}

/** Render every diagram into `outDir` for the Pages site, verified against its receipt. */
export async function buildSite(root, outDir) {
  const problems = checkDiagrams(root);
  if (problems.length) throw new Error(problems.join("\n"));
  const manifest = readManifest(root);
  const { cli } = ensureArchify(root);
  mkdirSync(outDir, { recursive: true });
  for (const entry of manifest.diagrams) {
    const out = path.join(outDir, `${entry.id}.html`);
    const r = render(root, cli, entry, out);
    if (r.artifact?.sha256 !== entry.receipt.artifactSha256)
      throw new Error(
        `diagram "${entry.id}": rendered ${r.artifact?.sha256}, receipt says ${entry.receipt.artifactSha256} — refusing to publish an artifact that differs from the validated one`,
      );
    copyFileSync(path.join(root, svgPath(entry)), path.join(outDir, `${entry.id}.svg`));
  }
  const { BRAND, rootTokensCss } = await import("../src/brand.js");
  const { stripTrailingSlashes } = await import("../src/util.js");
  const trim = (u) => stripTrailingSlashes(String(u ?? ""));
  writeFileSync(
    path.join(outDir, "index.html"),
    galleryHtml(manifest, {
      site: trim(BRAND.site?.url),
      repo: trim(BRAND.site?.repo),
      tokensCss: rootTokensCss(),
    }),
  );
  return manifest.diagrams.length;
}

// --- CLI -----------------------------------------------------------------------------------

async function main(argv) {
  const [cmd, ...rest] = argv;
  const root = DEFAULT_ROOT;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const ids = rest.filter((a) => !a.startsWith("--"));
  if (cmd === "check") {
    const problems = checkDiagrams(root);
    for (const p of problems) process.stderr.write(`${p}\n`);
    if (!problems.length) {
      const n = readManifest(root).diagrams.length;
      process.stdout.write(`ok: ${n} diagrams match their receipts\n`);
    }
    return problems.length ? 1 : 0;
  }
  if (cmd === "sync") {
    syncDocsSiteCopies(root, readManifest(root));
    process.stdout.write(`synced ${MINTLIFY_SVG_DIR}/\n`);
    return 0;
  }
  if (cmd === "site") {
    if (!ids[0]) {
      process.stderr.write("usage: node scripts/diagrams.mjs site <outDir>\n");
      return 2;
    }
    const n = await buildSite(root, path.resolve(ids[0]));
    process.stdout.write(`rendered ${n} diagrams into ${ids[0]}\n`);
    return 0;
  }
  if (cmd === "validate" || cmd === "build") {
    const manifest = readManifest(root);
    const pick = ids.length
      ? manifest.diagrams.filter((d) => ids.includes(d.id))
      : manifest.diagrams;
    const unknown = ids.filter((i) => !manifest.diagrams.some((d) => d.id === i));
    if (unknown.length) {
      process.stderr.write(`unknown diagram id(s): ${unknown.join(", ")}\n`);
      return 2;
    }
    const { dir, cli } = ensureArchify(root);
    const work = mkdtempSync(path.join(tmpdir(), "forge-diagrams-"));
    try {
      for (const entry of pick) {
        const src = path.join(root, sourcePath(entry));
        if (cmd === "validate") {
          const v = archify(cli, ["validate", entry.type, src, "--quality", "showcase"]);
          process.stdout.write(
            `ok  ${entry.id}  ${JSON.stringify(v.summary ?? v.validation ?? "valid")}\n`,
          );
          continue;
        }
        const html = path.join(work, `${entry.id}.html`);
        const r = render(root, cli, entry, html);
        entry.title = JSON.parse(readFileSync(src, "utf8")).meta?.title ?? entry.id;
        if (!flags.has("--no-svg")) await exportSvg(dir, html, path.join(root, svgPath(entry)));
        entry.receipt = {
          specSha256: r.specification.sha256,
          artifactSha256: r.artifact.sha256,
          artifactBytes: r.artifact.bytes,
          checks:
            `${r.validation?.checksPassed}/${r.validation?.checkCount} ${r.validation?.compositionProfile ?? ""}`.trim(),
        };
        process.stdout.write(
          `ok  ${entry.id}  ${entry.receipt.checks}  ${entry.receipt.artifactSha256.slice(0, 12)}\n`,
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    if (cmd === "build") {
      manifest.archify = { ...ARCHIFY, license: "MIT" };
      writeFileSync(path.join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
      syncDocsSiteCopies(root, manifest);
    }
    return 0;
  }
  process.stderr.write(
    "usage: node scripts/diagrams.mjs check | validate [id…] | build [id…] [--no-svg] | sync | site <outDir>\n",
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    },
  );
}
