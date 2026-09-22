// forge scope — deterministic task decomposition. Build a cheap import graph (no LLM), find
// connected components, and tell the developer which touched files are INDEPENDENT (→ run in
// separate sessions, so the context window isn't polluted) vs. COUPLED — and which coupled
// files they didn't mention (the "forgot the related module" guard). Regex imports are
// approximate (dynamic/DI edges missed) — a real call-graph MCP is the upgrade seam.
//
// This module is also the ONE import resolver: atlas.js imports maskCode / jsImports /
// pyImports / resolveSpec / pyModuleIndex from here, so the file graph (scope, rank, the
// repo map) and the symbol graph (atlas, impact) can never disagree on what a specifier
// points at.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, posix, relative, resolve } from "node:path";
import { IGNORE_DIRS, SRC_EXT, toPosix } from "./util.js";

// ---------------------------------------------------------------------------------------
// Lexical masking — comments and string/regex CONTENTS become spaces (same length, newlines
// kept), so every structural regex downstream sees code only: a comment that says
// `class Parser` defines nothing, and `"import x from './y'"` inside a string imports
// nothing. Quote delimiters are kept so an import specifier's position survives; its text
// is read back from the original source at the same offsets.
// ---------------------------------------------------------------------------------------

const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const LANG_BY_EXT = { ".py": "py", ".rb": "rb", ".php": "php", ".go": "go" };
/** Lexer family for a file extension: js | py | rb | php | go | c. */
export const lexOf = (ext) => (JS_EXTS.has(ext) ? "js" : (LANG_BY_EXT[ext] ?? "c"));

// A `/` starts a regex literal (not a division) after these characters or keywords.
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const IDENT_CHAR = /[\w$]/;
// A char literal in C-family languages: 'a', '\n', '\x41', '\u{1F600}'. Anything else
// (Rust lifetimes `'a`, Kotlin/Swift apostrophes in odd places) stays code.
const CHAR_LIT = /'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)|[^\\'\n])'/y;

const blankOf = (s) => s.replace(/[^\n\r]/g, " ");

/**
 * Mask comments and string/regex contents. Output has the same length and line structure
 * as `text`; string delimiters are kept.
 * @param {string} text
 * @param {string} ext file extension (".js", ".py", …)
 * @returns {string}
 */
export function maskCode(text, ext) {
  const lang = lexOf(ext);
  const n = text.length;
  /** @type {string[]} */
  const out = [];
  let seg = 0; // start of the pending verbatim-code run
  let i = 0;
  // JS state: brace depth, template-interpolation stack, last significant token.
  let depth = 0;
  /** @type {number[]} */
  const tpl = [];
  let prev = "";
  let word = "";
  let inWord = false;

  const flush = (to) => {
    if (to > seg) out.push(text.slice(seg, to));
  };
  /** Emit text[a,b) with its inner part blanked, keeping `open`/`close` delimiter chars. */
  const masked = (a, b, open, close) => {
    flush(a);
    const o = Math.min(open, b - a);
    const c = Math.min(close, b - a - o);
    out.push(text.slice(a, a + o) + blankOf(text.slice(a + o, b - c)) + text.slice(b - c, b));
    seg = b;
  };
  const lineEnd = (from) => {
    const e = text.indexOf("\n", from);
    return e < 0 ? n : e;
  };
  // A single-line quoted string: ends at the closing quote or (unterminated) the newline.
  const quoteEnd = (from, q) => {
    let j = from + 1;
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") j += 2;
      else if (ch === q) return j + 1;
      else if (ch === "\n" && lang !== "rb" && lang !== "php") return j;
      else j += 1;
    }
    return n;
  };
  const blockEnd = (from, closer) => {
    const e = text.indexOf(closer, from);
    return e < 0 ? n : e + closer.length;
  };
  // JS template literal chunk starting at `from` (the char after ` or after the } closing
  // a ${…}). Returns where the chunk ends and whether it ended at a ${ interpolation.
  const templateChunk = (from) => {
    let j = from;
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") j += 2;
      else if (ch === "`") return { end: j + 1, interp: false, closed: true };
      else if (ch === "$" && text[j + 1] === "{")
        return { end: j + 2, interp: true, closed: false };
      else j += 1;
    }
    return { end: n, interp: false, closed: false };
  };
  const template = (at, keepOpen) => {
    const r = templateChunk(at + 1);
    flush(at);
    const tail = r.interp ? 2 : r.closed ? 1 : 0;
    out.push(
      (keepOpen ? "`" : " ") +
        blankOf(text.slice(at + 1, r.end - tail)) +
        (r.interp ? "  " : r.closed ? "`" : ""),
    );
    seg = r.end;
    if (r.interp) {
      tpl.push(depth);
      depth += 1;
    }
    prev = "`";
    word = "";
    inWord = false;
    return r.end;
  };
  const regexEnd = (from) => {
    let j = from + 1;
    let inClass = false;
    while (j < n) {
      const ch = text[j];
      if (ch === "\n") return -1;
      if (ch === "\\") j += 2;
      else {
        if (inClass) {
          if (ch === "]") inClass = false;
        } else if (ch === "[") inClass = true;
        else if (ch === "/") return j + 1;
        j += 1;
      }
    }
    return -1;
  };
  const regexAllowed = () => {
    if (!prev) return true;
    if (word) return REGEX_KEYWORDS.has(word);
    if (prev === ")" || prev === "]") return false;
    return prev === "}" || REGEX_AFTER.has(prev);
  };

  while (i < n) {
    const ch = text[i];
    const nx = text[i + 1];
    // ---- comments -----------------------------------------------------------------
    if ((lang === "py" || lang === "rb" || lang === "php") && ch === "#") {
      const e = lineEnd(i);
      masked(i, e, 0, 0);
      i = e;
      continue;
    }
    if (lang !== "py" && lang !== "rb" && ch === "/" && nx === "/") {
      const e = lineEnd(i);
      masked(i, e, 0, 0);
      i = e;
      continue;
    }
    if (lang !== "py" && lang !== "rb" && ch === "/" && nx === "*") {
      const e = blockEnd(i + 2, "*/");
      masked(i, e, 0, 0);
      i = e;
      continue;
    }
    // ---- strings ------------------------------------------------------------------
    if (ch === '"' || ch === "'") {
      if (lang === "py" && text.startsWith(ch.repeat(3), i)) {
        let j = i + 3;
        while (j < n && !text.startsWith(ch.repeat(3), j)) j += text[j] === "\\" ? 2 : 1;
        const e = Math.min(n, j + 3);
        masked(i, e, 3, j < n ? 3 : 0);
        i = e;
        continue;
      }
      if (lang === "c" && ch === '"' && text.startsWith('"""', i)) {
        const e = blockEnd(i + 3, '"""'); // Kotlin/Swift/Java text blocks
        masked(i, e, 3, 3);
        i = e;
        continue;
      }
      if ((lang === "c" || lang === "go") && ch === "'") {
        CHAR_LIT.lastIndex = i;
        const m = CHAR_LIT.exec(text);
        if (!m) {
          i += 1; // a lone apostrophe (Rust lifetime, etc.) is code
          continue;
        }
        masked(i, i + m[0].length, 1, 1);
        i += m[0].length;
        continue;
      }
      const e = quoteEnd(i, ch);
      masked(i, e, 1, text[e - 1] === ch && e - 1 > i ? 1 : 0);
      i = e;
      prev = ch;
      word = "";
      inWord = false;
      continue;
    }
    if (lang === "go" && ch === "`") {
      const e = blockEnd(i + 1, "`");
      masked(i, e, 1, 1);
      i = e;
      continue;
    }
    if (lang !== "js") {
      i += 1;
      continue;
    }
    // ---- JS-only: templates, regex literals, token tracking --------------------------
    if (ch === "`") {
      i = template(i, true);
      continue;
    }
    if (ch === "/" && regexAllowed()) {
      const e = regexEnd(i);
      if (e > 0) {
        masked(i, e, 1, 1);
        i = e;
        prev = "/";
        word = "";
        inWord = false;
        continue;
      }
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      if (tpl.length && tpl[tpl.length - 1] === depth - 1) {
        tpl.pop();
        depth -= 1;
        i = template(i, false);
        continue;
      }
      depth -= 1;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      inWord = false;
    } else if (IDENT_CHAR.test(ch)) {
      word = inWord ? word + ch : ch;
      inWord = true;
      prev = ch;
    } else {
      word = "";
      inWord = false;
      prev = ch;
    }
    i += 1;
  }
  flush(n);
  return out.join("");
}

// ---------------------------------------------------------------------------------------
// Import extraction (run on MASKED code; specifier text read from the original).
// ---------------------------------------------------------------------------------------

/**
 * @typedef {{imported:string, local:string}} ImportName
 * @typedef {{spec:string, index:number, names:ImportName[], form:"static"|"reexport"|"dynamic"|"require"}} JsImport
 * @typedef {{module:string, level:number, names:ImportName[], index:number}} PyImport
 */

// Each pattern ends at the OPENING quote of the specifier (group 1 = the quote char).
const JS_IMPORT_RES = [
  // import x from "y" · import {a, b as c} from "y" · import * as ns from "y" · import "y"
  // · import type {T} from "y" (the clause spans lines; it never contains quotes/parens/;)
  /(?<![\w$.])import\b\s*(?:type\s+)?([\w$*{}\s,]*?\bfrom\s*)?(["'])/g,
  // export * from "y" · export * as ns from "y" · export {a as b} from "y"
  /(?<![\w$.])export\s*(?:type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])/g,
  // import("y") — dynamic, literal specifier only
  /(?<![\w$.])import\s*\(\s*()(["'])/g,
  // require("y") · import x = require("y")
  /(?<![\w$.])require\s*\(\s*()(["'])/g,
];

const JS_IMPORT_FORMS = ["static", "reexport", "dynamic", "require"];

/** Parse the names out of an import/export clause: `a, {b as c, type D}`, `* as ns`. */
function clauseNames(clause, reexport) {
  /** @type {ImportName[]} */
  const names = [];
  if (!clause) return names;
  const body = clause.replace(/\bfrom\s*$/, "");
  const brace = body.match(/\{([^}]*)\}/);
  if (brace) {
    for (const part of brace[1].split(",")) {
      const m = part
        .trim()
        .replace(/^type\s+/, "")
        .match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (m) names.push({ imported: m[1], local: m[2] || m[1] });
    }
  }
  if (!reexport) {
    // default binding: the identifier before any `{` / `*` / `,`
    const def = body.replace(/\{[^}]*\}/, "").match(/^\s*([\w$]+)\s*(?:,|$)/);
    if (def && def[1] !== "type") names.push({ imported: "default", local: def[1] });
  }
  return names;
}

/**
 * Every static/dynamic import, re-export and require with a literal specifier.
 * @param {string} code masked code (maskCode)
 * @param {string} text the original source (specifiers are read from here)
 * @returns {JsImport[]}
 */
export function jsImports(code, text) {
  /** @type {JsImport[]} */
  const found = [];
  const seen = new Set();
  JS_IMPORT_RES.forEach((re, k) => {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (seen.has(open)) continue; // `import x = require("y")` hits two patterns
      const close = code.indexOf(m[2], open + 1);
      const eol = code.indexOf("\n", open + 1);
      if (close < 0 || (eol >= 0 && eol < close)) continue;
      const spec = text.slice(open + 1, close);
      if (!spec) continue;
      seen.add(open);
      found.push({
        spec,
        index: m.index ?? 0,
        names: k <= 1 ? clauseNames(m[1] || "", k === 1) : [],
        form: /** @type {JsImport["form"]} */ (JS_IMPORT_FORMS[k]),
      });
    }
  });
  return found.sort((a, b) => a.index - b.index);
}

const PY_FROM_RE =
  /^[ \t]*from[ \t]+(\.*)[ \t]*([\w.]*)[ \t]+import[ \t]*(\([^)]*\)|(?:[^\n;]|\\\n)*)/gm;
const PY_IMPORT_RE = /^[ \t]*import[ \t]+((?:[^\n;]|\\\n)*)/gm;

const pyNames = (list) =>
  list
    .replace(/[()\\]/g, " ")
    .split(",")
    .map((part) => part.trim().match(/^([\w.]+|\*)(?:\s+as\s+(\w+))?$/))
    .filter((m) => m !== null)
    .map((m) => ({ imported: m[1], local: m[2] || m[1] }));

/**
 * Python `import a.b as c` and `from ..a import (x, y as z)` statements. Parenthesised and
 * backslash-continued lists are read whole; a statement never runs past its own line
 * otherwise (the old regex's `\s` swallowed the next three imports into one "module").
 * @param {string} code masked code (maskCode) — comments/strings already blank
 * @returns {PyImport[]}
 */
export function pyImports(code) {
  /** @type {PyImport[]} */
  const found = [];
  PY_FROM_RE.lastIndex = 0;
  for (const m of code.matchAll(PY_FROM_RE)) {
    const level = m[1].length;
    if (!level && !m[2]) continue;
    found.push({ module: m[2], level, names: pyNames(m[3]), index: m.index ?? 0 });
  }
  PY_IMPORT_RE.lastIndex = 0;
  for (const m of code.matchAll(PY_IMPORT_RE)) {
    // `import a.b as c, d` — each dotted module is its own import
    for (const n of pyNames(m[1]))
      if (n.imported !== "*")
        found.push({ module: n.imported, level: 0, names: [], index: m.index ?? 0 });
  }
  return found.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------------------
// Resolution — specifier → repo-relative file (POSIX), against the set of files on disk.
// ---------------------------------------------------------------------------------------

const JS_RESOLVE_EXTS = [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
// TypeScript NodeNext/Node16: source says `./x.js`, disk has `x.ts` (and friends).
const TS_TWIN = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/**
 * Resolve a relative JS/TS specifier the way Node + TypeScript do: exact file, the
 * NodeNext `.js`→`.ts` twin, extensionless, then `<dir>/index.*`. Bare/package specifiers
 * return null (external — not a local edge).
 * @param {string} fromRel importing file, repo-relative POSIX
 * @param {string} spec
 * @param {Set<string>} fileSet repo-relative POSIX paths
 * @returns {string|null}
 */
export function resolveSpec(fromRel, spec, fileSet) {
  if (!spec.startsWith("./") && !spec.startsWith("../") && spec !== "." && spec !== "..")
    return null;
  const raw = posix.normalize(posix.join(posix.dirname(fromRel), spec.split(/[?#]/)[0]));
  if (raw.startsWith("../") || raw === "..") return null; // escapes the repo
  const base = raw === "." ? "" : raw.replace(/\/$/, "");
  const ext = posix.extname(base);
  const cands = [base];
  for (const twin of TS_TWIN[ext] ?? []) cands.push(base.slice(0, -ext.length) + twin);
  for (const e of JS_RESOLVE_EXTS) cands.push(base + e);
  for (const e of JS_RESOLVE_EXTS) cands.push(base ? `${base}/index${e}` : `index${e}`);
  for (const c of cands) if (c && fileSet.has(c)) return c;
  return null;
}

/**
 * Python module index. A module's CANONICAL name is its dotted path from its package root
 * (the directory above its top-most `__init__.py` package — `src/` in a src layout, the
 * repo root in a flat one), so `src/mypkg/core.py` is `mypkg.core`, exactly what
 * `from mypkg.core import …` spells. Files directly inside a package root are top-level
 * modules. Namespace/script directories have no canonical name and are reachable only
 * through the unique prefix-stripped fallback in resolvePyModule.
 * @param {Iterable<string>} files repo-relative POSIX paths (any extension; .py used)
 */
export function pyModuleIndex(files) {
  const all = [...files];
  const fileSet = new Set(all);
  const py = all.filter((f) => f.endsWith(".py"));
  const isPkg = (dir) => dir !== "." && fileSet.has(`${dir}/__init__.py`);
  const topPkgParent = (dir) => {
    let d = dir;
    while (isPkg(d)) d = posix.dirname(d);
    return d;
  };
  const roots = new Set(["."]);
  for (const f of py) {
    const dir = posix.dirname(f);
    if (isPkg(dir)) roots.add(topPkgParent(dir));
  }
  const dotted = (rel) =>
    rel
      .replace(/\.py$/, "")
      .replace(/(^|\/)__init__$/, "")
      .split("/")
      .filter(Boolean)
      .join(".");
  /** @type {Map<string, string[]>} */
  const canonical = new Map();
  /** @type {Map<string, string[]>} */
  const suffix = new Map();
  /** @type {Map<string, string>} */
  const nameOf = new Map();
  const add = (map, key, f) => {
    if (!key) return;
    const arr = map.get(key);
    if (arr) arr.push(f);
    else map.set(key, [f]);
  };
  for (const f of py) {
    const dir = posix.dirname(f);
    let name = "";
    if (isPkg(dir)) {
      const root = topPkgParent(dir);
      name = dotted(root === "." ? f : f.slice(root.length + 1));
    } else if (roots.has(dir) && !f.endsWith("/__init__.py")) {
      name = dotted(posix.basename(f));
    }
    if (name) {
      add(canonical, name, f);
      nameOf.set(f, name);
    }
    const parts = dotted(f).split(".");
    for (let k = 0; k < parts.length - 1; k++) add(suffix, parts.slice(k).join("."), f);
  }
  return { canonical, suffix, nameOf, fileSet };
}

/**
 * Resolve a dotted Python module name to a file: a unique canonical (package-root) match,
 * else — for dotted names only — a unique prefix-stripped match. Single-segment names
 * never take the fallback: `import json` must not bind to some `tools/json.py`.
 * @param {ReturnType<typeof pyModuleIndex>} index
 * @param {string} name
 * @returns {string|null}
 */
export function resolvePyModule(index, name) {
  const hit = index.canonical.get(name);
  if (hit) return hit.length === 1 ? hit[0] : null;
  if (!name.includes(".")) return null;
  const strip = index.suffix.get(name);
  return strip && strip.length === 1 ? strip[0] : null;
}

/**
 * Resolve one Python import statement to target files. Relative imports walk up from the
 * importing file's package; `from X import Y` prefers submodule X.Y, else module X.
 * @param {string} fromRel
 * @param {PyImport} imp
 * @param {ReturnType<typeof pyModuleIndex>} index
 * @returns {{file:string, names:ImportName[]}[]} one entry per resolved module; `names`
 *   are the imported names to look up INSIDE that module (empty for submodule hits)
 */
export function resolvePyImport(fromRel, imp, index) {
  const { fileSet } = index;
  const fileFor = (path) =>
    fileSet.has(`${path}.py`)
      ? `${path}.py`
      : fileSet.has(`${path}/__init__.py`)
        ? `${path}/__init__.py`
        : null;
  /** @type {{file:string, names:ImportName[]}[]} */
  const out = [];
  if (imp.level > 0) {
    const dir = posix.dirname(fromRel);
    const segs = dir === "." ? [] : dir.split("/");
    if (imp.level - 1 > segs.length) return out; // climbs above the repo root
    const modPath = [
      ...segs.slice(0, segs.length - (imp.level - 1)),
      ...imp.module.split(".").filter(Boolean),
    ].join("/");
    const rest = [];
    for (const n of imp.names) {
      const sub =
        n.imported !== "*" ? fileFor(modPath ? `${modPath}/${n.imported}` : n.imported) : null;
      if (sub) out.push({ file: sub, names: [] });
      else rest.push(n);
    }
    const mod = modPath ? fileFor(modPath) : fileSet.has("__init__.py") ? "__init__.py" : null;
    if (mod && (rest.length || !imp.names.length)) out.push({ file: mod, names: rest });
    return out;
  }
  if (!imp.names.length) {
    const f = resolvePyModule(index, imp.module);
    if (f) out.push({ file: f, names: [] });
    return out;
  }
  const rest = [];
  for (const n of imp.names) {
    const sub = n.imported !== "*" ? resolvePyModule(index, `${imp.module}.${n.imported}`) : null;
    if (sub) out.push({ file: sub, names: [] });
    else rest.push(n);
  }
  if (rest.length) {
    const f = resolvePyModule(index, imp.module);
    if (f) out.push({ file: f, names: rest });
  }
  return out;
}

/**
 * Every local file one source file imports (JS/TS specifiers + Python modules).
 * @param {string} rel repo-relative POSIX path of the importing file
 * @param {string} text its source
 * @param {Set<string>} fileSet
 * @param {ReturnType<typeof pyModuleIndex>} [pyIndex]
 * @returns {Set<string>}
 */
export function localImports(rel, text, fileSet, pyIndex) {
  const ext = extname(rel);
  const code = maskCode(text, ext);
  const targets = new Set();
  if (ext === ".py") {
    const index = pyIndex ?? pyModuleIndex(fileSet);
    for (const imp of pyImports(code))
      for (const r of resolvePyImport(rel, imp, index)) targets.add(r.file);
  } else {
    for (const imp of jsImports(code, text)) {
      const t = resolveSpec(rel, imp.spec, fileSet);
      if (t) targets.add(t);
    }
  }
  targets.delete(rel);
  return targets;
}

// ---------------------------------------------------------------------------------------
// The file graph.
// ---------------------------------------------------------------------------------------

function walk(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, root, out);
    else if (SRC_EXT.test(entry.name)) out.push(toPosix(relative(root, p)));
  }
}

/** Build an UNDIRECTED file→file import graph (coupling is symmetric for decomposition). */
export function importGraph(root) {
  const { nodes, edges } = directedImportGraph(root);
  const undirected = new Map(nodes.map((f) => [f, new Set()]));
  for (const [f, targets] of edges) {
    for (const t of targets) {
      undirected.get(f).add(t);
      undirected.get(t)?.add(f);
    }
  }
  return { nodes, edges: undirected };
}

/** The DIRECTED form (importer → imported) — what cycle detection needs; the
 *  undirected view above is derived from it. Same walk, same resolver. */
export function directedImportGraph(root) {
  const files = [];
  walk(root, root, files);
  const fileSet = new Set(files);
  const pyIndex = pyModuleIndex(files);
  const edges = new Map(files.map((f) => [f, new Set()]));
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    edges.set(f, localImports(f, text, fileSet, pyIndex));
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
