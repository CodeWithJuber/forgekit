# Historical editions of the research papers

> ⚠️ **Historical, pre-correction editions.** Every PDF listed here predates the 2026-09-21 and
> 2026-09-26 corrections. It is kept so that what was published can still be read and cited, not
> as the current text. The corrected sources are the HTML and LaTeX files named in the table;
> read those.

## Status on 2026-09-26: not regenerated

A re-render of the three HTML papers was attempted on 2026-09-26 and **not committed**:

1. **Figures need resolving.** The HTML sources reference every figure through a
   `{{artifact:…}}` placeholder, which no browser resolves, so a plain render has no figures. The
   map below resolves them; it was checked against the images embedded in the old PDFs.
2. **The Qur'anic text could not be verified.** All three HTML papers carry Qur'anic Arabic. When
   the white paper and the synthesis were rendered in the environment available that day, Chromium
   set their verse text in three fallback fonts at once (DejaVu Sans for most glyphs, Liberation
   Serif and FreeSerif for the rest); mixing fonts inside a word can break letter joining and mark
   placement, and the rendered pages could not be inspected by eye. A PDF whose sacred text has not
   been checked is not published as the new edition.
3. **The refutation paper needs TeX.** `empirical-refutation/paper.pdf` is built from
   `paper/main.tex` with a TeX Live toolchain; none was available.

## The editions

Each edition stays retrievable byte for byte at the pinned commit
`d2abfa69fb77531199ffc67c5c076b524af69040`:
`git show d2abfa69fb77531199ffc67c5c076b524af69040:<path> > edition.pdf`, or
`git cat-file -p <blob>` with the blob below.

| PDF (historical, pre-correction) | Git blob at `d2abfa6` | sha256 (prefix) | Bytes | Last changed in | Corrected source |
| --- | --- | --- | --- | --- | --- |
| `research/formal-synthesis/substrate_synthesis.pdf` | `2e17362fc62d9f32b1083f17a0ac865704244ef6` | `644e28d0f8d1cbd3…` | 835072 | `5e60069` (2026-08-14) | `research/formal-synthesis/substrate_synthesis.html` |
| `research/empirical-refutation/extended_preprint.pdf` | `74f74ae08612bb9dc11038f651f923e0730b8bfc` | `8d2ec1091d17f0ba…` | 791707 | `9ebe256` (2026-09-20) | `research/empirical-refutation/extended_preprint.html` |
| `research/empirical-refutation/paper.pdf` | `f94a727cec7f84ac197057f3f22cde0fb09f28b1` | `a5001d8fc59a1b4a…` | 830746 | `c5fb041` (2026-09-20) | `research/empirical-refutation/paper/main.tex` |
| `research/cognitive-substrate/cognitive_substrate_whitepaper.pdf` | `44ce7bbd4a7bc1e6220f162074c9b473c6287e7b` | `599e626ba24958c6…` | 1816584 | `e6e6de7` (2026-09-20) | `research/cognitive-substrate/cognitive_substrate_whitepaper.html` |
| `docs/cognitive-substrate/cognitive_substrate_whitepaper.pdf` (byte-identical copy) | same blob as the row above | same | 1816584 | — | the same HTML, copied to `docs/cognitive-substrate/` |

The copies of `repro/paper/main.tex` and `repro/paper/paper.pdf` inside
`empirical-refutation/replication_package.tar.gz` (git blob `50bd453a30dad5d8ca3369129f8015fd4524fa81`)
are also left exactly as published. The paper PDF was built with pdfTeX (TeX Live 2026) and the ACM
`acmart` class, as its own metadata records.

## Figure map

Each `{{artifact:<id>}}` placeholder in the HTML sources (13 in all: 3 in the synthesis, 3 in the
preprint, 7 in the white paper), the figure file under `research/` it stands for, and whether that
file's pixel size matches the image embedded in the old PDF:

| Placeholder id | Figure (under `research/`) | Size (px) | Matches the old PDF |
| --- | --- | --- | --- |
| `art_5f049677-4c3c-40f2-8905-dd01c966e9ae` | `formal-synthesis/figures/schematic_duality.png` (synthesis and preprint, Figure 1) | 1366 × 1046 | yes |
| `art_f0decf80-d016-496f-8032-f7b2e73e71b2` | `formal-synthesis/figures/schematic_taskloop.png` (synthesis and preprint, Figure 2) | 1607 × 1092 | yes |
| `art_5d076ce3-0f54-4394-9a77-f70a336ca843` | `formal-synthesis/figures/schematic_convergence.png` (synthesis, Figure 8) | 2460 × 1539 | yes |
| `art_712fac51-fe17-4ed6-80f0-9dd42bf42758` | `empirical-refutation/figures/fig_repair_beforeafter.png` (preprint, Figure 3) | 3142 × 1383 | yes |
| `art_e2776474-3d1e-48c6-9490-55d4d927a301` | `cognitive-substrate/figures/schematic_loop.png` (white paper, Figure 1) | 3003 × 1439 | yes |
| `art_d2be1b53-86ce-4069-b2aa-5be59836598e` | `cognitive-substrate/figures/schematic_system.png` (white paper, Figure 2) | 2847 × 1840 | yes |
| `art_8d9fa6dd-3554-49c7-9e76-ba667544a622` | `cognitive-substrate/figures/schematic_extended.png` (white paper, Figure 3) | 1483 × 931 | yes |
| `art_07bb9186-5e55-44f6-af3f-dde83d6b9e65` | `cognitive-substrate/figures/impact_graph.png` (white paper, Figure 4) | 1900 × 1326 | yes |
| `art_392e293d-be93-4efe-81c1-e9612a711ac4` | `cognitive-substrate/figures/eval_precision_recall.png` (white paper, Figure 5) | 2300 × 918 | **no** — the old PDF embeds a 1921 × 842 raster, so the repository's file is a different render of this figure; compare the two before publishing |
| `art_5b206b7b-c90e-417f-b1e8-48b0ec389cb8` | `cognitive-substrate/figures/schematic_router_loop.png` (white paper, Figure 6) | 1537 × 838 | yes |
| `art_ac78be07-be03-4560-bb9f-f5fe2f16d7ef` | `cognitive-substrate/figures/router_eval.png` (white paper, Figure 7) | 1719 × 732 | yes |

## Rendering a new edition

1. Work in a scratch directory outside the repository and install `playwright-core` there, never
   in the repository: `npm init -y && npm install playwright-core`. Point it at an installed
   Chromium (`executablePath`).
2. Install a font with full Qur'anic coverage (a Naskh face such as Amiri or Scheherazade New) and
   make it the first `font-family` for `.quran .ar` in the render, so one font sets each verse.
3. Replace every `{{artifact:<id>}}` with its figure from the map (a `data:image/png;base64,…`
   URI keeps the render self-contained), render A4 with a header and footer stamp
   `edition <date> · source sha256 <first 12 hex of the HTML file's sha256> · forgekit <version>`,
   and confirm every image loaded and no request failed.
4. **Inspect by eye** every page that carries a figure or a verse card. Only then replace the PDF,
   re-copy the white paper to `docs/cognitive-substrate/` (`node scripts/claims-status.mjs
   --sync-copies`), and add a row here recording the replaced edition's git blob and the new
   edition's source hash.

A render script that does steps 1 and 3 (it resolved all 13 figure placeholders across the three
papers with no failed request on 2026-09-26):

```js
// node render.mjs <repo> <html-path-in-repo> <out.pdf>   (run from the scratch directory)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const FIGURES = { /* "art_…": "research/…/figures/….png", one entry per row of the map above */ };
const [repo, rel, out] = process.argv.slice(2);
const raw = readFileSync(path.join(repo, rel));
const sha = createHash("sha256").update(raw).digest("hex").slice(0, 12);
const version = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version;
const stamp = `edition ${new Date().toISOString().slice(0, 10)} · source sha256 ${sha} · forgekit ${version}`;
let html = raw.toString("utf8");
for (const [id, fig] of Object.entries(FIGURES)) {
  const uri = `data:image/png;base64,${readFileSync(path.join(repo, fig)).toString("base64")}`;
  html = html.split(`{{artifact:${id}}}`).join(uri);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage();
const failed = [];
page.on("requestfailed", (r) => failed.push(r.url()));
await page.setContent(html, { waitUntil: "networkidle" });
const unresolved = (html.match(/\{\{artifact:[^}]+\}\}/g) || []).length;
const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).length);
if (unresolved || broken || failed.length) throw new Error(`figures: ${unresolved} unresolved, ${broken} broken, ${failed.length} failed`);
const line = (s) => `<div style="font:8px sans-serif;color:#666;width:100%;text-align:center">${s}</div>`;
await page.pdf({
  path: out, format: "A4", printBackground: true, displayHeaderFooter: true,
  margin: { top: "18mm", bottom: "18mm", left: "14mm", right: "14mm" },
  headerTemplate: line(stamp),
  footerTemplate: line(`${stamp} · page <span class="pageNumber"></span> / <span class="totalPages"></span>`),
});
await browser.close();
```

For `paper.pdf`, build `paper/main.tex` with TeX Live (`pdflatex` and `bibtex`, ACM `acmart`
class) and stamp the same fields in the PDF metadata or a footnote.
