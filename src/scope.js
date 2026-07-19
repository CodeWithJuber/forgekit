// forge scope — deterministic task decomposition. Build a cheap import graph (no LLM), find
// connected components, and tell the developer which touched files are INDEPENDENT (→ run in
// separate sessions, so the context window isn't polluted) vs. COUPLED — and which coupled
// files they didn't mention (the "forgot the related module" guard). Regex imports are
// approximate (dynamic/DI edges missed) — a real call-graph MCP is the upgrade seam.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { IGNORE_DIRS, SRC_EXT, toPosix } from "./util.js";

const IMPORT_RES = [
  /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g, // import x from "y"
  /import\s+['"]([^'"]+)['"]/g, // import "y"
  /require\(\s*['"]([^'"]+)['"]\s*\)/g, // require("y")
  /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g, // export … from "y"
  /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import("y")
  /^\s*from\s+(\.[.\w/]*)\s+import/gm, // python: from .y import
];

function walk(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, root, out);
    else if (SRC_EXT.test(entry.name)) out.push(toPosix(relative(root, p)));
  }
}

function resolveSpec(fromRel, spec, root, fileSet) {
  if (!spec.startsWith(".")) return null; // external / stdlib — not a local edge
  const raw = resolve(root, dirname(fromRel), spec);
  const cands = [
    raw,
    ...[".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".py"].map((ext) => raw + ext),
    ...["index.js", "index.ts"].map((idx) => join(raw, idx)),
  ];
  for (const c of cands) {
    const rel = toPosix(relative(root, c));
    if (fileSet.has(rel)) return rel;
  }
  return null;
}

/** Build an UNDIRECTED file→file import graph (coupling is symmetric for decomposition). */
export function importGraph(root) {
  const files = [];
  walk(root, root, files);
  const fileSet = new Set(files);
  const edges = new Map(files.map((f) => [f, new Set()]));
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    for (const re of IMPORT_RES) {
      for (const m of text.matchAll(re)) {
        const target = resolveSpec(f, m[1], root, fileSet);
        if (target && target !== f) {
          edges.get(f).add(target);
          edges.get(target)?.add(f);
        }
      }
    }
  }
  return { nodes: files, edges };
}

/** Connected components (iterative DFS). Each = a set of mutually-coupled files. */
export function components(graph) {
  const seen = new Set();
  const comps = [];
  for (const start of graph.nodes) {
    if (seen.has(start)) continue;
    const stack = [start];
    const comp = [];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const nb of graph.edges.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/**
 * Decompose a set of touched files into independent clusters + the coupled files not mentioned.
 * @returns {{clusters:{touched:string[], coupled:string[]}[], independentGroups:number}}
 */
export function decompose(root, touched) {
  // Normalize to repo-relative (the graph's key form) so `./src/a.js` or an absolute path
  // still matches — otherwise a coupled file is missed and reported as an independent solo.
  const norm = touched.map((t) => toPosix(relative(root, resolve(root, t))));
  const normSet = new Set(norm);
  const comps = components(importGraph(root));
  const compOf = new Map();
  comps.forEach((comp, i) => {
    for (const f of comp) compOf.set(f, i);
  });
  const buckets = new Map();
  let singleton = 0;
  for (const t of norm) {
    const id = compOf.has(t) ? compOf.get(t) : `solo:${singleton++}`;
    if (!buckets.has(id)) buckets.set(id, { touched: [], coupled: new Set() });
    buckets.get(id).touched.push(t);
    if (typeof id === "number") {
      for (const f of comps[id]) if (!normSet.has(f)) buckets.get(id).coupled.add(f);
    }
  }
  const clusters = [...buckets.values()].map((b) => ({
    touched: b.touched,
    coupled: [...b.coupled],
  }));
  return { clusters, independentGroups: clusters.length };
}
