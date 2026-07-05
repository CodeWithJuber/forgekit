// forge atlas — a portable code graph. Build once, then query definitions, membership,
// reverse dependents, and impact radius without asking a model to rediscover the repo.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  "__pycache__",
  ".forge",
  "coverage",
  ".venv",
  "vendor",
]);

const JS_RULES = [
  { re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: "function" },
  { re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g, kind: "class" },
  { re: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, kind: "const" },
];
const RULES = {
  ".js": JS_RULES,
  ".jsx": JS_RULES,
  ".ts": JS_RULES,
  ".tsx": JS_RULES,
  ".mjs": JS_RULES,
  ".cjs": JS_RULES,
  ".py": [
    { re: /^\s*def\s+([A-Za-z_]\w*)/gm, kind: "function" },
    { re: /^\s*class\s+([A-Za-z_]\w*)/gm, kind: "class" },
  ],
  ".go": [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: "function" },
    { re: /^type\s+([A-Za-z_]\w*)/gm, kind: "type" },
  ],
  ".rs": [
    { re: /\bfn\s+([A-Za-z_]\w*)/g, kind: "function" },
    { re: /\b(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g, kind: "type" },
  ],
  ".java": [{ re: /\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/g, kind: "type" }],
};

const CALL_RE = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const IMPORT_RE =
  /(?:import\s+(?:[^"'\n]+\s+from\s+)?["']([^"']+)["']|require\(["']([^"']+)["']\)|^\s*(?:from\s+([\w.]+)\s+)?import\s+([\w*,\s]+))/gm;
const BUILTINS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "console",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Promise",
  "Set",
  "Map",
  "Date",
  "Error",
  "RegExp",
  "parseInt",
  "parseFloat",
  "setTimeout",
  "clearTimeout",
  "fetch",
  "print",
  "len",
  "range",
  "int",
  "str",
  "float",
  "dict",
  "list",
  "set",
  "super",
]);

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function walk(dir, files, cap) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, files, cap);
    else if (RULES[extname(name)] && files.length < cap) files.push(path);
  }
}

function moduleId(rel) {
  return rel.replace(/\.[^.]+$/, "").replace(/[/\\]/g, ".");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function nearestSource(nodes, line, fallback) {
  let best = fallback;
  for (const n of nodes) {
    if (n.line <= line && (!best.line || n.line >= best.line)) best = n;
  }
  return best;
}

function extractFile(path, root) {
  const ext = extname(path);
  const rules = RULES[ext];
  const rel = relative(root, path);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { symbols: [], nodes: [], edges: [], hash: "" };
  }

  const mod = {
    id: `module:${moduleId(rel)}`,
    name: moduleId(rel),
    kind: "module",
    file: rel,
    line: 1,
  };
  const symbols = [];
  const nodes = [mod];
  const edges = [];

  for (const { re, kind } of rules) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      const line = lineOf(text, m.index);
      const node = {
        id: `${rel}:${name}:${line}`,
        qname: `${moduleId(rel)}.${name}`,
        name,
        kind,
        file: rel,
        line,
      };
      symbols.push({ name, kind, file: rel, line, id: node.id, qname: node.qname });
      nodes.push(node);
      edges.push({ source: mod.id, target: node.id, kind: "contains", confidence: 1, line });
    }
  }

  IMPORT_RE.lastIndex = 0;
  let im;
  while ((im = IMPORT_RE.exec(text))) {
    const target = im[1] || im[2] || im[3] || "";
    const names = im[4]
      ? im[4]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const line = lineOf(text, im.index);
    const source = nearestSource(nodes.slice(1), line, mod);
    if (target) edges.push({ source: source.id, target, kind: "imports", confidence: 0.85, line });
    for (const name of names) {
      if (name !== "*")
        edges.push({
          source: source.id,
          target: target ? `${target}.${name}` : name,
          kind: "imports",
          confidence: 0.85,
          line,
        });
    }
  }

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    CALL_RE.lastIndex = 0;
    const line = index + 1;
    let cm;
    while ((cm = CALL_RE.exec(lineText))) {
      const callee = cm[1];
      if (BUILTINS.has(callee)) continue;
      const source = nearestSource(nodes.slice(1), line, mod);
      if (source.name === callee) continue;
      edges.push({ source: source.id, target: callee, kind: "calls", confidence: 0.75, line });
    }
  }

  return { symbols, nodes, edges, hash: hash(text) };
}

function resolveEdges(nodes, edges) {
  const byName = new Map();
  const byQname = new Map();
  for (const n of nodes) {
    if (n.name) {
      const arr = byName.get(n.name) || [];
      arr.push(n);
      byName.set(n.name, arr);
    }
    if (n.qname) byQname.set(n.qname, n);
  }
  return edges.map((edge) => {
    if (nodes.some((n) => n.id === edge.target)) return edge;
    const direct = byQname.get(edge.target);
    if (direct) return { ...edge, target: direct.id, resolved: true };
    const short = String(edge.target).split(".").pop();
    const matches = byName.get(short) || [];
    if (matches.length === 1)
      return { ...edge, target: matches[0].id, resolved: true, confidence: edge.confidence * 0.9 };
    return { ...edge, unresolved: true };
  });
}

export function build({ root = process.cwd(), cap = 20000 } = {}) {
  const files = [];
  walk(root, files, cap);
  const symbols = [];
  const nodes = [];
  const rawEdges = [];
  const fileHashes = {};
  for (const f of files) {
    const parsed = extractFile(f, root);
    symbols.push(...parsed.symbols);
    nodes.push(...parsed.nodes);
    rawEdges.push(...parsed.edges);
    fileHashes[relative(root, f)] = parsed.hash;
  }
  const edges = resolveEdges(nodes, rawEdges);
  const atlas = {
    version: 2,
    files: files.length,
    symbols,
    nodes,
    edges,
    fileHashes,
    capped: files.length >= cap,
  };
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "atlas.json"), JSON.stringify(atlas));
  return atlas;
}

export function load(root = process.cwd()) {
  const p = join(root, ".forge", "atlas.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function query(atlas, term) {
  const t = String(term).toLowerCase();
  return (atlas.symbols || []).filter(
    (s) =>
      s.name.toLowerCase().includes(t) ||
      String(s.qname || "")
        .toLowerCase()
        .includes(t),
  );
}

export function has(atlas, name) {
  return (atlas.symbols || []).some((s) => s.name === name || s.qname === name || s.id === name);
}

function targetIds(atlas, target) {
  const t = String(target);
  const nodes = atlas.nodes || [];
  const matches = nodes.filter(
    (n) => n.id === t || n.name === t || n.qname === t || n.file === t || n.file?.endsWith(`/${t}`),
  );
  return matches.map((n) => n.id);
}

const EDGE_WEIGHT = { calls: 0.95, imports: 0.85, inherits: 0.92, references: 0.7, contains: 0.45 };

export function impact(atlas, target, { threshold = 0.1, maxHops = 6, decay = 0.85 } = {}) {
  const starts = targetIds(atlas, target);
  const nodeById = new Map((atlas.nodes || []).map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of atlas.edges || []) {
    if (e.unresolved) continue;
    const arr = incoming.get(e.target) || [];
    arr.push(e);
    incoming.set(e.target, arr);
  }
  const visited = new Map();
  const queue = starts.map((id) => ({ id, confidence: 1, hop: 0, path: [id], edgeKinds: [] }));
  while (queue.length) {
    const current = queue.shift();
    if (!current || current.hop >= maxHops) continue;
    for (const edge of incoming.get(current.id) || []) {
      if (starts.includes(edge.source)) continue;
      const nextConfidence =
        current.confidence * (EDGE_WEIGHT[edge.kind] || 0.5) * (edge.confidence ?? 1) * decay;
      if (nextConfidence < threshold) continue;
      const prev = visited.get(edge.source);
      if (prev && prev.confidence >= nextConfidence) continue;
      const item = {
        id: edge.source,
        node: nodeById.get(edge.source) || { id: edge.source, name: edge.source, kind: "unknown" },
        confidence: Number(nextConfidence.toFixed(4)),
        hopDistance: current.hop + 1,
        path: [...current.path, edge.source],
        edgeKinds: [...current.edgeKinds, edge.kind],
      };
      visited.set(edge.source, item);
      queue.push({
        id: edge.source,
        confidence: nextConfidence,
        hop: current.hop + 1,
        path: item.path,
        edgeKinds: item.edgeKinds,
      });
    }
  }
  const impacted = [...visited.values()].sort((a, b) => b.confidence - a.confidence);
  return {
    target,
    found: starts.length > 0,
    threshold,
    impacted,
    impactedFiles: [...new Set(impacted.map((x) => x.node.file).filter(Boolean))].sort(),
    totalGraphNodes: (atlas.nodes || []).length,
    totalGraphEdges: (atlas.edges || []).length,
  };
}
