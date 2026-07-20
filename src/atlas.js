// forge atlas — a portable code graph. Build once, then query definitions, membership,
// reverse dependents, and impact radius without asking a model to rediscover the repo.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { adjudicate, asText, buildRunner, llmEnabled } from "./adjudicate.js";
import { CALL_RE } from "./extract.js";
import { contentHash, IGNORE_DIRS, toPosix } from "./util.js";

const JS_RULES = [
  {
    re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    kind: "function",
  },
  { re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g, kind: "class" },
  {
    re: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    kind: "const",
  },
];

// Shared Java/C# method-def grammar. Line-anchored; a bounded ({0,6}) run of keyword
// modifiers (each ending in required whitespace) then `<returnType> name(` — deliberately
// NON-backtracking (no `\s` inside the modifier alternation; the type class excludes
// spaces so it can't span an ambiguous run). A `(?:mod|\s)+` version was polynomial (ReDoS
// on `public static public static …`).
const JVM_METHOD_RE =
  /^[ \t]*(?:(?:public|private|protected|internal|static|final|async|virtual|override|abstract|sealed|partial)[ \t]+){0,6}[\w<>[\],.?]+[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;

export const RULES = {
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
  ".java": [
    { re: /\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g, kind: "type" },
    // method defs, LINE-ANCHORED: ≤6 keyword modifiers (each requires trailing space, so
    // the run can't overlap the return type) + return type + name( . The {0,6} bound and
    // the whitespace-free modifier list keep this linear — a `\s`-in-the-group version
    // backtracked polynomially on `public static public static …` (ReDoS).
    { re: JVM_METHOD_RE, kind: "function" },
  ],
  ".rb": [
    { re: /^\s*def\s+([A-Za-z_]\w*[!?=]?)/gm, kind: "function" },
    { re: /^\s*(?:class|module)\s+([A-Z]\w*)/gm, kind: "class" },
  ],
  ".cs": [
    {
      re: /\b(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/g,
      kind: "type",
    },
    { re: JVM_METHOD_RE, kind: "function" },
  ],
  ".php": [
    { re: /\bfunction\s+([A-Za-z_]\w*)/g, kind: "function" },
    { re: /\b(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/g, kind: "class" },
  ],
  ".kt": [
    {
      re: /\bfun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\s*\(/g,
      kind: "function",
    },
    {
      re: /\b(?:class|interface|object|enum\s+class)\s+([A-Za-z_]\w*)/g,
      kind: "type",
    },
  ],
  ".swift": [
    { re: /\bfunc\s+([A-Za-z_]\w*)/g, kind: "function" },
    {
      re: /\b(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/g,
      kind: "type",
    },
  ],
  ".c": [
    // Function defs, LINE-ANCHORED and linear: 1–4 type/modifier tokens (each ending in
    // required whitespace, so no ambiguous overlap), optional pointer stars, the name,
    // then `(args) {` where args exclude `;{}` and newlines. The old `^[\w*\s]+?…` form
    // let `\s` cross newlines and scanned the whole file from every line start → O(n²)
    // ReDoS (13s on a 445 KB header of prototypes). Requiring a same-line `{` also
    // correctly rejects prototypes/declarations (K&R brace-on-next-line is missed — an
    // acceptable heuristic loss for a symbol index).
    {
      re: /^[ \t]*(?:[A-Za-z_*][\w*]*[ \t]+){1,4}\**([A-Za-z_]\w*)[ \t]*\([^;{}\n]*\)[ \t]*\{/gm,
      kind: "function",
    },
    { re: /\b(?:struct|enum|union)\s+([A-Za-z_]\w*)/g, kind: "type" },
  ],
};
// Kotlin script, C/C++ family, and PHP siblings share the grammar above.
RULES[".kts"] = RULES[".kt"];
for (const ext of [".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh"]) RULES[ext] = RULES[".c"];

// Documentation extensions — first-class in the walk, extracted by extractDoc() (a
// doc node + `references` edges to the code it names), never by the symbol RULES.
// This is the missing code→doc half of impact: change a symbol, its docs show up
// as dependents.
export const DOC_EXTS = new Set([".md"]);

// Docs excluded from the graph: generated files the Stop hook rewrites (AGENTS.md
// auto-sync would re-stale the atlas after every session) and the changelog, which
// churns on every change and whose references describe HISTORY, not current code.
const DOC_SKIP = /^(AGENTS|CLAUDE|GEMINI|CHANGELOG)\.md$/i;

// The extensions the symbol RULES parse — exported as the ONE code-class registry so
// the completion gate and docs sweep classify paths from the same table the graph is
// built from, instead of growing their own regex lists.
export const CODE_EXTS = new Set(Object.keys(RULES));

// Config artifacts — CI workflows, manifests, build/deploy wiring. They name code
// paths, so a code change must surface the configs that point at it (the missing
// config half of impact). Lockfiles are generated churn, never sources of truth.
export const CONFIG_EXTS = new Set([".json", ".yml", ".yaml", ".toml"]);
export const CONFIG_FILE_RE = /^Dockerfile$|\.config\.[\w.]+$/;
const CONFIG_SKIP = /^package-lock\.json$|[-.]lock(\.[\w]+)?$|\.cache\.json$/i;

/** True when a basename is a config artifact worth graphing (lockfiles excluded). */
export function isConfigFile(name) {
  if (CONFIG_SKIP.test(name)) return false;
  return CONFIG_EXTS.has(extname(name)) || CONFIG_FILE_RE.test(name);
}

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

const hash = contentHash;

function walk(dir, files, cap) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge atlas: skipping ${dir}: ${err?.message ?? err}\n`);
    return;
  }
  for (const name of entries) {
    // Dot-entries stay out of the graph — except `.github`, whose workflows are config
    // artifacts that name code paths (a CI file IS a dependent of the code it runs).
    if (IGNORE_DIRS.has(name) || (name.startsWith(".") && name !== ".github")) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, files, cap);
    else if (
      (RULES[extname(name)] ||
        (DOC_EXTS.has(extname(name)) && !DOC_SKIP.test(name)) ||
        isConfigFile(name)) &&
      files.length < cap
    )
      files.push(path);
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

// A markdown file becomes ONE doc node whose outgoing `references` edges point at the
// code it names: backticked `src/foo.js` paths and `symbolName` identifiers, plus
// [link](path) targets. In the reverse-BFS those edges make every referencing doc a
// DEPENDENT of the code — `forge impact src/route.js` now lists the docs that go
// stale, so end-to-end propagation includes documentation, not just callers.
function extractDoc(rel, text) {
  const doc = { id: `doc:${rel}`, name: rel, kind: "doc", file: rel, line: 1 };
  const edges = [];
  const seen = new Set();
  const refEdge = (target, confidence, line) => {
    if (seen.has(target)) return;
    seen.add(target);
    edges.push({
      source: doc.id,
      target,
      kind: "references",
      confidence,
      line,
    });
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const line = lineOf(text, m.index);
    for (const raw of m[1].trim().split(/\s+/)) {
      const tok = raw.replace(/[(),;:]+$/, "").replace(/^\.\//, "");
      if (!tok) continue;
      if (/[/\\]/.test(tok) && RULES[extname(tok)]) {
        refEdge(`module:${moduleId(tok)}`, 0.8, line); // `src/foo.js` → its module node
      } else if (/^[A-Za-z_$][\w$]*(\(\))?$/.test(tok) && tok.length >= 3) {
        const name = tok.replace(/\(\)$/, "");
        if (!BUILTINS.has(name)) refEdge(name, 0.6, line); // `symbolName` → resolveEdges links it
      }
    }
  }
  for (const m of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
    const tok = m[1].replace(/^\.\//, "");
    if (/^[a-z]+:/i.test(tok)) continue; // external URL, not a repo path
    if (RULES[extname(tok)]) refEdge(`module:${moduleId(tok)}`, 0.8, lineOf(text, m.index));
  }
  return { symbols: [], nodes: [doc], edges, hash: hash(text) };
}

// A config artifact (CI workflow, manifest, Dockerfile) becomes ONE config node whose
// `references` edges point at the code files it names — quoted or bare, since YAML and
// Dockerfiles reference paths without quotes (`run: node src/cli.js`). Reverse-BFS then
// lists the configs a code change can break, closing the config half of blast radius.
function extractConfig(rel, text) {
  const cfg = {
    id: `config:${rel}`,
    name: rel,
    kind: "config",
    file: rel,
    line: 1,
  };
  const edges = [];
  const seen = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9_.@-]+(?:[/\\][A-Za-z0-9_.@-]+)*/g)) {
    const tok = m[0].replace(/^\.\//, "");
    if (!RULES[extname(tok)]) continue; // only path-like tokens ending in a code extension
    const target = `module:${moduleId(tok)}`;
    if (seen.has(target)) continue;
    seen.add(target);
    edges.push({
      source: cfg.id,
      target,
      kind: "references",
      confidence: 0.8,
      line: lineOf(text, m.index),
    });
  }
  return { symbols: [], nodes: [cfg], edges, hash: hash(text) };
}

function extractFile(path, root, preRead) {
  const ext = extname(path);
  const rules = RULES[ext];
  // POSIX-normalize: node/config/module ids and `file` fields are compared to `/`-joined
  // paths everywhere (impact(), docs, tests). Windows `\` would break every such lookup.
  const rel = toPosix(relative(root, path));
  let text = preRead;
  if (text == null) {
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { symbols: [], nodes: [], edges: [], hash: "" };
    }
  }
  if (DOC_EXTS.has(ext)) return extractDoc(rel, text);
  if (isConfigFile(rel.split(/[/\\]/).pop() || "")) return extractConfig(rel, text);

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
      symbols.push({
        name,
        kind,
        file: rel,
        line,
        id: node.id,
        qname: node.qname,
      });
      nodes.push(node);
      edges.push({
        source: mod.id,
        target: node.id,
        kind: "contains",
        confidence: 1,
        line,
      });
    }
  }

  // Inheritance edges — `class X extends Y` (JS/TS) and `class X(Base, …)` (Python). Without
  // these the `inherits` edge weight was dead and a base-class change never appeared in blast
  // radius. The base is a bare name; resolveEdges links it to a real node if one exists.
  const classNodes = new Map(nodes.filter((n) => n.kind === "class").map((n) => [n.name, n]));
  const INHERIT_RES = [
    /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$.]*)/g, // JS/TS
    /^\s*class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, // Python
  ];
  for (const re of INHERIT_RES) {
    re.lastIndex = 0;
    let cm;
    while ((cm = re.exec(text))) {
      const child = classNodes.get(cm[1]);
      if (!child) continue;
      const line = lineOf(text, cm.index);
      const bases = cm[2]
        .split(",")
        .map((b) => b.trim())
        .filter((b) => b && !b.includes("=")) // drop Python kwargs like metaclass=ABCMeta
        .map((b) => b.split(".").pop()) // module.Base → Base
        .filter((b) => b && b !== cm[1] && b.toLowerCase() !== "object");
      for (const base of bases)
        edges.push({
          source: child.id,
          target: base,
          kind: "inherits",
          confidence: 0.9,
          line,
        });
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
    if (target)
      edges.push({
        source: source.id,
        target,
        kind: "imports",
        confidence: 0.85,
        line,
      });
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
      edges.push({
        source: source.id,
        target: callee,
        kind: "calls",
        confidence: 0.75,
        line,
      });
    }
  }

  return { symbols, nodes, edges, hash: hash(text) };
}

function resolveEdges(nodes, edges) {
  const byName = new Map();
  const byQname = new Map();
  const idSet = new Set();
  for (const n of nodes) {
    idSet.add(n.id);
    if (n.name) {
      const arr = byName.get(n.name) || [];
      arr.push(n);
      byName.set(n.name, arr);
    }
    if (n.qname) byQname.set(n.qname, n);
  }
  return edges.map((edge) => {
    // O(1) membership — this was a full nodes.some() scan per edge (O(E·N) on real repos).
    if (idSet.has(edge.target)) return edge;
    const direct = byQname.get(edge.target);
    if (direct) return { ...edge, target: direct.id, resolved: true };
    const short = String(edge.target).split(".").pop();
    const matches = byName.get(short) || [];
    if (matches.length === 1)
      return {
        ...edge,
        target: matches[0].id,
        resolved: true,
        confidence: edge.confidence * 0.9,
      };
    return { ...edge, unresolved: true };
  });
}

const cachePath = (root) => join(root, ".forge", "atlas.cache.json");

function readCache(root) {
  try {
    return existsSync(cachePath(root)) ? JSON.parse(readFileSync(cachePath(root), "utf8")) : {};
  } catch {
    return {};
  }
}

export function build({ root = process.cwd(), cap = 20000 } = {}) {
  const files = [];
  walk(root, files, cap);
  // Incremental: reuse the prior per-file extraction when the content hash is unchanged, so a
  // rebuild only re-parses edited files instead of re-running every regex over the whole repo.
  const prev = readCache(root);
  const cache = {};
  const symbols = [];
  const nodes = [];
  const rawEdges = [];
  const fileHashes = {};
  for (const f of files) {
    const rel = toPosix(relative(root, f));
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const h = hash(text);
    const reused = prev[rel]?.hash === h ? prev[rel].data : null;
    const data =
      reused ||
      (({ symbols, nodes, edges }) => ({ symbols, nodes, edges }))(extractFile(f, root, text));
    cache[rel] = { hash: h, data };
    symbols.push(...data.symbols);
    nodes.push(...data.nodes);
    rawEdges.push(...data.edges);
    fileHashes[rel] = h;
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
  writeFileSync(cachePath(root), JSON.stringify(cache));
  return atlas;
}

/**
 * True if the atlas no longer reflects the repo: a tracked file changed or vanished,
 * OR the current eligible-file inventory differs from the indexed one (a brand-new or
 * removed eligible file). Inventory drift is invisible to a fileHashes-only scan — the
 * new file isn't in the map — so it's re-walked here with build()'s OWN walk/eligibility
 * (never a second extension list). Skipped when the graph was capped (files were dropped,
 * so a size diff is expected, not staleness).
 */
export function isStale(root, atlas) {
  if (!atlas?.fileHashes) return true;
  const indexed = new Set(Object.keys(atlas.fileHashes));
  for (const rel of indexed) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      return true; // a tracked file was deleted
    }
    if (hash(text) !== atlas.fileHashes[rel]) return true; // a tracked file changed
  }
  if (!atlas.capped) {
    const current = [];
    walk(root, current, 20000);
    if (current.length !== indexed.size) return true; // a file was added or removed
    for (const p of current) if (!indexed.has(toPosix(relative(root, p)))) return true;
  }
  return false;
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

const EDGE_WEIGHT = {
  calls: 0.95,
  imports: 0.85,
  inherits: 0.92,
  references: 0.7,
  contains: 0.45,
};

// Reverse-adjacency (node id → incoming edges) + node lookup, built once per atlas and memoized.
// substrateCheck calls impact() up to 8× on the same atlas; without this each call rebuilt both.
const ADJ_CACHE = new WeakMap();
function adjacency(atlas) {
  const cached = ADJ_CACHE.get(atlas);
  if (cached) return cached;
  const nodeById = new Map((atlas.nodes || []).map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of atlas.edges || []) {
    if (e.unresolved) continue;
    const arr = incoming.get(e.target) || [];
    arr.push(e);
    incoming.set(e.target, arr);
  }
  const built = { nodeById, incoming };
  ADJ_CACHE.set(atlas, built);
  return built;
}

// Imagination (§8) — LLM proposer for the edges the regex graph structurally misses: dynamic
// dispatch, DI, reflection, string-keyed lookups. PROPOSER ONLY. Every candidate is then
// verified twice — it must resolve to a REAL node in the graph AND (via the caller's `verify`
// predicate, a grep) actually reference the target in source. Unverifiable → dropped, never added.
export function buildImpactPrompt(atlas, target) {
  const files = [...new Set((atlas.nodes || []).map((n) => n.file).filter(Boolean))].slice(0, 60);
  return `A code symbol/file is about to change. Name the OTHER files in this repo that most
likely break or depend on it through edges a regex misses: dynamic dispatch, dependency
injection, reflection, string-keyed registries, event handlers.
Changing target: ${String(target).slice(0, 120)}
Files in repo:
${files.map((f) => `- ${f}`).join("\n")}
Answer with STRICT JSON and nothing else, listing only files from the list above:
{"files":["<path>"...]}
No text outside the JSON object.`;
}

export function parseImpactProposal(obj) {
  const files = Array.isArray(obj.files)
    ? [...new Set(obj.files.map((f) => asText(f, 240)).filter(Boolean))].slice(0, 20)
    : [];
  return { files };
}

export function impactLLM(atlas, target, { run = buildRunner() } = {}) {
  return adjudicate({
    prompt: buildImpactPrompt(atlas, target),
    parse: parseImpactProposal,
    run,
  });
}

/**
 * @param {object} atlas
 * @param {string} target
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxHops]
 * @param {number} [opts.decay]
 * @param {boolean} [opts.llm]
 * @param {(p:string)=>string} [opts.run]
 * @param {(file:string, target:string)=>boolean} [opts.verify]
 */
export function impact(
  atlas,
  target,
  { threshold = 0.1, maxHops = 6, decay = 0.85, llm, run, verify } = {},
) {
  const starts = targetIds(atlas, target);
  const { nodeById, incoming } = adjacency(atlas);
  const visited = new Map();
  const queue = starts.map((id) => ({
    id,
    confidence: 1,
    hop: 0,
    path: [id],
    edgeKinds: [],
  }));
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
        node: nodeById.get(edge.source) || {
          id: edge.source,
          name: edge.source,
          kind: "unknown",
        },
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
  const deterministicFiles = new Set(impacted.map((x) => x.node.file).filter(Boolean));

  // Opt-in imagination pass: model proposes missed edges, but only VERIFIED ones are kept.
  const llmImpacted = [];
  if (llmEnabled({ llm }) && run) {
    const knownFiles = new Set((atlas.nodes || []).map((n) => n.file).filter(Boolean));
    const proposal = impactLLM(atlas, target, { run });
    for (const file of proposal?.files || []) {
      if (deterministicFiles.has(file)) continue; // already found deterministically
      if (!knownFiles.has(file)) continue; // must be a real file in the graph
      if (typeof verify === "function" && !verify(file, target)) continue; // must grep-confirm the ref
      if (typeof verify !== "function") continue; // no external check available → never add blind
      llmImpacted.push({
        id: `llm:${file}`,
        node: { id: `llm:${file}`, name: file, kind: "module", file },
        confidence: Number((threshold * 0.9).toFixed(4)),
        hopDistance: null,
        source: "llm-verified",
      });
    }
  }

  const all = [...impacted, ...llmImpacted];
  return {
    target,
    found: starts.length > 0,
    threshold,
    impacted: all,
    impactedFiles: [...new Set(all.map((x) => x.node.file).filter(Boolean))].sort(),
    llmVerified: llmImpacted.map((x) => x.node.file),
    totalGraphNodes: (atlas.nodes || []).length,
    totalGraphEdges: (atlas.edges || []).length,
  };
}
