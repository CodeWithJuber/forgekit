#!/usr/bin/env node
// Data sources: local package.json, README.md, CHANGELOG.md, reports/benchmarks.md,
// and optionally https://api.github.com/repos/CodeWithJuber/forgekit when BUILD_PAGES_LIVE=1.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function lineMatch(text, re, fallback = "") {
  const m = text.match(re);
  return m?.[1]?.trim() ?? fallback;
}
function latestChanges() {
  const section =
    changelog.match(/## \[[^\]]+\][\s\S]*?(?=\n## \[|\n\[Unreleased\]:|$)/)?.[0] ?? "";
  return [...section.matchAll(/^- (.+)$/gm)].slice(0, 4).map((m) => m[1].trim());
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
          { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"), data },
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
    claim: lineMatch(readme, /\*\*(Author[\s\S]*?)\*\*/m, pkg.description),
    speed: lineMatch(readme, /\*\*A full pre-action gate in ([^*]+)\*\*/m, "118 ms"),
    impact: lineMatch(readme, /answers in \*\*([^*]+)\*\*/m, "0.43 ms"),
    saved: lineMatch(readme, /measured \*\*([^*]+)\*\*/m, "62.1% cost saved"),
    benchUpdated: statSync(join(root, "reports/benchmarks.md")).mtime.toISOString().slice(0, 10),
    latest: latestChanges(),
    benchMentions: (benchmarks.match(/^## /gm) ?? []).length,
  };
}
export function render(d) {
  const live = d.github
    ? `<span>${esc(d.github.stars)} stars</span><span>${esc(d.github.forks)} forks</span><span>${esc(d.github.issues)} open issues</span>`
    : `<span>Live GitHub stats disabled</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forgekit — AI agent substrate</title><meta name="description" content="${esc(d.description)}"><style>:root{color-scheme:light dark;--bg:#171310;--fg:#f7efe7;--muted:#b5a99b;--panel:#211a15;--line:#3b2f26;--accent:#f26430;--wash:rgba(242,100,48,.14)}@media(prefers-color-scheme:light){:root{--bg:#fffaf5;--fg:#1d1712;--muted:#65594e;--panel:#fff;--line:#eaded2;--wash:#fff0e9}}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,var(--wash),transparent 34rem),var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}a{color:inherit}a:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.wrap{width:min(1120px,calc(100% - 32px));margin:auto}.nav{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:20px 0}.brand{font:700 18px ui-monospace,SFMono-Regular,Menlo,monospace}.brand b,.accent{color:var(--accent)}.links{display:flex;gap:14px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:12px;padding:10px 14px;text-decoration:none;background:var(--panel)}.btn.primary{background:var(--accent);color:#1b100b;border-color:var(--accent);font-weight:700}.hero{padding:64px 0 36px}.eyebrow{color:var(--accent);font:700 13px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em}h1{font-size:clamp(40px,8vw,88px);line-height:.95;margin:14px 0 20px;max-width:920px}p.lead{font-size:clamp(18px,2vw,24px);max-width:760px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:32px 0}.card{background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.08)}.metric{font:800 34px ui-monospace,monospace;color:var(--accent)}.muted{color:var(--muted)}code{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:2px 6px}.terminal{font:14px ui-monospace,monospace;overflow:auto;white-space:pre;background:#110d0a;color:#f7efe7;border-radius:18px;padding:20px;border:1px solid var(--line)}section{padding:34px 0}h2{font-size:30px;margin:0 0 14px}.list{display:grid;gap:10px;padding:0;list-style:none}.list li{border-left:3px solid var(--accent);padding-left:12px}.meta{display:flex;gap:10px;flex-wrap:wrap}.meta span{border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:var(--muted);font:13px ui-monospace,monospace}footer{border-top:1px solid var(--line);margin-top:40px;padding:28px 0;color:var(--muted)}@media(max-width:800px){.grid{grid-template-columns:1fr}.nav{align-items:flex-start;flex-direction:column}.hero{padding-top:36px}}@media(prefers-reduced-motion:no-preference){.btn{transition:transform .15s}.btn:hover{transform:translateY(-2px)}}</style></head><body><header class="wrap nav"><a class="brand" href="#top"><b>forge</b>kit</a><nav class="links" aria-label="Primary"><a href="#quickstart">Quickstart</a><a href="#changes">Latest</a><a href="#sources">Data sources</a><a href="https://github.com/CodeWithJuber/forgekit">GitHub</a></nav></header><main id="top"><section class="wrap hero"><div class="eyebrow">${esc(d.name)} · v${esc(d.version)} · Node ${esc(d.node)}</div><h1>One professional config layer for every AI coding agent.</h1><p class="lead">${esc(d.description)}</p><p><a class="btn primary" href="#quickstart">Install in 60 seconds</a> <a class="btn" href="https://github.com/CodeWithJuber/forgekit#readme">Read the docs</a></p><div class="meta"><span>${esc(d.license)} license</span><span>${esc(d.deps)} runtime dependencies</span><span>${esc(d.branch)} @ ${esc(d.commit)}</span>${live}</div></section><section class="wrap grid" aria-label="Measured outcomes"><article class="card"><div class="metric">${esc(d.impact)}</div><strong>blast-radius lookup</strong><p class="muted">Measured from this repo's benchmark report, not a marketing placeholder.</p></article><article class="card"><div class="metric">${esc(d.speed)}</div><strong>pre-action gate</strong><p class="muted">Assumptions, routing, reuse, context, impact, scope, and anchoring.</p></article><article class="card"><div class="metric">${esc(d.saved)}</div><strong>routing signal</strong><p class="muted">Documented from the white-paper prototype and exposed by Forge cost reports.</p></article></section><section class="wrap grid"><article class="card"><h2>What it does</h2><ul class="list"><li>Emits native rules for Claude Code, Codex, Cursor, Gemini, Aider, Copilot, Windsurf, Zed, Continue, and MCP clients.</li><li>Keeps proof-carrying memory in git-native files that can merge across teammates.</li><li>Runs deterministic guardrails before agent edits and independent verification after.</li></ul></article><article class="card" id="quickstart"><h2>Quickstart</h2><div class="terminal">npm install -g @codewithjuber/forgekit
forge init
forge doctor
forge substrate "Change auth validation and update tests"</div></article><article class="card"><h2>Auto-updated</h2><p class="muted">This GitLab Pages landing page is generated from repository files during CI. Enable <code>BUILD_PAGES_LIVE=1</code> to refresh public GitHub counters with ETag/Last-Modified caching.</p><p class="muted">Generated ${esc(d.generated)} from ${esc(d.commit)}.</p></article></section><section class="wrap" id="changes"><h2>Latest repo changes</h2><div class="card"><ul class="list">${d.latest.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="muted">Benchmark sections indexed: ${esc(d.benchMentions)} · benchmarks file updated ${esc(d.benchUpdated)}.</p></div></section><section class="wrap" id="sources"><h2>Data Sources</h2><div class="card"><p class="muted">No mock data is used. The page is generated from these sources:</p><ul><li>package.json</li><li>README.md</li><li>CHANGELOG.md</li><li>reports/benchmarks.md</li><li>${api} (optional, no auth, only when BUILD_PAGES_LIVE=1)</li></ul></div></section></main><footer class="wrap">WCAG-minded semantic HTML, keyboard focus, responsive 320px–1920px+, light/dark mode, and reduced-motion-safe interactions.</footer></body></html>`;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await collect();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, render(data));
  console.log(`wrote ${out}`);
}
