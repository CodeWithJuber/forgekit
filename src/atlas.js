// forge atlas — a portable code graph. Build once, then query definitions, membership,
// reverse dependents, and impact radius without asking a model to rediscover the repo.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { adjudicate, asText, buildRunner, llmEnabled } from "./adjudicate.js";
import { CALL_RE } from "./extract.js";
import {
  jsImports,
  lexOf,
  maskCode,
  pyImports,
  pyModuleIndex,
  resolvePyImport,
  resolveSpec,
} from "./scope.js";
import { contentHash, IGNORE_DIRS, toPosix } from "./util.js";

// Bumped whenever extraction or resolution changes shape: an atlas.json or per-file cache
// from an older version is rebuilt, never trusted (v2 stored unresolved import specifiers).
export const ATLAS_VERSION = 3;

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

// Language families. A bare name never resolves across families — a Python
// `from impact_oracle.oracle import …` is not the JS `const oracle` in eval.js. Kotlin↔Java
// interop is real, so the JVM languages share a family; the C/C++ extensions share one.
const FAMILY_BY_EXT = {
  ".js": "js",
  ".jsx": "js",
  ".ts": "js",
  ".tsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".java": "jvm",
  ".kt": "jvm",
  ".kts": "jvm",
  ".rb": "rb",
  ".cs": "cs",
  ".php": "php",
  ".swift": "swift",
};
const familyOf = (file) => {
  const ext = extname(String(file || ""));
  return FAMILY_BY_EXT[ext] ?? (RULES[ext] ? "c" : "");
};

// Extensions an import specifier can name and still be CODE we expect to resolve; an
// unresolved `./styles.css` is an asset, not a missing edge.
const CODE_SPEC_EXTS = new Set(["", ".mts", ".cts", ...Object.keys(RULES)]);

// Docs and configs have their own fixed bound (they are cheap to extract, but a repo of
// 100k generated JSON files must still not make a build unbounded).
const OTHER_FILE_CAP = 20000;

/**
 * The files the graph is built from. `cap` bounds SOURCE files (the RULES extensions) only,
 * so a repo full of JSON/Markdown can no longer crowd code out of the graph; docs/configs
 * have OTHER_FILE_CAP. Every file a cap drops is counted — a capped graph says so.
 * @param {string} root
 * @param {number} cap
 */
function inventory(root, cap) {
  const inv = { files: /** @type {string[]} */ ([]), source: 0, other: 0, skipped: 0 };
  walk(root, inv, cap);
  return inv;
}

function walk(dir, inv, cap) {
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
    if (st.isDirectory()) {
      walk(path, inv, cap);
      continue;
    }
    const ext = extname(name);
    const isSource = Boolean(RULES[ext]);
    if (!isSource && !((DOC_EXTS.has(ext) && !DOC_SKIP.test(name)) || isConfigFile(name))) continue;
    if (isSource ? inv.source >= cap : inv.other >= OTHER_FILE_CAP) {
      inv.skipped += 1;
      continue;
    }
    if (isSource) inv.source += 1;
    else inv.other += 1;
    inv.files.push(path);
  }
}

function moduleId(rel) {
  return rel.replace(/\.[^.]+$/, "").replace(/[/\\]/g, ".");
}

/**
 * Offset → 1-based line by binary search over precomputed line starts. The old
 * `text.slice(0, i).split("\n")` per match made extraction O(n²) (16k lines: ~20 s).
 * @param {string} text
 */
function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  /** @param {number} pos */
  const at = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { at, starts };
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
  const lines = lineIndex(text);
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
    const line = lines.at(m.index ?? 0);
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
    if (RULES[extname(tok)]) refEdge(`module:${moduleId(tok)}`, 0.8, lines.at(m.index ?? 0));
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
  const lines = lineIndex(text);
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
      line: lines.at(m.index ?? 0),
    });
  }
  return { symbols: [], nodes: [cfg], edges, hash: hash(text) };
}

// ---------------------------------------------------------------------------------------
// Scopes — which definition OWNS a call or import. A call belongs to the innermost
// function/class (or top-level const) whose body contains it; a local `const value =
// leaf()` owns nothing, so its call stays with the enclosing function and transitive
// callers of that function stay reachable.
// ---------------------------------------------------------------------------------------

const CONTAINER_KINDS = new Set(["function", "class", "type"]);

/** The `d`-flag twin of a rule regex, so a match reports its NAME's offset (group 1). */
const INDICES = new Map();
function withIndices(re) {
  let d = INDICES.get(re);
  if (!d) {
    d = new RegExp(re.source, re.flags.includes("d") ? re.flags : `${re.flags}d`);
    INDICES.set(re, d);
  }
  d.lastIndex = 0;
  return d;
}

/** Index of the matching `}` for every `{` in masked code (-1 when unbalanced). */
function closingBraces(code) {
  const close = new Int32Array(code.length).fill(-1);
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (c === 123) stack.push(i);
    else if (c === 125 && stack.length) close[stack.pop()] = i;
  }
  return close;
}

/** Brace depth at each of `positions` (ascending), in one linear sweep. */
function depthsAt(code, positions) {
  const out = new Map();
  let depth = 0;
  let k = 0;
  for (let i = 0; i <= code.length && k < positions.length; i++) {
    while (k < positions.length && positions[k] === i) out.set(positions[k++], depth);
    const c = code.charCodeAt(i);
    if (c === 123) depth += 1;
    else if (c === 125) depth -= 1;
  }
  return out;
}

const MAX_HEADER = 4096; // chars between a definition's name and its body's `{`

// The body of a definition in a brace language: the first `{` after its name at bracket
// depth 0, before `limit` (the next definition's line). A `;`, `}`, `=` (Kotlin/C#
// expression body) or an unbalanced `)` first means a declaration with no body here.
function braceBody(code, from, limit, close) {
  let depth = 0;
  for (let j = from; j < limit; j++) {
    const c = code[j];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") {
      depth -= 1;
      if (depth < 0) return -1;
    } else if (depth === 0) {
      if (c === "{") return close[j];
      if (c === ";" || c === "}" || c === "=") return -1;
    }
  }
  return -1;
}

// A line ending in one of these (or the next line starting with one of CONT_START)
// continues the statement — JS automatic semicolon insertion, approximated.
const CONT_END = new Set([..."=+-*/%&|^!~?:,([{<>"]);
const CONT_START = new Set([...".?:,=&|*%^+->"]);

/** End offset of the top-level JS statement starting at `from` (a const initializer). */
function statementEnd(code, from) {
  let depth = 0;
  for (let j = from; j < code.length; j++) {
    const c = code[j];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth < 0) return j;
    } else if (depth === 0 && c === ";") return j;
    else if (depth === 0 && c === "\n") {
      let k = j - 1;
      while (k >= from && (code[k] === " " || code[k] === "\t" || code[k] === "\r")) k -= 1;
      if (k < from || code[k] === "\n" || CONT_END.has(code[k])) continue;
      let m = j + 1;
      while (m < code.length && /\s/.test(code[m])) m += 1;
      if (m < code.length && CONT_START.has(code[m])) continue;
      return j;
    }
  }
  return code.length;
}

/** Python def/class extents by indentation (continuation lines inside brackets skipped). */
function pyScopes(code, defs, lines) {
  const byLine = new Map();
  for (const d of defs) {
    const line = lines.at(d.pos);
    const arr = byLine.get(line);
    if (arr) arr.push(d);
    else byLine.set(line, [d]);
  }
  const out = [];
  const open = [];
  let paren = 0;
  const { starts } = lines;
  for (let li = 0; li < starts.length; li++) {
    const s = starts[li];
    const e = li + 1 < starts.length ? starts[li + 1] : code.length;
    const text = code.slice(s, e);
    if (paren === 0 && text.trim()) {
      const indent = text.length - text.trimStart().length;
      while (open.length && indent <= open[open.length - 1].indent) {
        const o = open.pop();
        out.push({ start: o.start, end: s - 1, node: o.node });
      }
      for (const d of byLine.get(li + 1) || []) open.push({ indent, start: s, node: d.node });
    }
    for (const ch of text) {
      if (ch === "(" || ch === "[" || ch === "{") paren += 1;
      else if (ch === ")" || ch === "]" || ch === "}") paren = Math.max(0, paren - 1);
    }
  }
  for (const o of open) out.push({ start: o.start, end: code.length, node: o.node });
  return out;
}

/**
 * Container extents for one file's definitions (sorted by name offset).
 * @param {string} code masked code
 * @param {{node:any, pos:number, kind:string}[]} defs
 * @param {string} lex
 * @param {ReturnType<typeof lineIndex>} lines
 */
function containerScopes(code, defs, lex, lines) {
  const containers = defs.filter((d) => CONTAINER_KINDS.has(d.kind));
  if (lex === "py") return pyScopes(code, containers, lines);
  if (lex === "rb") {
    // `def … end` — no braces to match: a definition owns code up to the next one.
    return containers.map((d, k) => ({
      start: d.pos,
      end: k + 1 < containers.length ? containers[k + 1].pos - 1 : code.length,
      node: d.node,
    }));
  }
  const close = closingBraces(code);
  const constDepth =
    lex === "js"
      ? depthsAt(
          code,
          defs.filter((d) => d.kind === "const").map((d) => d.pos),
        )
      : new Map();
  // A header never runs into a definition on a LATER line (a Kotlin `fun f(): Int` without
  // a body must not claim the next function's braces) nor past MAX_HEADER chars. Limits
  // are computed in one backward pass, so minified one-line files stay linear.
  const defLine = defs.map((d) => lines.at(d.pos));
  const limitOf = new Array(defs.length).fill(code.length);
  for (let k = defs.length - 2; k >= 0; k--)
    limitOf[k] = defLine[k + 1] > defLine[k] ? lines.starts[defLine[k + 1] - 1] : limitOf[k + 1];
  const out = [];
  for (let k = 0; k < defs.length; k++) {
    const d = defs[k];
    const from = d.pos + d.node.name.length;
    if (CONTAINER_KINDS.has(d.kind)) {
      const limit = Math.max(from, Math.min(limitOf[k], from + MAX_HEADER));
      const end = braceBody(code, from, limit, close);
      if (end > 0) out.push({ start: d.pos, end, node: d.node });
    } else if (d.kind === "const" && constDepth.get(d.pos) === 0) {
      out.push({ start: d.pos, end: statementEnd(code, from), node: d.node });
    }
  }
  return out;
}

/** Innermost container scope at an offset: binary search + parent chain over nested extents. */
function scopeFinder(scopes) {
  const sorted = scopes
    .filter((s) => s.end >= s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const parent = new Int32Array(sorted.length).fill(-1);
  const stack = [];
  for (let i = 0; i < sorted.length; i++) {
    while (stack.length && sorted[stack[stack.length - 1]].end < sorted[i].start) stack.pop();
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
  }
  /** @param {number} pos */
  return (pos) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].start <= pos) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    while (idx >= 0 && sorted[idx].end < pos) idx = parent[idx];
    return idx >= 0 ? sorted[idx] : null;
  };
}

// `name(args) {` in a brace language is a method/function DEFINITION, not a call — and an
// object or class method is not indexed as a symbol, so without this every `emit(ctx) {`
// became a call edge to whatever unique `emit` existed elsewhere in the repo.
const METHOD_DEF_SCAN = 2000;
function isMethodDef(code, from) {
  let i = from;
  while (i < code.length && /[ \t]/.test(code[i])) i += 1;
  if (code[i] !== "(") return false;
  let depth = 0;
  const limit = Math.min(code.length, i + METHOD_DEF_SCAN);
  for (; i < limit; i++) {
    const c = code[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return false;
  for (i += 1; i < code.length; i++) {
    const c = code[i];
    if (/\s/.test(c)) continue;
    return c === "{";
  }
  return false;
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

  // Every structural regex below runs on MASKED code: comments and string contents are
  // blank, so a comment saying `class Parser` defines nothing and a string holding
  // `foo(` calls nothing. Offsets and line numbers are unchanged by masking.
  const lex = lexOf(ext);
  const code = maskCode(text, ext);
  const lines = lineIndex(text);
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
  const defs = [];

  for (const { re, kind } of rules) {
    const dre = withIndices(re);
    let m;
    while ((m = dre.exec(code))) {
      if (!m[0]) {
        dre.lastIndex += 1; // never loop on an empty match
        continue;
      }
      const name = m[1];
      const pos = m.indices?.[1]?.[0] ?? m.index;
      const line = lines.at(pos);
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
      defs.push({ node, pos, kind });
      edges.push({
        source: mod.id,
        target: node.id,
        kind: "contains",
        confidence: 1,
        line,
      });
    }
  }
  defs.sort((a, b) => a.pos - b.pos);
  const scopes = containerScopes(code, defs, lex, lines);
  const scopeAt = scopeFinder(scopes);
  const ownerAt = (pos) => scopeAt(pos)?.node ?? mod;
  // A definition nested inside another (a local const, a nested def, a method) is `local`:
  // same-file calls may bind to it, but it is never a cross-file bare-name candidate.
  const ownStart = new Map(scopes.map((sc) => [sc.node, sc.start]));
  for (const d of defs) {
    const at = (ownStart.get(d.node) ?? d.pos) - 1;
    const parent = at >= 0 ? scopeAt(at) : null;
    if (parent && parent.node !== d.node && parent.end >= d.pos) d.node.local = true;
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
    while ((cm = re.exec(code))) {
      const child = classNodes.get(cm[1]);
      if (!child) continue;
      const line = lines.at(cm.index + cm[0].indexOf(cm[1]));
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

  // Imports — parsed structurally (every JS/TS form incl. `export * from`, re-exports,
  // dynamic import, require; Python relative/parenthesised/aliased) and resolved to FILES
  // in resolveEdges, which needs the whole file set. Owned by the enclosing scope, so a
  // dynamic import inside a function is that function's dependency.
  if (lex === "js" || lex === "py") {
    const found = lex === "py" ? pyImports(code) : jsImports(code, text);
    for (const imp of found) {
      const owner = ownerAt(imp.index);
      const py = /** @type {import("./scope.js").PyImport} */ (imp);
      const js = /** @type {import("./scope.js").JsImport} */ (imp);
      edges.push({
        source: owner.id,
        target: lex === "py" ? `${".".repeat(py.level)}${py.module}` : js.spec,
        kind: "imports",
        confidence: 0.85,
        line: lines.at(imp.index),
        lang: lex,
        names: imp.names,
        ...(lex === "py" ? { module: py.module, level: py.level } : { form: js.form }),
      });
    }
  }

  // Calls — attributed to the innermost enclosing container (see containerScopes). A match
  // that IS a definition's name (`function foo(`, `def foo(`) is not a call.
  const defAt = new Set(defs.map((d) => d.pos));
  const callRe = withIndices(CALL_RE);
  const { starts } = lines;
  for (let li = 0; li < starts.length; li++) {
    const s = starts[li];
    const lineText = code.slice(s, li + 1 < starts.length ? starts[li + 1] : code.length);
    callRe.lastIndex = 0;
    let cm;
    while ((cm = callRe.exec(lineText))) {
      const callee = cm[1];
      if (BUILTINS.has(callee)) continue;
      const pos = s + (cm.indices?.[1]?.[0] ?? cm.index);
      if (defAt.has(pos)) continue;
      if (lex !== "py" && isMethodDef(code, pos + callee.length)) continue;
      const source = ownerAt(pos);
      if (source.name === callee) continue;
      edges.push({
        source: source.id,
        target: callee,
        kind: "calls",
        confidence: 0.75,
        line: li + 1,
      });
    }
  }

  return { symbols, nodes, edges, hash: hash(text) };
}

/**
 * Resolve raw edges against the whole graph.
 *  - imports: STRUCTURALLY — a JS/TS specifier through scope.resolveSpec (exact, NodeNext
 *    `.js`→`.ts`, extensionless, `index.*`), a Python module through package-root qnames
 *    (scope.pyModuleIndex). Never a bare-name guess: an import that does not resolve to a
 *    file stays unresolved (counted), it is not pinned to whatever shares its last segment.
 *  - calls/inherits: a definition in the same file, else a name this file imported, else a
 *    unique definition in the same LANGUAGE FAMILY. More than one candidate is ambiguous:
 *    the edge is dropped from traversal but marked and counted, never silently lost.
 *  - doc references: exact module ids, or a unique symbol name in any language.
 * @param {any[]} nodes
 * @param {any[]} rawEdges
 * @param {string[]} files repo-relative POSIX paths of every walked file
 */
function resolveEdges(nodes, rawEdges, files) {
  const fileSet = new Set(files);
  const pyIndex = pyModuleIndex(files);
  const localPyTops = new Set([...pyIndex.canonical.keys()].map((n) => n.split(".")[0]));
  const nodeById = new Map();
  const byName = new Map(); // bare name → code definitions
  const byFile = new Map(); // file → (name → definitions)
  const fileNode = new Map(); // file → its module/config/doc node
  for (const n of nodes) {
    nodeById.set(n.id, n);
    if (n.kind === "module" || n.kind === "config" || n.kind === "doc") {
      if (!fileNode.has(n.file) || n.kind === "module") fileNode.set(n.file, n);
      continue;
    }
    if (!n.name) continue;
    if (!n.local) {
      const arr = byName.get(n.name);
      if (arr) arr.push(n);
      else byName.set(n.name, [n]);
    }
    let names = byFile.get(n.file);
    if (!names) byFile.set(n.file, (names = new Map()));
    const own = names.get(n.name);
    if (own) own.push(n);
    else names.set(n.name, [n]);
  }
  const defIn = (file, name) => {
    const cands = byFile.get(file)?.get(name);
    return cands?.length ? (cands.find((n) => n.kind !== "const") ?? cands[0]) : null;
  };
  const stats = {
    imports: { total: 0, resolved: 0, external: 0, unresolved: 0, assets: 0 },
    names: { resolved: 0, ambiguous: 0, unresolved: 0 },
  };
  // file → (local name → node id | null), from named imports; null = bound to something
  // that is not a local definition (an external package), so never guessed by bare name.
  const bindings = new Map();
  const bind = (file, local, id) => {
    let m = bindings.get(file);
    if (!m) bindings.set(file, (m = new Map()));
    if (!m.has(local)) m.set(local, id);
  };
  const out = [];

  // Pass 1 — imports.
  for (const e of rawEdges) {
    if (e.kind !== "imports" || !e.lang) continue;
    stats.imports.total += 1;
    const from = nodeById.get(e.source)?.file ?? "";
    /** @type {{file:string, names:{imported:string, local:string}[]}[]} */
    let hits = [];
    let local = false;
    if (e.lang === "py") {
      hits = resolvePyImport(
        from,
        { module: e.module, level: e.level, names: e.names || [], index: 0 },
        pyIndex,
      );
      local = e.level > 0 || localPyTops.has(String(e.module).split(".")[0]);
    } else {
      const file = resolveSpec(from, e.target, fileSet);
      if (file) hits = [{ file, names: e.names || [] }];
      local = /^\.\.?(\/|$)/.test(e.target);
    }
    const base = {
      source: e.source,
      kind: "imports",
      confidence: e.confidence,
      line: e.line,
      spec: e.target,
    };
    if (!hits.length) {
      for (const n of e.names || []) bind(from, n.local, null);
      const asset = local && e.lang === "js" && !CODE_SPEC_EXTS.has(extname(e.target));
      if (asset) stats.imports.assets += 1;
      else if (local) stats.imports.unresolved += 1;
      else stats.imports.external += 1;
      out.push({
        ...base,
        target: e.target,
        unresolved: true,
        ...(local && !asset ? { reason: "not-found" } : { external: true }),
      });
      continue;
    }
    stats.imports.resolved += 1;
    for (const hit of hits) {
      if (hit.file === from) continue;
      // A named import that pins a definition is an edge to THAT symbol (the Python
      // oracle's `from X import a` → `X.a`). The file-level edge is kept only when the
      // import cannot be narrowed — namespace, default, side-effect, `export *`, dynamic,
      // require, or a name not defined in the target file — otherwise every importer of
      // an importer would inherit the dependency (module-level over-approximation).
      let wholeModule = hit.names.length === 0;
      for (const n of hit.names) {
        const sym =
          n.imported === "*" || n.imported === "default" ? null : defIn(hit.file, n.imported);
        if (!sym) {
          wholeModule = true;
          continue;
        }
        out.push({ ...base, target: sym.id, resolved: true });
        if (e.form !== "reexport") bind(from, n.local, sym.id);
      }
      const target = fileNode.get(hit.file);
      if (wholeModule && target) out.push({ ...base, target: target.id, resolved: true });
    }
  }

  // Pass 2 — everything else.
  for (const e of rawEdges) {
    if (e.kind === "imports" && e.lang) continue;
    if (nodeById.has(e.target)) {
      out.push(e); // contains, module-id references
      continue;
    }
    const target = String(e.target);
    if (target.startsWith("module:")) {
      out.push({ ...e, unresolved: true }); // a doc/config path that is not in the graph
      continue;
    }
    const src = nodeById.get(e.source);
    const file = src?.file ?? "";
    let hit = null;
    let confidence = e.confidence;
    let bound = false;
    if (e.kind !== "references") {
      const own = defIn(file, target);
      if (own && own.id !== e.source) hit = own.id;
      else if (bindings.get(file)?.has(target)) {
        hit = bindings.get(file).get(target);
        bound = true; // imported by name: never re-guessed globally, even when external
      }
    }
    let ambiguous = false;
    if (!hit && !bound) {
      const fam = e.kind === "references" ? "" : familyOf(file);
      const cands = (byName.get(target) || []).filter((n) => !fam || familyOf(n.file) === fam);
      if (cands.length === 1) {
        hit = cands[0].id;
        confidence = e.confidence * 0.9;
      } else ambiguous = cands.length > 1;
    }
    if (hit) {
      stats.names.resolved += 1;
      out.push({ ...e, target: hit, resolved: true, confidence });
    } else {
      if (ambiguous) stats.names.ambiguous += 1;
      else stats.names.unresolved += 1;
      out.push({
        ...e,
        unresolved: true,
        ...(ambiguous ? { ambiguous: true } : bound ? { external: true } : {}),
      });
    }
  }
  return { edges: out, stats };
}

const cachePath = (root) => join(root, ".forge", "atlas.cache.json");

function readCache(root) {
  try {
    if (!existsSync(cachePath(root))) return {};
    const parsed = JSON.parse(readFileSync(cachePath(root), "utf8"));
    // An older extractor's per-file output is not reusable (different edge shapes).
    return parsed?.version === ATLAS_VERSION ? parsed.entries || {} : {};
  } catch {
    return {};
  }
}

export function build({ root = process.cwd(), cap = 20000 } = {}) {
  const inv = inventory(root, cap);
  // Incremental: reuse the prior per-file extraction when the content hash is unchanged, so a
  // rebuild only re-parses edited files instead of re-running every regex over the whole repo.
  const prev = readCache(root);
  const cache = {};
  const symbols = [];
  const nodes = [];
  const rawEdges = [];
  const fileHashes = {};
  const rels = [];
  for (const f of inv.files) {
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
    rels.push(rel);
  }
  const { edges, stats } = resolveEdges(nodes, rawEdges, rels);
  const atlas = {
    version: ATLAS_VERSION,
    files: inv.files.length,
    sourceFiles: inv.source,
    symbols,
    nodes,
    edges,
    fileHashes,
    cap,
    // True only when a file was actually dropped (the old `files >= cap` also fired at
    // exactly `cap` files, and counted docs/configs against a source-file cap).
    capped: inv.skipped > 0,
    skippedFiles: inv.skipped,
    stats,
  };
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "atlas.json"), JSON.stringify(atlas));
  writeFileSync(cachePath(root), JSON.stringify({ version: ATLAS_VERSION, entries: cache }));
  return atlas;
}

/**
 * True if the atlas no longer reflects the repo: it was built by an older extractor, a
 * tracked file changed or vanished, OR the current eligible-file inventory differs from
 * the indexed one (a brand-new or removed eligible file). Inventory drift is invisible to a
 * fileHashes-only scan — the new file isn't in the map — so it's re-walked here with
 * build()'s OWN walk/eligibility (never a second extension list). Skipped when the graph
 * was capped (files were dropped, so a size diff is expected, not staleness).
 */
export function isStale(root, atlas) {
  if (!atlas?.fileHashes || atlas.version !== ATLAS_VERSION) return true;
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
    const current = inventory(root, atlas.cap ?? 20000).files;
    if (current.length !== indexed.size) return true; // a file was added or removed
    for (const p of current) if (!indexed.has(toPosix(relative(root, p)))) return true;
  }
  return false;
}

export function load(root = process.cwd()) {
  const p = join(root, ".forge", "atlas.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/**
 * Symbols matching `term`, RANKED: exact name, then case-insensitive exact, then name
 * prefix, then name substring, and qname-only (i.e. file-path) matches last — stable within
 * a tier. Unranked, `build` returned 30 symbols from files whose PATH contains "build"
 * before `function build` itself.
 * @param {object} atlas
 * @param {string} term
 * @returns {object[]}
 */
export function query(atlas, term) {
  const raw = String(term);
  const t = raw.toLowerCase();
  const tier = (s) => {
    const name = String(s.name ?? "");
    if (name === raw) return 0;
    const lower = name.toLowerCase();
    if (lower === t) return 1;
    if (lower.startsWith(t)) return 2;
    if (lower.includes(t)) return 3;
    return String(s.qname || "")
      .toLowerCase()
      .includes(t)
      ? 4
      : -1;
  };
  return (atlas.symbols || [])
    .map((s, i) => ({ s, i, k: tier(s) }))
    .filter((x) => x.k >= 0)
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.s);
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

// Exported for rank.js — PageRank centrality weights edges with the same priors the
// blast-radius search uses, so "load-bearing" and "impacted" can never disagree on
// what an edge kind is worth.
export const EDGE_WEIGHT = {
  calls: 0.95,
  imports: 0.85,
  inherits: 0.92,
  references: 0.7,
  contains: 0.45,
};

// Reverse- and forward-adjacency + node lookup, built once per atlas and memoized.
// substrateCheck calls impact() up to 8× on the same atlas; without this each call rebuilt both.
const ADJ_CACHE = new WeakMap();
function adjacency(atlas) {
  const cached = ADJ_CACHE.get(atlas);
  if (cached) return cached;
  const nodeById = new Map((atlas.nodes || []).map((n) => [n.id, n]));
  const incoming = new Map();
  const outgoing = new Map();
  const ambiguousByName = new Map(); // bare name → dropped ambiguous references to it
  for (const e of atlas.edges || []) {
    if (e.unresolved) {
      if (e.ambiguous) ambiguousByName.set(e.target, (ambiguousByName.get(e.target) ?? 0) + 1);
      continue;
    }
    const inc = incoming.get(e.target);
    if (inc) inc.push(e);
    else incoming.set(e.target, [e]);
    const out = outgoing.get(e.source);
    if (out) out.push(e);
    else outgoing.set(e.source, [e]);
  }
  const nodesByFile = new Map();
  for (const n of atlas.nodes || []) {
    if (!n.file || !isCode(n)) continue;
    const arr = nodesByFile.get(n.file);
    if (arr) arr.push(n.id);
    else nodesByFile.set(n.file, [n.id]);
  }
  const fanIn = new Map();
  /** Distinct OTHER source files whose code depends on `file` (docs/configs excluded):
   *  the in-degree the sibling hub cap is applied to. */
  const fileIndegree = (file) => {
    let d = fanIn.get(file);
    if (d === undefined) {
      const users = new Set();
      for (const id of nodesByFile.get(file) || [])
        for (const e of incoming.get(id) || []) {
          const src = nodeById.get(e.source);
          if (isCode(src) && src.file !== file) users.add(src.file);
        }
      d = users.size;
      fanIn.set(file, d);
    }
    return d;
  };
  const built = { nodeById, incoming, outgoing, ambiguousByName, nodesByFile, fileIndegree };
  ADJ_CACHE.set(atlas, built);
  return built;
}

const isCode = (node) => Boolean(node) && node.kind !== "doc" && node.kind !== "config";

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
 * Build a file → SCC-id index from the output of rank.cycles(). Files in the
 * same SCC share an id; files not in any cycle are absent from the map.
 * @param {string[][]} sccs each entry is a sorted list of files in one SCC
 * @returns {Map<string, number>}
 */
export function buildSccIndex(sccs) {
  const index = new Map();
  for (let i = 0; i < sccs.length; i++) for (const file of sccs[i]) index.set(file, i);
  return index;
}

// The two relations the empirical refutation found missing (research/empirical-refutation,
// Defect 2: reverse-only traversal; 94.7% of real misses were siblings). Ported from the
// repaired Python oracle (replication package, impact_oracle v2, oracle.py) with the
// FROZEN_PARAMETERS.json values chosen on the tuning repos before the held-out run —
// deliberately not re-tuned here:
//   sibling_forward_hops 1 · sibling_reverse_hops 1 · sibling_weight 0.7 ·
//   sibling_bridge_max_indegree 100 · forward_max_hops 2 · forward_weight 0.5
//  - SIBLING: one forward hop to a shared dependency (the bridge), then one reverse hop
//    from it: A and B both use module C, so a change to how A uses C's contract co-changes
//    B. The bridge is C's FILE (a named import points at one symbol of C; bridging on that
//    exact node would miss a B that uses another part of C). Bridges used by more than
//    `bridgeMaxIndegree` other files are hubs — weak sibling evidence — and are skipped.
//  - FORWARD: the changed code's own dependencies, up to `maxHops` (editing a call site
//    may mean updating the callee).
// Both are TERMINAL: a node they reach is reported but never expanded further. Hop counts
// are fixed at the frozen values: the walks below implement exactly 1+1 and ≤2 hops.
export const SIBLING = Object.freeze({
  forwardHops: 1,
  reverseHops: 1,
  weight: 0.7,
  bridgeMaxIndegree: 100,
});
export const FORWARD = Object.freeze({ maxHops: 2, weight: 0.5 });
export const IMPACT_RELATIONS = Object.freeze(["reverse", "sibling", "forward"]);
/** What `impact()` walks unless a caller asks for more. The sibling/forward rules above are
 *  the paper's repair and they work — but they are a RECALL instrument: on this repo the
 *  median answer goes from 15 files to 78 of ~450 (max 196), recall 1.00, precision 0.093.
 *  An everyday "what does this change touch?" wants the focused answer, and a gate whose
 *  blast threshold is 25 files would otherwise trip on almost every edit. So the wider walk
 *  is opt-in: `impact(atlas, f, { relations: IMPACT_RELATIONS })`, or `--all-relations`. */
export const DEFAULT_IMPACT_RELATIONS = Object.freeze(["reverse"]);

const round4 = (x) => Number(x.toFixed(4));

/**
 * @param {object} atlas
 * @param {string} target
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxHops] reverse-dependency hop cap
 * @param {number} [opts.decay]
 * @param {readonly string[]} [opts.relations] subset of IMPACT_RELATIONS
 *   (default: DEFAULT_IMPACT_RELATIONS — reverse only; pass IMPACT_RELATIONS for the wide walk)
 * @param {boolean} [opts.llm]
 * @param {(p:string)=>string} [opts.run]
 * @param {(file:string, target:string)=>boolean} [opts.verify]
 * @param {Map<string, number>} [opts.sccIndex] file-to-SCC-id (from buildSccIndex)
 * @param {Map<string, number>} [opts.hazards] file-to-hazard-score (from rankReport)
 */
export function impact(
  atlas,
  target,
  {
    threshold = 0.1,
    maxHops = 6,
    decay = 0.85,
    relations = DEFAULT_IMPACT_RELATIONS,
    llm,
    run,
    verify,
    sccIndex,
    hazards,
  } = {},
) {
  const starts = targetIds(atlas, target);
  const startSet = new Set(starts);
  const { nodeById, incoming, outgoing, ambiguousByName, nodesByFile, fileIndegree } =
    adjacency(atlas);
  const wanted = new Set(relations);
  const step = (conf, edge) =>
    conf * (EDGE_WEIGHT[edge.kind] || 0.5) * (edge.confidence ?? 1) * decay;
  const visited = new Map();
  const queue = wanted.has("reverse")
    ? starts.map((id) => ({
        id,
        confidence: 1,
        hop: 0,
        path: [id],
        edgeKinds: [],
      }))
    : [];
  // Label-correcting search: a node re-enters the queue whenever a better path is
  // found, so the loop converges to the max-product confidence. The queue is drained
  // with an index pointer (queue.shift() is O(n) on V8 arrays — quadratic on large
  // frontiers). A heap-based best-first variant is the upgrade seam if graphs ever
  // outgrow this; it would change processing order, so it must re-prove the diamond
  // max-product test before landing.
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (!current || current.hop >= maxHops) continue;
    for (const edge of incoming.get(current.id) || []) {
      if (startSet.has(edge.source)) continue;
      const nextConfidence = step(current.confidence, edge);
      const srcNode = nodeById.get(edge.source);
      const srcFile = srcNode?.file;
      const effectiveThreshold =
        hazards && srcFile && hazards.has(srcFile)
          ? threshold / (1 + hazards.get(srcFile))
          : threshold;
      if (nextConfidence < effectiveThreshold) continue;
      const prev = visited.get(edge.source);
      if (prev && prev.confidence >= nextConfidence) continue;
      const item = {
        id: edge.source,
        node: srcNode || {
          id: edge.source,
          name: edge.source,
          kind: "unknown",
        },
        confidence: round4(nextConfidence),
        hopDistance: current.hop + 1,
        relation: "reverse",
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
      if (sccIndex && srcFile != null && sccIndex.has(srcFile)) {
        const sccId = sccIndex.get(srcFile);
        for (const node of atlas.nodes || []) {
          if (node.file === srcFile || !sccIndex.has(node.file)) continue;
          if (sccIndex.get(node.file) !== sccId) continue;
          if (startSet.has(node.id)) continue;
          const prevScc = visited.get(node.id);
          if (prevScc && prevScc.confidence >= nextConfidence) continue;
          const sccItem = {
            id: node.id,
            node,
            confidence: round4(nextConfidence),
            hopDistance: current.hop + 1,
            relation: "reverse",
            path: [...current.path, edge.source, node.id],
            edgeKinds: [...current.edgeKinds, edge.kind, "scc"],
          };
          visited.set(node.id, sccItem);
          queue.push({
            id: node.id,
            confidence: nextConfidence,
            hop: current.hop + 1,
            path: sccItem.path,
            edgeKinds: sccItem.edgeKinds,
          });
        }
      }
    }
  }

  // Sibling/forward items carry `relation` + `relationHops`; `hopDistance` stays the
  // REVERSE-dependency distance (null here), so "direct dependents" filters keep meaning.
  const offer = (id, confidence, relation, path, edgeKinds) => {
    const node = nodeById.get(id);
    if (!node || confidence < threshold) return;
    const prev = visited.get(id);
    if (prev && prev.confidence >= round4(confidence)) return;
    visited.set(id, {
      id,
      node,
      confidence: round4(confidence),
      hopDistance: null,
      relationHops: path.length - 1,
      relation,
      path,
      edgeKinds,
    });
  };

  const startFiles = new Set(starts.map((id) => nodeById.get(id)?.file).filter(Boolean));
  const codeStarts = starts.filter((id) => isCode(nodeById.get(id)));

  if (wanted.has("sibling")) {
    // Step 1 — one forward hop from the changed code; the FILE it lands in is the bridge
    // (the paper's "common module C"). A named import points at a symbol, so bridging on
    // the exact node would miss B when A and B use different parts of C's contract.
    const bridges = new Map(); // file → best forward step into it
    for (const s of codeStarts) {
      for (const e of outgoing.get(s) || []) {
        const t = nodeById.get(e.target);
        if (!isCode(t) || startSet.has(e.target) || startFiles.has(t.file)) continue;
        const conf = step(1, e);
        const had = bridges.get(t.file);
        if (!had || had.conf < conf)
          bridges.set(t.file, { conf, from: s, entry: e.target, kind: e.kind });
      }
    }
    // Step 2 — one reverse hop from each non-hub bridge to the other code that uses it.
    for (const [file, b] of bridges) {
      if (fileIndegree(file) > SIBLING.bridgeMaxIndegree) continue; // hub: weak evidence
      for (const id of nodesByFile.get(file) || []) {
        for (const e of incoming.get(id) || []) {
          const src = nodeById.get(e.source);
          if (!isCode(src) || startSet.has(e.source) || src.file === file) continue;
          const path = id === b.entry ? [b.from, id, e.source] : [b.from, b.entry, id, e.source];
          const kinds = id === b.entry ? [b.kind, e.kind] : [b.kind, "same-file", e.kind];
          offer(e.source, step(b.conf, e) * SIBLING.weight, "sibling", path, kinds);
        }
      }
    }
  }

  if (wanted.has("forward")) {
    for (const s of codeStarts) {
      const seen = new Set(startSet);
      let frontier = [{ id: s, conf: 1, path: [s], kinds: [] }];
      for (let hop = 0; hop < FORWARD.maxHops && frontier.length; hop++) {
        const next = [];
        for (const cur of frontier) {
          for (const e of outgoing.get(cur.id) || []) {
            if (seen.has(e.target)) continue;
            seen.add(e.target);
            const conf = step(cur.conf, e);
            const path = [...cur.path, e.target];
            const kinds = [...cur.kinds, e.kind];
            offer(e.target, conf * FORWARD.weight, "forward", path, kinds);
            next.push({ id: e.target, conf, path, kinds });
          }
        }
        frontier = next;
      }
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
        confidence: round4(threshold * 0.9),
        hopDistance: null,
        relation: "llm-verified",
        source: "llm-verified",
      });
    }
  }

  const all = [...impacted, ...llmImpacted];
  const relationCounts = {};
  for (const x of all) relationCounts[x.relation] = (relationCounts[x.relation] ?? 0) + 1;
  // Completeness signals — a blast radius is only as good as the graph under it. Say when
  // files were dropped by the cap, how many local imports did not resolve anywhere, and how
  // many references to THIS target's names were dropped as ambiguous.
  const startNames = new Set(starts.map((id) => nodeById.get(id)?.name).filter(Boolean));
  let ambiguousRefs = 0;
  for (const name of startNames) ambiguousRefs += ambiguousByName.get(name) ?? 0;
  return {
    target,
    found: starts.length > 0,
    threshold,
    impacted: all,
    impactedFiles: [...new Set(all.map((x) => x.node.file).filter(Boolean))].sort(),
    relations: relationCounts,
    llmVerified: llmImpacted.map((x) => x.node.file),
    totalGraphNodes: (atlas.nodes || []).length,
    totalGraphEdges: (atlas.edges || []).length,
    capped: Boolean(atlas.capped),
    skippedFiles: atlas.skippedFiles ?? 0,
    unresolvedImports: atlas.stats?.imports?.unresolved ?? 0,
    ambiguousRefs,
  };
}
