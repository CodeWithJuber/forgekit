#!/usr/bin/env node
// Data sources: local package.json, README.md, CHANGELOG.md, reports/benchmarks.md,
// and optionally https://api.github.com/repos/CodeWithJuber/forgekit when BUILD_PAGES_LIVE=1.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, rootTokensCss } from "../src/brand.js";

// The deployed site base (no trailing slash), from the single brand.json source.
// Absolute URLs are required for og:image/canonical and must resolve on the Pages
// project site (/forgekit/...), so both public surfaces derive them from here.
const SITE = (BRAND.site?.url ?? "").replace(/\/+$/, "");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "index.html");
const cacheFile = join(root, ".cache", "pages", "github-repo.json");
const api = "https://api.github.com/repos/CodeWithJuber/forgekit";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const read = (p) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");
const changelog = read("CHANGELOG.md");
const benchmarks = read("reports/benchmarks.md");

// A repo-sourced metric MUST parse from the README — a silent fallback is how the
// site drifted into showing hardcoded numbers the README no longer stated. If the
// phrasing changes, fail the build loudly so the regex (or the README) gets fixed.
function mustMatch(text, re, label) {
  const m = text.match(re);
  if (!m?.[1]?.trim()) {
    throw new Error(
      `build-pages: metric "${label}" no longer matches ${re} in README.md — ` +
        `update the regex or the README (no silent fallback).`,
    );
  }
  return m[1].trim();
}
function latestChanges() {
  // Walk version sections in order and use the first one that actually has bullets —
  // an empty "## [Unreleased]" (the normal state right after a release) must not win
  // over the dated section below it that has the real content.
  const sections = changelog.matchAll(/## \[[^\]]+\][\s\S]*?(?=\n## \[|\n\[Unreleased\]:|$)/g);
  let section = "";
  for (const m of sections) {
    if (/^- /m.test(m[0])) {
      section = m[0];
      break;
    }
  }
  // Bullets wrap across several lines in the CHANGELOG; join each "- …" with its indented
  // continuation lines so the status page shows the whole item, not a truncated fragment.
  const items = [];
  let cur = null;
  for (const line of section.split("\n")) {
    const m = /^- (.*)$/.exec(line);
    if (m) {
      if (cur !== null) items.push(cur);
      cur = m[1];
    } else if (cur !== null) {
      // A blank line or heading ends the bullet; anything else — indented OR a column-0
      // "lazy continuation" (valid CommonMark, and how the formatter reflows wrapped
      // bullets) — is still part of the current item.
      if (line.trim() === "" || /^#{1,6}\s/.test(line)) {
        items.push(cur);
        cur = null;
      } else {
        cur += ` ${line.trim()}`;
      }
    }
  }
  if (cur !== null) items.push(cur);
  // Strip inline markdown (bold/code) — these bullets render as plain HTML text.
  return items.slice(0, 4).map((s) =>
    s
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1"),
  );
}
function git(args, fallback = "unknown") {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}
async function fetchJsonWithRetry(url, { timeoutMs = 5000, attempts = 3 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "forgekit-pages-build",
      };
      try {
        const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
        if (cached.etag) headers["if-none-match"] = cached.etag;
        if (cached.lastModified) headers["if-modified-since"] = cached.lastModified;
      } catch {}
      const res = await fetch(url, { headers, signal: ac.signal });
      if (res.status === 304) return JSON.parse(readFileSync(cacheFile, "utf8")).data;
      if (res.status === 403 || res.status === 429) throw new Error(`rate limited (${res.status})`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(
        cacheFile,
        JSON.stringify(
          {
            etag: res.headers.get("etag"),
            lastModified: res.headers.get("last-modified"),
            data,
          },
          null,
          2,
        ),
      );
      return data;
    } catch (e) {
      last = e;
      await new Promise((r) =>
        setTimeout(r, Math.min(1000, 100 * 2 ** i) + Math.floor(Math.random() * 50)),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
export async function collect({ live = process.env.BUILD_PAGES_LIVE === "1" } = {}) {
  let github = null;
  if (live) {
    try {
      const data = await fetchJsonWithRetry(api);
      github = {
        stars: Number.isFinite(data?.stargazers_count) ? data.stargazers_count : null,
        forks: Number.isFinite(data?.forks_count) ? data.forks_count : null,
        issues: Number.isFinite(data?.open_issues_count) ? data.open_issues_count : null,
      };
    } catch (e) {
      console.warn(`GitHub live data unavailable: ${e.message}`);
    }
  }
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    node: pkg.engines?.node ?? "",
    license: pkg.license,
    deps: Object.keys(pkg.dependencies ?? {}).length,
    commit: git(["rev-parse", "--short", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    generated: new Date().toISOString(),
    github,
    speed: mustMatch(readme, /\*\*A full pre-action gate in ([^*]+)\*\*/m, "speed"),
    impact: mustMatch(readme, /\*\*Blast radius in ([^*]+)\*\*/m, "impact"),
    saved: mustMatch(readme, /\*\*([\d.]+% cost saved)/m, "saved"),
    benchUpdated: statSync(join(root, "reports/benchmarks.md")).mtime.toISOString().slice(0, 10),
    latest: latestChanges(),
    benchMentions: (benchmarks.match(/^## /gm) ?? []).length,
  };
}
// The status page shares the landing page's design system verbatim: the same warm
// ember/near-black color tokens, one accent, a system font stack. test/pages.test.js
// enforces token parity, a non-empty changes list, and no phantom webfont — so the two
// public surfaces can't silently drift into two different "school-project" looks again.
export function render(d) {
  const live = d.github
    ? `<span class="chip">${esc(d.github.stars)} stars</span><span class="chip">${esc(d.github.forks)} forks</span><span class="chip">${esc(d.github.issues)} open issues</span>`
    : `<span class="chip">live GitHub stats disabled</span>`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: d.name,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    softwareVersion: d.version,
    url: `${SITE}/status/`,
    description: d.description,
    offers: { "@type": "Offer", price: "0" },
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>forgekit status — live repository data</title><meta name="description" content="${esc(d.description)}"><meta name="theme-color" content="#171310"><link rel="canonical" href="${SITE}/status/"><link rel="icon" type="image/svg+xml" href="${SITE}/favicon.svg"><link rel="apple-touch-icon" href="${SITE}/apple-touch-icon.png"><meta property="og:type" content="website"><meta property="og:site_name" content="forgekit"><meta property="og:title" content="forgekit status — live repository data"><meta property="og:description" content="${esc(d.description)}"><meta property="og:url" content="${SITE}/status/"><meta property="og:image" content="${SITE}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="forgekit status — live repository data"><meta name="twitter:description" content="${esc(d.description)}"><meta name="twitter:image" content="${SITE}/og.png"><script type="application/ld+json">${jsonLd}</script><style>
${rootTokensCss()}
:root{--r-s:6px;--r-m:12px;--r-pill:999px}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(960px 400px at 85% -10%,rgba(242,100,48,.16),transparent 70%),var(--bg);color:var(--text);font:var(--fs-0)/1.65 var(--sans);-webkit-font-smoothing:antialiased}
::selection{background:var(--brand);color:var(--bg)}
p{margin:var(--sp-4) 0}
a{color:inherit}
a:focus-visible,button:focus-visible{outline:2px solid var(--brand);outline-offset:var(--sp-1);border-radius:var(--r-s)}
.wrap{width:min(1080px,calc(100% - 48px));margin:0 auto}
.nav{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-4);padding:var(--sp-4) 0;border-bottom:1px solid var(--line)}
.brand{font:600 var(--fs-0) var(--mono);text-decoration:none}
.brand em{font-style:normal;color:var(--brand)}
.links{display:flex;gap:var(--sp-6);flex-wrap:wrap;font-size:var(--fs-n1)}
.links a{color:var(--muted);text-decoration:none}
.links a:hover{color:var(--text)}
.hero{padding:var(--sp-16) 0 var(--sp-12)}
.eyebrow{font:500 var(--fs-n1) var(--mono);color:var(--brand);letter-spacing:.12em;text-transform:uppercase;margin:0 0 var(--sp-4)}
h1{font-size:var(--fs-6);line-height:1.05;letter-spacing:-.02em;margin:0 0 var(--sp-4);max-width:800px;font-weight:700}
.lead{font-size:var(--fs-1);color:var(--muted);max-width:680px;margin:0 0 var(--sp-8)}
.btn{display:inline-block;text-decoration:none;font:600 var(--fs-n1) var(--sans);border-radius:var(--r-pill);padding:var(--sp-3) var(--sp-7);border:1px solid var(--line)}
.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--bg)}
.btn.primary:hover{background:var(--text);border-color:var(--text)}
.btn:not(.primary):hover{border-color:var(--faint)}
.meta{display:flex;gap:var(--sp-3);flex-wrap:wrap;margin-top:var(--sp-8)}
.chip{font:500 var(--fs-n1) var(--mono);color:var(--muted);border:1px solid var(--line);border-radius:var(--r-pill);padding:var(--sp-2) var(--sp-4)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--sp-4);margin:var(--sp-12) 0}
.cell{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-m);padding:var(--sp-8) var(--sp-6)}
.metric{font:600 var(--fs-4) var(--mono);letter-spacing:-.02em}
.metric em{font-style:normal;color:var(--brand)}
.cell strong{display:block;margin-top:var(--sp-2);font-size:var(--fs-n1)}
.muted{color:var(--muted);font-size:var(--fs-n1)}
.src{font:400 var(--fs-n2) var(--mono);color:var(--faint);margin-top:var(--sp-3)}
section{padding:var(--sp-12) 0;border-bottom:1px solid var(--line)}
h2{font-size:var(--fs-2);letter-spacing:-.01em;margin:0 0 var(--sp-4)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-m);padding:var(--sp-8)}
.terminal{font:400 var(--fs-n1)/1.7 var(--mono);overflow-x:auto;white-space:pre;background:var(--panel-2);color:var(--text);border-radius:var(--r-m);padding:var(--sp-6);border:1px solid var(--line);box-shadow:var(--shadow)}
.list{display:grid;gap:var(--sp-3);padding:0;list-style:none;margin:0}
.list li{border-left:2px solid var(--brand);padding-left:var(--sp-4);color:var(--muted);font-size:var(--fs-n1)}
code{font:500 var(--fs-n1) var(--mono);background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-s);padding:0 var(--sp-2)}
footer{padding:var(--sp-8) 0;color:var(--faint);font-size:var(--fs-n1)}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap"><header class="nav"><a class="brand" href="../">forge<em>kit</em></a><nav class="links" aria-label="Primary"><a href="../">Landing</a><a href="#quickstart">Quickstart</a><a href="#changes">Latest</a><a href="#sources">Data Sources</a><a href="https://github.com/CodeWithJuber/forgekit">GitHub ↗</a></nav></header><main id="top"><section class="hero" style="border-bottom:0;padding-bottom:0"><p class="eyebrow">${esc(d.name)} · v${esc(d.version)} · Node ${esc(d.node)}</p><h1>Live status, straight from the repository.</h1><p class="lead">${esc(d.description)}</p><p><a class="btn primary" href="#quickstart">Install in 60 seconds</a> <a class="btn" href="https://github.com/CodeWithJuber/forgekit#readme">Read the docs</a></p><div class="meta"><span class="chip">${esc(d.license)} license</span><span class="chip">${esc(d.deps)} runtime dependencies</span><span class="chip">${esc(d.branch)} @ ${esc(d.commit)}</span>${live}</div></section><div class="grid" aria-label="Measured outcomes"><article class="cell"><div class="metric"><em>${esc(d.impact)}</em></div><strong>blast-radius lookup</strong><p class="muted">Measured from this repo's benchmark report, not a marketing placeholder.</p><p class="src">reports/benchmarks.md</p></article><article class="cell"><div class="metric"><em>${esc(d.speed)}</em></div><strong>pre-action gate</strong><p class="muted">Assumptions, routing, reuse, context, impact, scope, and anchoring.</p><p class="src">reports/benchmarks.md</p></article><article class="cell"><div class="metric"><em>${esc(d.saved.match(/^[\d.]+\s*%?/)?.[0] ?? d.saved)}</em></div><strong>${esc(d.saved.replace(/^[\d.]+\s*%?\s*/, "") || "routing signal")}</strong><p class="muted">Documented from the white-paper prototype and exposed by Forge cost reports.</p><p class="src">whitepaper prototype</p></article></div><section id="quickstart"><h2>Quickstart</h2><div class="terminal">npm install -g @codewithjuber/forgekit
forge init
forge doctor
forge substrate "Change auth validation and update tests"</div></section><section id="changes"><h2>Latest repo changes</h2><div class="card"><ul class="list">${d.latest.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="muted">Benchmark sections indexed: ${esc(d.benchMentions)} · benchmarks file updated ${esc(d.benchUpdated)}.</p></div></section><section id="sources"><h2>Data Sources</h2><div class="card"><p class="muted">No mock data is used. This page is regenerated from repository files during CI (generated ${esc(d.generated)} from ${esc(d.commit)}). Enable <code>BUILD_PAGES_LIVE=1</code> to refresh public GitHub counters with ETag/Last-Modified caching.</p><ul class="list"><li>package.json</li><li>README.md</li><li>CHANGELOG.md</li><li>reports/benchmarks.md</li><li>${api} (optional, no auth, only when BUILD_PAGES_LIVE=1)</li></ul></div></section></main><footer>WCAG-minded semantic HTML, keyboard focus, responsive 320px–1920px+, and reduced-motion-safe. Same design tokens as the landing page — parity enforced in test/pages.test.js.</footer></div></body></html>`;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await collect();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, render(data));
  console.log(`wrote ${out}`);
}
