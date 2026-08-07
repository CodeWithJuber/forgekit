// forge rank — load-bearing code, measured. Three classical graph readings of the atlas
// plus one join nobody else has: WHERE the structure says a change propagates widely
// (weighted PageRank centrality), WHERE the dependency graph is knotted (Tarjan SCC →
// circular-dependency clusters), WHERE the import graph would split if a file vanished
// (Hopcroft–Tarjan articulation points), and — the original part — how often each file
// has ALREADY bitten the team, from the evidence ledger (val()-weighted lesson and
// session-summary claims that name it). hazard = centralityNorm × (1 + history):
// structurally central code that has hurt before outranks equally central code that
// hasn't. DATA may be a table; DECISIONS are these formulas.
//
// Determinism: no Math.random anywhere — PageRank is a fixed-order power iteration over
// sorted node ids, ties break by (score desc, id asc), so two machines always print the
// same ranking for the same atlas. Substrate/route integration is a deliberate SEAM:
// rank ships standalone (CLI + MCP) first; feeding hazard into route complexity or the
// substrate advisory is a later, separately-measured step.
import { EDGE_WEIGHT, load } from "./atlas.js";
import { val } from "./ledger.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { globToRe } from "./lessons.js";
import { directedImportGraph } from "./scope.js";
import { epochDay, toPosix } from "./util.js";

/** Node kinds that are containers/artifacts, not symbols — excluded from the symbol view. */
const NON_SYMBOL_KINDS = new Set(["module", "doc", "config", "unknown"]);

/**
 * Weighted PageRank over the atlas graph. An edge source→target means "source depends
 * on target", so the random surfer walks WITH dependency direction and rank accrues to
 * what is depended upon. Edge weight = EDGE_WEIGHT[kind] × edge.confidence; out-weights
 * are normalized per source; dangling mass is redistributed uniformly.
 * @param {{nodes?:any[], edges?:any[]}} atlas
 * @param {{damping?:number, maxIter?:number, tol?:number}} [opts]
 * @returns {Map<string, number>} node id → score (scores sum to ~1)
 */
export function pagerank(atlas, { damping = 0.85, maxIter = 60, tol = 1e-9 } = {}) {
  const ids = [...new Set((atlas.nodes ?? []).map((n) => n.id))].sort();
  const n = ids.length;
  const scores = new Map();
  if (!n) return scores;
  const index = new Map(ids.map((id, i) => [id, i]));
  // out[i] = [[j, weight]...] in deterministic (source-sorted, insertion) order
  const out = ids.map(() => []);
  const outWeight = new Float64Array(n);
  const sortedEdges = [...(atlas.edges ?? [])].sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
  for (const e of sortedEdges) {
    if (e.unresolved) continue;
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const w = (EDGE_WEIGHT[e.kind] ?? 0.5) * (e.confidence ?? 1);
    if (w <= 0) continue;
    out[s].push([t, w]);
    outWeight[s] += w;
  }
  let r = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!out[i].length) {
        dangling += r[i];
        continue;
      }
      const share = (damping * r[i]) / outWeight[i];
      for (const [t, w] of out[i]) next[t] += share * w;
    }
    const danglingShare = (damping * dangling) / n;
    let l1 = 0;
    for (let i = 0; i < n; i++) {
      next[i] += danglingShare;
      l1 += Math.abs(next[i] - r[i]);
    }
    r = next;
    if (l1 < tol) break;
  }
  for (let i = 0; i < n; i++) scores.set(ids[i], r[i]);
  return scores;
}

/**
 * File- and symbol-level centrality views. A file's score is the sum of its nodes'
 * PageRank; the symbol view keeps only definition nodes (functions/classes/types).
 * @param {{nodes?:any[], edges?:any[]}} atlas
 * @param {{damping?:number, maxIter?:number, tol?:number}} [opts]
 * @returns {{files:{file:string,score:number}[], symbols:{id:string,name:string,file:string,score:number}[]}}
 */
export function centrality(atlas, opts) {
  const scores = pagerank(atlas, opts);
  const byFile = new Map();
  const symbols = [];
  for (const node of [...(atlas.nodes ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const s = scores.get(node.id) ?? 0;
    if (node.file) byFile.set(node.file, (byFile.get(node.file) ?? 0) + s);
    if (!NON_SYMBOL_KINDS.has(node.kind) && node.name && node.file)
      symbols.push({ id: node.id, name: node.name, file: node.file, score: s });
  }
  const files = [...byFile.entries()].map(([file, score]) => ({ file, score }));
  files.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  symbols.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { files, symbols };
}

/**
 * Circular-import clusters: Tarjan's strongly connected components (iterative — no
 * recursion, deep chains can't blow the stack) over the DIRECTED import graph from
 * scope.directedImportGraph. Deliberately NOT the atlas call edges: unique-name call
 * resolution is too noisy across files (one coincidental name match glues unrelated
 * files into a mega-component — measured on this very repo). Import statements are
 * the ground truth for "circular dependency". Components of ≥2 files are cycles.
 * @param {{nodes:string[], edges:Map<string, Set<string>>}} graph directedImportGraph output
 * @returns {string[][]} each component sorted; list sorted by size desc, then first file
 */
export function cycles(graph) {
  const adj = graph.edges;
  const files = [...graph.nodes].sort();
  const disc = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  let clock = 0;
  for (const start of files) {
    if (disc.has(start)) continue;
    /** @type {{v:string, i:number}[]} iterative Tarjan frames: node + neighbor cursor */
    const frames = [{ v: start, i: 0 }];
    const neighbors = new Map([[start, [...(adj.get(start) ?? [])].sort()]]);
    disc.set(start, clock);
    low.set(start, clock);
    clock++;
    stack.push(start);
    onStack.add(start);
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const { v } = frame;
      const ns = neighbors.get(v);
      if (frame.i < ns.length) {
        const w = ns[frame.i++];
        if (!disc.has(w)) {
          disc.set(w, clock);
          low.set(w, clock);
          clock++;
          stack.push(w);
          onStack.add(w);
          neighbors.set(w, [...(adj.get(w) ?? [])].sort());
          frames.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), disc.get(w)));
        }
      } else {
        frames.pop();
        if (frames.length) {
          const parent = frames[frames.length - 1].v;
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === disc.get(v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          if (comp.length >= 2) comps.push(comp.sort());
        }
      }
    }
  }
  comps.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  return comps;
}

/**
 * Chokepoint files: articulation points (Hopcroft–Tarjan, iterative) of the undirected
 * import graph — files whose removal disconnects part of the repo. `splits` counts the
 * subtrees that would break off (the bigger, the more load-bearing the file).
 * @param {{nodes:string[], edges:Map<string, Set<string>>}} graph scope.importGraph output
 * @returns {{file:string, splits:number}[]} sorted by splits desc, then file asc
 */
export function chokepoints(graph) {
  const disc = new Map();
  const low = new Map();
  const splits = new Map();
  let clock = 0;
  for (const root of [...graph.nodes].sort()) {
    if (disc.has(root)) continue;
    let rootChildren = 0;
    /** @type {{v:string, parent:string|null, i:number}[]} DFS frames (iterative — no recursion) */
    const frames = [{ v: root, parent: null, i: 0 }];
    const neighbors = new Map([[root, [...(graph.edges.get(root) ?? [])].sort()]]);
    disc.set(root, clock);
    low.set(root, clock);
    clock++;
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const { v, parent } = frame;
      const ns = neighbors.get(v);
      if (frame.i < ns.length) {
        const w = ns[frame.i++];
        if (w === parent) continue;
        if (disc.has(w)) {
          low.set(v, Math.min(low.get(v), disc.get(w)));
          continue;
        }
        disc.set(w, clock);
        low.set(w, clock);
        clock++;
        neighbors.set(w, [...(graph.edges.get(w) ?? [])].sort());
        frames.push({ v: w, parent: v, i: 0 });
      } else {
        frames.pop();
        if (!frames.length) continue;
        const p = frames[frames.length - 1].v;
        low.set(p, Math.min(low.get(p), low.get(v)));
        if (p === root) rootChildren++;
        else if (low.get(v) >= disc.get(p)) splits.set(p, (splits.get(p) ?? 0) + 1);
      }
    }
    if (rootChildren > 1) splits.set(root, rootChildren - 1);
  }
  const out = [...splits.entries()].map(([file, s]) => ({ file, splits: s }));
  out.sort((a, b) => b.splits - a.splits || a.file.localeCompare(b.file));
  return out;
}

/**
 * The team-history overlay — how much verified memory already points at each file.
 * Per file: Σ val(claim) over lesson claims whose trigger.files glob-match it and
 * summary claims (deja session records) that list it. val() is the ledger's
 * time-decayed Beta posterior, so stale incidents fade on the same clock everything
 * else in the substrate uses. Pure; fail-open — no claims → all zeros.
 * @param {any[]} claims live ledger claims (loadClaims output)
 * @param {string[]} files repo-relative file paths
 * @param {number} nowDay epoch day for val()
 * @returns {Map<string, {weight:number, hits:number}>} file → history
 */
export function history(claims, files, nowDay) {
  const out = new Map(files.map((f) => [f, { weight: 0, hits: 0 }]));
  for (const claim of claims ?? []) {
    let touched = [];
    if (claim.kind === "lesson") {
      const globs = claim.body?.trigger?.files ?? [];
      if (globs.length)
        touched = files.filter((f) => globs.some((g) => globToRe(String(g)).test(f)));
    } else if (claim.kind === "summary") {
      const set = new Set((claim.body?.files ?? []).map((f) => toPosix(String(f))));
      touched = files.filter((f) => set.has(f));
    }
    if (!touched.length) continue;
    const w = val(claim, nowDay);
    for (const f of touched) {
      const h = out.get(f);
      h.weight += w;
      h.hits += 1;
    }
  }
  return out;
}

const round6 = (x) => Number(x.toFixed(6));

/**
 * The impure assembler the CLI and MCP tool call: load the atlas (missing → build hint),
 * the import graph, and — best-effort — the ledger, then compose the report.
 * @param {string} root
 * @param {{top?:number}} [opts]
 * @returns {{built:boolean, nodes?:number, edges?:number, topFiles?:any[], topSymbols?:any[],
 *   cycles?:string[][], chokepoints?:{file:string,splits:number}[]}}
 */
export function rankReport(root, { top = 15 } = {}) {
  const atlas = load(root);
  if (!atlas) return { built: false };
  // One walk serves both graph readings: cycles need the directed edges, articulation
  // points the undirected view derived from them.
  const directed = directedImportGraph(root);
  const undirected = new Map(directed.nodes.map((f) => [f, new Set()]));
  for (const [f, targets] of directed.edges) {
    for (const t of targets) {
      undirected.get(f).add(t);
      undirected.get(t)?.add(f);
    }
  }
  const { files, symbols } = centrality(atlas);
  let claims = [];
  try {
    claims = loadClaims(repoLedger(root));
  } catch {
    claims = []; // no ledger (or unreadable) → structural ranking only
  }
  const hist = history(
    claims,
    files.map((f) => f.file),
    epochDay(),
  );
  const maxScore = files[0]?.score || 1;
  const ranked = files.map(({ file, score }) => {
    const h = hist.get(file) ?? { weight: 0, hits: 0 };
    return {
      file,
      score: round6(score),
      history: round6(h.weight),
      incidents: h.hits,
      hazard: round6((score / maxScore) * (1 + h.weight)),
    };
  });
  ranked.sort((a, b) => b.hazard - a.hazard || a.file.localeCompare(b.file));
  return {
    built: true,
    nodes: (atlas.nodes ?? []).length,
    edges: (atlas.edges ?? []).length,
    topFiles: ranked.slice(0, top),
    topSymbols: symbols
      .slice(0, top)
      .map((s) => ({ name: s.name, file: s.file, score: round6(s.score) })),
    cycles: cycles(directed),
    chokepoints: chokepoints({ nodes: directed.nodes, edges: undirected }),
  };
}
