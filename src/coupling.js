// forge coupling — diff-driven coupling hazards the import graph cannot see (issue #206).
// The atlas answers "who depends on this file". Two failure classes slip past it because the
// coupling is semantic, not an import edge:
//   1. SET QUANTIFIERS. A diff adds a member to a named set — an allowlist, a registry, a key
//      map. Code in the same package quantifies over that set ("every allowed key must be
//      present", `len(keys) == 3`, a switch that enumerates its members) and silently changes
//      meaning: an OPTIONAL key added to a require-all set breaks every input without it. The
//      edit and the invariant usually sit in different functions, often behind a parameter
//      (`strictObject(raw, allowedKeys)`), so neither the diff nor the graph names the
//      invariant.
//   2. LIVE READERS. A diff adds a file read whose path another file in the repo writes —
//      typically a sibling binary (`cmd/<x>`). A process that loads the file once never sees
//      those writes until it restarts: restart-to-pick-up-config is a silent operational
//      failure that unit tests do not catch.
// Both checks are regex heuristics over Go, JS/TS and Python source. They name places to
// look, never block, and fail open (any error → no hazard).
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  isStale as atlasIsStale,
  build as buildAtlas,
  byRelation,
  CODE_EXTS,
  fileRelations,
  impact,
  load as loadAtlas,
} from "./atlas.js";
import { isTestFile } from "./substrate.js";
import { git } from "./util.js";

/**
 * @typedef {{file: string, line: number, why: string, text: string, priority: "high"|"medium"}} CoupledSite
 * @typedef {{
 *   kind: "set-quantifier" | "live-reader",
 *   priority: "high" | "medium",
 *   file: string,
 *   line: number,
 *   subject: string,
 *   added?: string[],
 *   coupled: CoupledSite[],
 *   message: string,
 * }} CouplingHazard
 * @typedef {Map<string, {added: {line: number, text: string}[], removed: string[]}>} DiffChanges
 */

const LANG_BY_EXT = /** @type {Record<string, "go"|"js"|"py">} */ ({
  ".go": "go",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".ts": "js",
  ".tsx": "js",
  ".py": "py",
});
/** @param {string} rel */
const langOf = (rel) => LANG_BY_EXT[extname(rel).toLowerCase()];

const MAX_FILE_BYTES = 512 * 1024;
const MAX_PACKAGE_FILES = 200;
const MAX_HAZARDS = 20;

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/**
 * Parse a `--unified=0` diff into per-file added lines (with their NEW line numbers) and
 * removed line texts.
 * @param {string} diff
 * @returns {DiffChanges}
 */
export function parseDiff(diff) {
  /** @type {DiffChanges} */
  const out = new Map();
  let current = null;
  let next = 0;
  // `+++`/`---` are headers only between `diff --git` and the first hunk: inside a hunk,
  // `--- x` is a removed `-- x` (an SQL comment) and `+++ x` an added `++ x`.
  let header = true;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      current = null;
      continue;
    }
    const file = header && /^\+\+\+ (?:b\/)?(.*)$/.exec(line);
    if (file) {
      current = file[1] === "/dev/null" ? null : file[1];
      if (current && !out.has(current)) out.set(current, { added: [], removed: [] });
      continue;
    }
    if (header && line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      header = false;
      next = Number(hunk[1]);
      continue;
    }
    if (!current || header) continue;
    const entry = out.get(current);
    if (line.startsWith("+")) entry.added.push({ line: next++, text: line.slice(1) });
    else if (line.startsWith("-")) entry.removed.push(line.slice(1));
    else if (line.startsWith(" ")) next++;
  }
  return out;
}

/**
 * The change set: `git diff <base|HEAD>` plus untracked files (all lines added), or the
 * index with `staged`. `files` narrows it to those paths.
 * @param {string} root
 * @param {{base?: string, staged?: boolean, files?: string[]}} [opts]
 * @returns {DiffChanges}
 */
export function diffChanges(root, { base, staged = false, files } = {}) {
  const args = ["-c", "core.quotepath=off", "diff", "--unified=0", "--no-color", "--no-ext-diff"];
  const changes = parseDiff(git(root, staged ? [...args, "--cached"] : [...args, base || "HEAD"]));
  if (!staged) {
    const untracked = git(root, [
      "-c",
      "core.quotepath=off",
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    for (const rel of untracked.split("\n").filter(Boolean)) {
      if (changes.has(rel) || !langOf(rel)) continue;
      const text = readText(root, rel);
      if (text == null) continue;
      changes.set(rel, {
        added: text.split("\n").map((t, i) => ({ line: i + 1, text: t })),
        removed: [],
      });
    }
  }
  if (files) {
    const keep = new Set(files.map((f) => f.replace(/\\/g, "/")));
    for (const rel of [...changes.keys()]) if (!keep.has(rel)) changes.delete(rel);
  }
  return changes;
}

/** @param {string} root @param {string} rel @param {boolean} [staged] @returns {string|null} */
function readText(root, rel, staged = false) {
  try {
    if (staged) return git(root, ["show", `:${rel}`]);
    const text = readFileSync(join(root, rel), "utf8");
    return text.length > MAX_FILE_BYTES ? null : text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bracket scanning (strings blanked so a "{" inside a literal is not structure)
// ---------------------------------------------------------------------------

/** @param {string} line */
const blankStrings = (line) =>
  line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) =>
    '""'.padEnd(m.length, " "),
  );

/** @param {string} line @param {"go"|"js"|"py"} lang */
const stripComment = (line, lang) => {
  const s = blankStrings(line);
  const at = lang === "py" ? s.indexOf("#") : s.indexOf("//");
  return at >= 0 ? s.slice(0, at) : s;
};

/**
 * The innermost unclosed bracket ABOVE line `idx` (0-based): {line, col} or null.
 * @param {string[]} lines @param {number} idx @param {"go"|"js"|"py"} lang
 */
function enclosingOpener(lines, idx, lang) {
  let depth = 0;
  for (let i = idx - 1; i >= 0 && i >= idx - 400; i--) {
    const s = stripComment(lines[i], lang);
    for (let c = s.length - 1; c >= 0; c--) {
      const ch = s[c];
      if (ch === ")" || ch === "]" || ch === "}") depth++;
      else if (ch === "(" || ch === "[" || ch === "{") {
        if (depth === 0) return { line: i, col: c };
        depth--;
      }
    }
  }
  return null;
}

/**
 * The line (0-based) holding the bracket that closes the opener at {line, col}.
 * @param {string[]} lines @param {{line: number, col: number}} at @param {"go"|"js"|"py"} lang
 */
function closingLine(lines, at, lang) {
  let depth = 0;
  for (let i = at.line; i < lines.length && i < at.line + 2000; i++) {
    const s = stripComment(lines[i], lang);
    for (let c = i === at.line ? at.col : 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return Math.min(lines.length - 1, at.line + 2000);
}

// ---------------------------------------------------------------------------
// 1. Set quantifiers
// ---------------------------------------------------------------------------

// One set member per line: `"plan",` · `"plan": true,` · `'plan': True,` · `"plan": {},` ·
// a registry entry `"plan": handlePlan,` · JS `plan: true,`. A key holding a string, a
// number or a nested literal (`usage: "…"`, `"port": 8080`) is a record property, not a
// member — records are not sets, and reading them as sets is where the noise was.
const SET_VALUE = String.raw`(?:true|false|True|False|null|None|nil|1|\{\s*\}|struct\{\}\{\}|\[\s*\])`;
const QUOTED_ENTRY = new RegExp(
  String.raw`^\s*(["'\x60])([^"'\x60\\\s]{1,80})\1\s*(?:,\s*$|$|[)\]}]|:\s*(?:${SET_VALUE}|[A-Za-z_$][\w$.]*)\s*,?\s*$)`,
);
const BARE_ENTRY = new RegExp(String.raw`^\s*([A-Za-z_$][\w$]*)\s*:\s*${SET_VALUE}\s*,?\s*$`);
// Any quoted key, whatever its value — what a PARALLEL enumeration (a label map, a handler
// table) looks like.
const LISTED_KEY = /^\s*(["'`])([^"'`\\\s]{1,80})\1\s*(?:[:,)\]}]|$)/;
// The VARIABLE a collection literal is assigned to, read from the text before its opener.
// Object properties and struct fields (`claim: {`) are not bindings: nothing references
// them by bare name, so a name match elsewhere would be a different variable.
const BINDINGS = [
  /(?:^|[\s;])(?:export\s+)?(?:var|const|let)\s+([A-Za-z_$][\w$]*)\b[^=]*?(?::=|=)\s*[\w.[\]*]*\s*$/,
  /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?(?::=|=)\s*[\w.[\]*]*\s*$/,
];
const WRAPPER = /\b(?:new\s+(?:Set|Map)|Object\.freeze|frozenset|set|tuple|dict)\s*\(?\s*$/;

/** A quoted key on its own line (any value), or null. @param {string} text */
const quotedMember = (text) => LISTED_KEY.exec(text)?.[2] ?? null;

/** @param {string} text */
function entryMember(text) {
  const q = QUOTED_ENTRY.exec(text);
  if (q) return q[2];
  const b = BARE_ENTRY.exec(text);
  return b ? b[1] : null;
}

/** @param {string} before */
function bindingName(before) {
  let s = before;
  for (let i = 0; i < 3 && WRAPPER.test(s); i++) s = s.replace(WRAPPER, "");
  for (const re of BINDINGS) {
    const m = re.exec(s);
    if (m && !/^(if|for|while|switch|return|case|func|function|def|match)$/.test(m[1])) return m[1];
  }
  return null;
}

/** The quoted members of a one-line literal: `{"user": true, "plan": true}` → user, plan.
 *  @param {string} s */
const inlineMembers = (s) =>
  [...s.matchAll(/(["'`])([^"'`\\\s]{1,80})\1\s*(?=[:,|)\]}])/g)].map((m) => m[2]);

/**
 * @typedef {{name: string, members: string[], added: string[], line: number,
 *   range: [number, number], top: boolean}} GrownSet
 */

/** Is line `i` a top-level binding — visible to the rest of the file and (Go) package? A Go
 *  `var ( … )` block counts. @param {string[]} lines @param {number} i @param {"go"|"js"|"py"} lang */
function isTopLevel(lines, i, lang) {
  if (!/^\s/.test(lines[i])) return true;
  if (lang !== "go") return false;
  for (let j = i - 1; j >= 0; j--) {
    if (/^var\s*\(\s*$/.test(lines[j])) return true;
    if (/^\S/.test(lines[j])) return false;
  }
  return false;
}

/** Does `text` import the module whose file stem is `stem`? (`from "./keys.js"`,
 *  `require("./keys")`, Python `from .keys import …` / `import keys`)
 *  @param {string} text @param {string} stem @param {"go"|"js"|"py"} lang */
function importsModule(text, stem, lang) {
  const S = esc(stem);
  if (lang === "py")
    return new RegExp(
      String.raw`^\s*(?:from\s+[.\w]*\b${S}\s+import\b|import\s+[.\w]*\b${S}\b)`,
      "m",
    ).test(text);
  return new RegExp(
    String.raw`(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)["'][^"']*\b${S}(?:\.[cm]?[jt]sx?)?["']`,
  ).test(text);
}

/** @param {string} rel */
const stemOf = (rel) => (rel.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

/**
 * The named sets a file's added lines grew: [{name, members, added, line, range, top}].
 * @param {string[]} lines @param {{line: number, text: string}[]} added @param {string[]} removed
 * @param {"go"|"js"|"py"} lang
 */
export function grownSets(lines, added, removed, lang) {
  /** @param {number} i */
  const top = (i) => isTopLevel(lines, i, lang);
  /** @type {Map<string, GrownSet>} */
  const sets = new Map();
  const removedText = removed.join("\n");
  for (const a of added) {
    const idx = a.line - 1;
    if (idx < 0 || idx >= lines.length) continue;
    // A whole one-line literal rewritten: `var keys = map[string]bool{"user": true, "plan": true}`.
    const one = /^(.*?)([[{(])(.*)[\]})]\s*[,;]?\s*$/.exec(stripComment(lines[idx], lang));
    if (one && bindingName(one[1])) {
      const name = bindingName(one[1]);
      const members = inlineMembers(lines[idx]);
      const grown = members.filter((m) => !new RegExp(`["'\`]${esc(m)}["'\`]`).test(removedText));
      if (members.length >= 2 && grown.length && grown.length < members.length) {
        sets.set(`${name}@${idx}`, {
          name,
          members,
          added: grown,
          line: a.line,
          range: [idx, idx],
          top: top(idx),
        });
      }
      continue;
    }
    const member = entryMember(a.text);
    if (!member) continue;
    const open = enclosingOpener(lines, idx, lang);
    if (!open) continue;
    const name = bindingName(stripComment(lines[open.line], lang).slice(0, open.col));
    if (!name) continue;
    const key = `${name}@${open.line}`;
    if (!sets.has(key)) {
      const end = closingLine(lines, open, lang);
      const members = [];
      for (let i = open.line + 1; i < end; i++) {
        const m = entryMember(lines[i]);
        if (m) members.push(m);
      }
      sets.set(key, {
        name,
        members,
        added: [],
        line: a.line,
        range: [open.line, end],
        top: top(open.line),
      });
    }
    const set = sets.get(key);
    if (!set.added.includes(member)) set.added.push(member);
  }
  // A set that is ALL new (a fresh literal) has no prior meaning to break.
  return [...sets.values()].filter((s) => s.added.length && s.members.length > s.added.length);
}

const PRESENCE =
  /!ok\b|\bnot\s+in\b|!\s*\(?\s*[\w.]+\s+in\b|!\s*[\w.]+\.(?:has|hasOwn|hasOwnProperty|includes)\(|!\s*Object\.hasOwn\(|===?\s*undefined|==\s*nil\b|\bis\s+None\b|\bmissing\b|\brequired\b/i;
const FAILURE =
  /\breturn\b[^\n]*\b(?:err|errors?\.|fmt\.Errorf|false|False|null|None)\b|\bErrorf\(|errors\.New\(|\bpanic\(|\bthrow\b|\braise\b/;

/**
 * Lines of `body` that quantify over identifier `x`: require-all loops and size checks.
 * @param {string[]} body @param {number} offset 0-based line of body[0] in its file
 * @param {string} x
 * @returns {{line: number, why: string}[]}
 */
export function quantifiersOver(body, offset, x) {
  const X = esc(x);
  const iter = new RegExp(
    [
      `\\brange\\s+${X}\\b`,
      `\\bfor\\s*\\(\\s*(?:const|let|var)\\s+[^)]*?\\b(?:of|in)\\s+(?:Object\\.(?:keys|entries)\\(\\s*)?${X}\\b`,
      `\\b${X}\\.forEach\\(`,
      `\\bObject\\.(?:keys|entries)\\(\\s*${X}\\s*\\)\\.forEach\\(`,
      `\\bfor\\s+[\\w\\s,()]+?\\s+in\\s+${X}\\b`,
    ].join("|"),
  );
  const every = new RegExp(
    [
      `\\b${X}\\.every\\(`,
      `\\bObject\\.(?:keys|entries)\\(\\s*${X}\\s*\\)\\.every\\(`,
      `\\[\\s*\\.\\.\\.\\s*${X}\\s*\\]\\.every\\(`,
      `\\bArray\\.from\\(\\s*${X}\\s*\\)\\.every\\(`,
      `\\ball\\s*\\(.*\\bin\\s+${X}\\b`,
    ].join("|"),
  );
  const size = new RegExp(
    [
      `\\blen\\(\\s*${X}\\s*\\)\\s*(?:[!=]=|[<>]=?)`,
      `(?:[!=]=|[<>]=?)\\s*len\\(\\s*${X}\\s*\\)`,
      `\\b${X}\\.(?:length|size)\\s*(?:[!=]==?|[<>]=?)`,
      `(?:[!=]==?|[<>]=?)\\s*${X}\\.(?:length|size)\\b`,
      `\\bObject\\.keys\\(\\s*${X}\\s*\\)\\.length\\s*(?:[!=]==?|[<>]=?)`,
    ].join("|"),
  );
  /** @type {{line: number, why: string}[]} */
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (every.test(s)) {
      out.push({ line: offset + i + 1, why: `require-all: every member of \`${x}\` must hold` });
    } else if (iter.test(s)) {
      const window = body.slice(i, i + 7).join("\n");
      if (PRESENCE.test(window) && FAILURE.test(window))
        out.push({
          line: offset + i + 1,
          why: `require-all: fails unless every member of \`${x}\` is present — a new OPTIONAL member breaks every input without it`,
        });
    } else if (size.test(s) && !/\bfor\b/.test(s)) {
      out.push({
        line: offset + i + 1,
        why: `cardinality: compares the size of \`${x}\` — the count moves with the new member`,
      });
    }
  }
  return out;
}

/** The column of the `{` a definition line leaves open — the body, not a
 *  `map[string]struct{}` parameter type. -1 for a one-line body or none.
 *  @param {string} s @param {number} from */
function bodyBrace(s, from) {
  const open = [];
  for (let c = from; c < s.length; c++) {
    if (s[c] === "{") open.push(c);
    else if (s[c] === "}") open.pop();
  }
  return open.length ? open[0] : -1;
}

/** Function definitions named `fn`: their parameter list and body range (0-based lines).
 *  @param {string[]} lines @param {string} fn @param {"go"|"js"|"py"} lang */
function definitionsOf(lines, fn, lang) {
  const F = esc(fn);
  const def =
    lang === "go"
      ? new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${F}\\s*\\(([^)]*)\\)`)
      : lang === "py"
        ? new RegExp(`^\\s*(?:async\\s+)?def\\s+${F}\\s*\\(([^)]*)\\)`)
        : new RegExp(
            `\\bfunction\\s*\\*?\\s*${F}\\s*\\(([^)]*)\\)|\\b(?:const|let|var)\\s+${F}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(([^)]*)\\)|^\\s*(?:(?:async|static|public|private)\\s+)*${F}\\s*\\(([^)]*)\\)\\s*\\{`,
          );
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = def.exec(lines[i]);
    if (!m) continue;
    let params = (m[1] ?? m[2] ?? m[3] ?? "").split(",").map((p) => p.trim());
    if (lang === "py" && /^(self|cls)\b/.test(params[0] ?? "")) params = params.slice(1);
    let end;
    if (lang === "py") {
      const indent = /^\s*/.exec(lines[i])[0].length;
      end = i + 1;
      while (
        end < lines.length &&
        (!lines[end].trim() || /^\s*/.exec(lines[end])[0].length > indent)
      )
        end++;
    } else {
      const brace = bodyBrace(stripComment(lines[i], lang), m.index);
      end = brace >= 0 ? closingLine(lines, { line: i, col: brace }, lang) + 1 : i + 1;
    }
    out.push({ line: i, params, end: Math.min(end, i + 300) });
  }
  return out;
}

/** The identifier a parameter declaration binds: `allowed map[string]bool` → allowed,
 *  `keys: string[] = []` → keys, `*names` → names. Destructuring → null.
 *  @param {string} p */
const paramName = (p) =>
  /^[{[]/.test(p) ? null : (/^[*.]*([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? null);

/** @param {string} rel */
const isCodeSource = (rel) => Boolean(langOf(rel)) && !isTestFile(rel);

/** The package: code files in the changed file's own directory, the file itself first.
 *  @param {string} root @param {string} rel @param {boolean} staged */
function packageFiles(root, rel, staged) {
  const dir = dirname(rel);
  const lang = langOf(rel);
  const listed = git(root, [
    "-c",
    "core.quotepath=off",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    dir === "." ? "." : dir,
  ]);
  const files = listed
    .split("\n")
    .filter((f) => f && dirname(f) === dir && f !== rel && langOf(f) === lang && isCodeSource(f))
    .slice(0, MAX_PACKAGE_FILES);
  return [rel, ...files].map((f) => ({
    rel: f,
    lines: (readText(root, f, staged) ?? "").split("\n"),
  }));
}

/**
 * Where the package enumerates a set's OLD members but not the new one: a switch whose
 * cases name ≥2 of them (exhaustiveness), or another literal listing ≥ half of them.
 * @param {{rel: string, lines: string[]}[]} pkg
 * @param {GrownSet} set
 * @param {string} self the file the set lives in
 * @returns {CoupledSite[]}
 */
function enumerationsOf(pkg, set, self) {
  const old = new Set(set.members.filter((m) => !set.added.includes(m)));
  if (old.size < 2) return [];
  /** @type {CoupledSite[]} */
  const out = [];
  for (const { rel, lines } of pkg) {
    /** @type {Map<number, {kind: string, names: Set<string>}>} */
    const groups = new Map();
    for (let i = 0; i < lines.length; i++) {
      if (rel === self && i >= set.range[0] && i <= set.range[1]) continue;
      const caseLine = /^\s*case\s+(.+?):?\s*$/.exec(lines[i]);
      let key = null;
      let kind = "list";
      if (caseLine) {
        kind = "switch";
        for (let j = i; j >= 0 && j >= i - 400; j--)
          if (/\b(switch|match)\b/.test(lines[j])) {
            key = j;
            break;
          }
      } else if (quotedMember(lines[i])) {
        // a run of one-member lines is one literal; key it by the run's first line. Quoted
        // members only: bare `name: value` lines are mostly struct/object fields, and two
        // literals of one type rarely set the same fields.
        key = i;
        while (key > 0 && (quotedMember(lines[key - 1]) || !lines[key - 1].trim())) key--;
      }
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, { kind, names: new Set() });
      const names = caseLine ? inlineMembers(`${caseLine[1]},`) : [quotedMember(lines[i])];
      for (const n of names) if (n) groups.get(key).names.add(n);
    }
    for (const [at, g] of groups) {
      const shared = [...old].filter((m) => g.names.has(m)).length;
      const hasNew = set.added.some((m) => g.names.has(m));
      if (hasNew) continue;
      if (g.kind === "switch" ? shared >= 2 : shared >= Math.max(2, Math.ceil(old.size / 2)))
        out.push({
          file: rel,
          line: at + 1,
          text: lines[at].trim().slice(0, 120),
          priority: g.kind === "switch" ? "high" : "medium",
          why:
            g.kind === "switch"
              ? `exhaustiveness: a switch names ${shared} of \`${set.name}\`'s members but not ${set.added.map((m) => `"${m}"`).join(", ")}`
              : `parallel list: enumerates ${shared} of \`${set.name}\`'s members but not ${set.added.map((m) => `"${m}"`).join(", ")}`,
        });
    }
  }
  return out;
}

/**
 * Set-quantifier hazards for a change set.
 * @param {string} root @param {DiffChanges} changes @param {{staged?: boolean}} [opts]
 * @returns {CouplingHazard[]}
 */
export function setQuantifierHazards(root, changes, { staged = false } = {}) {
  /** @type {CouplingHazard[]} */
  const hazards = [];
  for (const [rel, change] of changes) {
    const lang = langOf(rel);
    if (!lang || !isCodeSource(rel) || !change.added.length) continue;
    const text = readText(root, rel, staged);
    if (text == null) continue;
    const lines = text.split("\n");
    const sets = grownSets(lines, change.added, change.removed, lang);
    if (!sets.length) continue;
    const pkg = packageFiles(root, rel, staged);
    const addedLines = new Set(change.added.map((a) => a.line));
    for (const set of sets) {
      /** @type {CoupledSite[]} */
      const sites = [];
      const seen = new Set();
      /** @param {string} file @param {number} line @param {string} why @param {"high"|"medium"} priority */
      const push = (file, line, why, priority = "high") => {
        if (file === rel && addedLines.has(line)) return; // already part of this diff
        if (file === rel && line - 1 >= set.range[0] && line - 1 <= set.range[1]) return;
        const k = `${file}:${line}`;
        if (seen.has(k)) return;
        seen.add(k);
        const src = pkg.find((p) => p.rel === file)?.lines[line - 1] ?? "";
        sites.push({ file, line, why, text: src.trim().slice(0, 120), priority });
      };
      const N = new RegExp(`\\b${esc(set.name)}\\b`);
      const texts = new Map(pkg.map((p) => [p.rel, p.lines.join("\n")]));
      // The set's name means the set only where it is in scope: its own file, or — for a
      // top-level binding — the rest of a Go package, or a JS/Python module importing it.
      const visible = pkg.filter(
        (p) =>
          p.rel === rel ||
          (set.top && (lang === "go" || importsModule(texts.get(p.rel), stemOf(rel), lang))),
      );
      for (const { rel: file, lines: fl } of visible) {
        // (a) direct: the set itself is iterated or measured
        for (const q of quantifiersOver(fl, 0, set.name)) push(file, q.line, q.why);
        // (b) through a parameter: `strictObject(raw, allowedKeys)` → strictObject's body
        for (let i = 0; i < fl.length; i++) {
          if (!N.test(fl[i])) continue;
          for (const call of fl[i].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
            const args = call[2].split(",").map((a) => a.trim());
            const argIdx = args.findIndex((a) => a === set.name || a.endsWith(`.${set.name}`));
            if (argIdx < 0) continue;
            // Where `fn` can be defined: Go — anywhere in the package; JS/Python — the
            // calling file, or a module it imports (a method call stays in its own file).
            const method = fl[i][(call.index ?? 0) - 1] === ".";
            const defs = pkg.filter(
              (p) =>
                p.rel === file ||
                lang === "go" ||
                (!method && importsModule(texts.get(file), stemOf(p.rel), lang)),
            );
            for (const def of defs) {
              for (const d of definitionsOf(def.lines, call[1], lang)) {
                const param = paramName(d.params[argIdx] ?? "");
                if (!param) continue;
                const body = def.lines.slice(d.line, d.end);
                const via = `\`${param}\` (= \`${set.name}\`, passed at ${file}:${i + 1})`;
                for (const q of quantifiersOver(body, d.line, param))
                  push(def.rel, q.line, q.why.replace(`\`${param}\``, via));
              }
            }
          }
        }
      }
      for (const e of enumerationsOf(pkg, set, rel)) push(e.file, e.line, e.why, e.priority);
      if (!sites.length) continue;
      sites.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1));
      const added = set.added.map((m) => `"${m}"`).join(", ");
      hazards.push({
        kind: "set-quantifier",
        priority: sites.some((s) => s.priority === "high") ? "high" : "medium",
        file: rel,
        line: set.line,
        subject: set.name,
        added: set.added,
        coupled: sites,
        message: `\`${set.name}\` gained ${added} — ${sites.length} site(s) in this package quantify over it; is each still right when ${added} is optional or absent?`,
      });
    }
  }
  return hazards;
}

// ---------------------------------------------------------------------------
// 2. Live readers
// ---------------------------------------------------------------------------

const READ_CALL =
  /\b(?:os|ioutil)\.(?:ReadFile|Open)\s*\(|\breadFile(?:Sync)?\s*\(|\bopen\s*\(|\.read_(?:text|bytes)\s*\(|\bjson\.load\s*\(/g;
// READ_CALL is global (for matchAll); `.test()` needs a stateless twin.
const READS = new RegExp(READ_CALL.source);
const WRITE_CALL =
  /\b(?:os|ioutil)\.(?:WriteFile|Create|Rename)\s*\(|\bos\.OpenFile\s*\([^)]*O_(?:WRONLY|RDWR|CREATE|APPEND|TRUNC)|\b(?:write|append)File(?:Sync)?\s*\(|\brename(?:Sync)?\s*\(|\bcreateWriteStream\s*\(|\bopen\s*\([^)]*["'][rwax]*[wax+][rwax]*b?["']|\.write_(?:text|bytes)\s*\(|\bjson\.dump\s*\(|\bos\.(?:replace|rename)\s*\(|\bshutil\.(?:move|copy\w*)\s*\(/;
const RELOAD =
  /fsnotify|\bfs\.watch\b|\bwatchFile\s*\(|\bwatch\s*\(|chokidar|inotify|SIGHUP|\bModTime\s*\(|mtimeMs|\.mtime\b|st_mtime|getmtime|\b[Rr]eload\w*\s*\(|watchdog/;
const DATA_FILE =
  /\.(json|jsonl|ndjson|ya?ml|toml|db|sqlite3?|txt|conf|cfg|ini|csv|state|dat|env)$/i;

/** The argument text of the call whose `(` is at `at` (may spill onto the next lines).
 *  @param {string[]} lines @param {number} idx @param {number} at */
function callArgs(lines, idx, at) {
  let depth = 0;
  let out = "";
  for (let i = idx; i < lines.length && i <= idx + 3; i++) {
    const s = lines[i];
    for (let c = i === idx ? at : 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return out;
      if (depth > 0 && !(i === idx && c === at)) out += ch;
    }
    out += " ";
  }
  return out;
}

/** Path keys for a read: data-file literals (by basename) in `text`, and in whatever an
 *  identifier in `text` is bound to in `lines` (`path := filepath.Join(dir, "tokens.json")`).
 *  A qualified exported constant (`config.TokenFile`) also counts by its name.
 *  @param {string} text @param {string[]} lines */
function pathKeys(text, lines) {
  const keys = new Set();
  /** @param {string} s */
  const addLits = (s) => {
    for (const m of s.matchAll(/(["'`])([^"'`]+)\1/g)) {
      const base = m[2].split(/[\\/]/).pop() ?? "";
      if (DATA_FILE.test(base) && base.length >= 4) keys.add(base);
    }
  };
  addLits(text);
  for (const m of text.replace(/(["'`])[^"'`]*\1/g, "").matchAll(/[A-Za-z_$][\w$.]*/g)) {
    const id = m[0].split(".").pop() ?? "";
    if (
      !id ||
      /^(Join|join|resolve|open|Open|ReadFile|readFile|readFileSync|Path|encoding|err|nil|null|undefined|true|false|None)$/.test(
        id,
      )
    )
      continue;
    const bound = new RegExp(`\\b${esc(id)}\\b\\s*(?::\\s*[\\w.]+\\s*)?(?::=|=)(?!=)(.*)$`);
    for (const l of lines) {
      const b = bound.exec(l);
      if (b) addLits(b[1]);
    }
    // A qualified exported constant (`config.TokenFile`) names one path everywhere it is
    // used; a bare name (`LEGACY`) is just as likely an unrelated local in another module.
    if (/^[a-z]\w*\.[A-Z]\w{3,}$/.test(m[0])) keys.add(m[0]);
  }
  return [...keys];
}

const ENCLOSING = {
  go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  py: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  js: /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()|^\s*(?:(?:async|static|public|private)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
};

/** When the path arrives as a parameter (`func Load(path string)`), the data-file literals
 *  the enclosing function's CALLERS pass it: `store.Load(filepath.Join(dir, "tokens.json"))`.
 *  A caller counts only when it can reach THIS function: the same directory, a Go call
 *  qualified by this package's name, or a JS/Python module importing this one.
 *  @param {string} root @param {string} rel @param {string[]} lines @param {number} idx
 *  @param {"go"|"js"|"py"} lang @param {boolean} staged */
function callerPathKeys(root, rel, lines, idx, lang, staged) {
  let name = null;
  for (let i = idx; i >= 0 && i >= idx - 200 && !name; i--) {
    const m = ENCLOSING[lang].exec(lines[i]);
    if (m) name = m[1] ?? m[2] ?? m[3] ?? null;
  }
  if (!name || /^(if|for|while|switch|catch|function)$/.test(name)) return [];
  // A whole-word FIXED-string grep, refined to a call in JS: `\\b` and `\\s` are GNU regex
  // extensions, and macOS git's POSIX ERE matches nothing with them.
  const call = new RegExp(`\\b${esc(name)}\\s*\\(`);
  const hits = git(root, [
    "-c",
    "core.quotepath=off",
    "grep",
    "-n",
    "-I",
    "-w",
    "-F",
    ...(staged ? ["--cached"] : ["--untracked"]),
    "-e",
    name,
  ]);
  const pkgName = lang === "go" ? /^package\s+(\w+)/m.exec(lines.join("\n"))?.[1] : null;
  const qualified = pkgName ? new RegExp(`\\b${esc(pkgName)}\\.${esc(name)}\\s*\\(`) : null;
  const keys = new Set();
  for (const hit of hits
    .split("\n")
    .filter((h) => call.test(h))
    .slice(0, 100)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(hit);
    if (!m || m[1] === rel || !isCodeSource(m[1]) || !call.test(m[3])) continue;
    const def = ENCLOSING[lang].exec(m[3]);
    if (def && (def[1] ?? def[2] ?? def[3]) === name) continue; // the definition itself
    const fl = (readText(root, m[1], staged) ?? "").split("\n");
    const reaches =
      dirname(m[1]) === dirname(rel) ||
      (qualified ? qualified.test(m[3]) : importsModule(fl.join("\n"), stemOf(rel), lang));
    if (!reaches) continue;
    for (const k of pathKeys(m[3], fl)) keys.add(k);
  }
  return [...keys];
}

/** The binary a file belongs to: `cmd/<name>`, `bin/<file>`, a Go `package main` dir, a
 *  shebang script or a Python `__main__` module; null for library code.
 *  @param {string} rel @param {string} text */
export function entryPoint(rel, text) {
  const m = /(?:^|\/)(cmd|bin)\/([^/]+)/.exec(rel);
  if (m) return `${rel.slice(0, m.index + m[0].length).replace(/^\//, "")}`;
  const lang = langOf(rel);
  if (lang === "go" && /^package\s+main\b/m.test(text) && /^func\s+main\s*\(/m.test(text))
    return dirname(rel);
  if (/^#!/.test(text)) return rel;
  if (lang === "py" && /^if\s+__name__\s*==\s*["']__main__["']/m.test(text)) return rel;
  return null;
}

const CTOR_NAME =
  /^(?:[Nn]ew|[Ll]oad|[Oo]pen|[Ii]nit|[Mm]ust|[Ss]etup|[Bb]ootstrap|__init__|constructor)/;

/** Is the read at `idx` a STORE — its result kept in long-lived state — rather than a
 *  per-call read? Kept: a module-level read (`const TOKENS = JSON.parse(readFileSync(…))`),
 *  a constructor-shaped function (`New*`, `Load*`, `init`, `__init__`, `constructor`), a
 *  struct returned (`return &Store{…}`) or a field set (`s.data = …`, `this.x = …`,
 *  `self.x = …`). A read that writes the file back a few lines later is read-modify-write,
 *  the opposite of a stale cache.
 *  @param {string[]} lines @param {number} idx @param {"go"|"js"|"py"} lang */
function retainsRead(lines, idx, lang) {
  const after = lines.slice(idx, idx + 30);
  if (after.slice(1).some((l) => WRITE_CALL.test(l))) return false;
  if (lang !== "go" && !/^\s/.test(lines[idx])) return true;
  let fn = null;
  for (let i = idx; i >= 0 && i >= idx - 200 && !fn; i--) {
    const m = ENCLOSING[lang].exec(lines[i]);
    if (m) fn = m[1] ?? m[2] ?? m[3] ?? null;
  }
  if (fn && CTOR_NAME.test(fn)) return true;
  return after
    .slice(0, 15)
    .some((l) =>
      /\breturn\s+&?[A-Z]\w*\s*\{|^\s*(?:this|self|[a-z]\w{0,5})\.[A-Za-z_]\w*\s*=(?!=)/.test(l),
    );
}

/**
 * Live-reader hazards: an added STORE read (kept in memory, see retainsRead) of a path that
 * another binary or package writes, in a file with no reload path.
 * @param {string} root @param {DiffChanges} changes @param {{staged?: boolean}} [opts]
 * @returns {CouplingHazard[]}
 */
export function liveReaderHazards(root, changes, { staged = false } = {}) {
  /** @type {CouplingHazard[]} */
  const hazards = [];
  for (const [rel, change] of changes) {
    const lang = langOf(rel);
    if (!lang || !isCodeSource(rel) || !change.added.length) continue;
    const text = readText(root, rel, staged);
    if (text == null || RELOAD.test(text)) continue; // a reload path exists — they thought of it
    const lines = text.split("\n");
    const readerEntry = entryPoint(rel, text);
    const done = new Set();
    for (const a of change.added) {
      const idx = a.line - 1;
      if (idx < 0 || idx >= lines.length || WRITE_CALL.test(lines[idx])) continue;
      if (!READS.test(lines[idx]) || !retainsRead(lines, idx, lang)) continue;
      for (const call of lines[idx].matchAll(READ_CALL)) {
        const open = lines[idx].indexOf("(", call.index + call[0].length - 1);
        const args = callArgs(lines, idx, open);
        if (/^\s*[^,]*,\s*["'][rwax]*[wax+]/.test(args)) continue; // open(path, "w") is a write
        let keys = pathKeys(args, lines);
        if (!keys.length) keys = callerPathKeys(root, rel, lines, idx, lang, staged);
        for (const key of keys) {
          if (done.has(key)) continue;
          done.add(key);
          // A writer in the reader's own binary or package shares its process (or is its
          // own save path); only a writer elsewhere can change the file under a live reader.
          const writers = writersOf(root, key, rel, staged).filter((w) =>
            w.entry ? w.entry !== readerEntry : dirname(w.file) !== dirname(rel),
          );
          if (!writers.length) continue;
          const sites = writers.map(
            (w) =>
              /** @type {CoupledSite} */ ({
                file: w.file,
                line: w.line,
                text: w.text,
                priority: w.entry ? "high" : "medium",
                why: w.entry
                  ? `writes ${key} from another binary (${w.entry})`
                  : `writes ${key} from another package (${dirname(w.file)})`,
              }),
          );
          sites.sort((x, y) => (x.priority === y.priority ? 0 : x.priority === "high" ? -1 : 1));
          hazards.push({
            kind: "live-reader",
            priority: sites[0].priority,
            file: rel,
            line: a.line,
            subject: key,
            coupled: sites,
            message: `reads ${key} into memory, and ${sites.length} site(s) elsewhere write it — will a running process see those writes? Reload on change (mtime/stat check, a file watch, SIGHUP), or document that a restart is required.`,
          });
        }
      }
    }
  }
  return hazards;
}

/** Code files other than `self` that write path key `key` — directly on the line, or through
 *  an identifier bound to it in that file.
 *  @param {string} root @param {string} key @param {string} self @param {boolean} staged */
function writersOf(root, key, self, staged) {
  const hits = git(root, [
    "-c",
    "core.quotepath=off",
    "grep",
    "-n",
    "-I",
    "-F",
    ...(staged ? ["--cached"] : ["--untracked"]),
    "-e",
    key,
  ]);
  /** @type {{file: string, line: number, text: string, entry: string|null}[]} */
  const out = [];
  const seen = new Set();
  /** @type {Map<string, string[]>} */
  const cache = new Map();
  /** @param {string} f */
  const linesOf = (f) => {
    if (!cache.has(f)) cache.set(f, (readText(root, f, staged) ?? "").split("\n"));
    return cache.get(f);
  };
  /** @param {string} file @param {number} i */
  const add = (file, i) => {
    const k = `${file}:${i}`;
    if (seen.has(k)) return;
    seen.add(k);
    const fl = linesOf(file);
    out.push({
      file,
      line: i + 1,
      text: fl[i].trim().slice(0, 120),
      entry: entryPoint(file, fl.join("\n")),
    });
  };
  for (const hit of hits.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(hit);
    if (!m || m[1] === self || !isCodeSource(m[1])) continue;
    const fl = linesOf(m[1]);
    const i = Number(m[2]) - 1;
    const near = fl.slice(Math.max(0, i - 2), i + 3).join("\n");
    if (WRITE_CALL.test(fl[i] ?? "") || (WRITE_CALL.test(near) && !READS.test(fl[i] ?? ""))) {
      add(m[1], i);
      continue;
    }
    // `const tokensFile = "tokens.json"` / `p := filepath.Join(dir, "tokens.json")` → the
    // writes in that file that name the bound identifier
    const bound =
      /^\s*(?:(?:export\s+)?(?:var|const|let)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w.]+\s*)?(?::=|=)(?!=)/.exec(
        m[3],
      );
    if (!bound) continue;
    const id = new RegExp(`\\b${esc(bound[1])}\\b`);
    for (let j = 0; j < fl.length; j++)
      if (j !== i && id.test(fl[j]) && WRITE_CALL.test(fl[j])) add(m[1], j);
  }
  return out.slice(0, 10);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Every coupling hazard in a change set, high priority first.
 * @param {string} root
 * @param {{base?: string, staged?: boolean, files?: string[]}} [opts]
 * @returns {{changedFiles: string[], hazards: CouplingHazard[]}}
 */
export function couplingHazards(root, opts = {}) {
  try {
    const changes = diffChanges(root, opts);
    const staged = Boolean(opts.staged);
    const hazards = [
      ...setQuantifierHazards(root, changes, { staged }),
      ...liveReaderHazards(root, changes, { staged }),
    ].sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1));
    return { changedFiles: [...changes.keys()], hazards: hazards.slice(0, MAX_HAZARDS) };
  } catch {
    return { changedFiles: [], hazards: [] };
  }
}

/**
 * `forge impact --diff`: the diff's coupling hazards, then the import graph's dependents of
 * its changed code files — the ordinary co-change list, which ranks BELOW the hazards.
 * @param {string} root
 * @param {{base?: string, staged?: boolean, relations?: readonly string[]}} [opts]
 * @returns {{base: string, staged: boolean, changedFiles: string[], hazards: CouplingHazard[],
 *   dependents: {file: string, relation: string, via: string}[], capped: boolean}}
 */
export function diffImpact(root, { base, staged = false, relations } = {}) {
  const { changedFiles, hazards } = couplingHazards(root, { base, staged });
  /** @type {{file: string, relation: string, via: string}[]} */
  const dependents = [];
  let capped = false;
  try {
    const code = changedFiles
      .filter((f) => CODE_EXTS.has(extname(f)) && !isTestFile(f))
      .slice(0, 10);
    if (code.length) {
      // Built once for every changed file: a dirty tree is always "stale" to the cache.
      const cached = loadAtlas(root);
      const atlas = cached && !atlasIsStale(root, cached) ? cached : buildAtlas({ root });
      capped = Boolean(atlas.capped);
      const changed = new Set(changedFiles);
      for (const f of code) {
        const r = impact(atlas, f, { maxHops: 2, ...(relations ? { relations } : {}) });
        const rels = fileRelations([r]);
        for (const d of byRelation(r.impactedFiles, rels)) {
          if (changed.has(d) || dependents.some((x) => x.file === d)) continue;
          dependents.push({ file: d, relation: rels[d] ?? "reverse", via: f });
        }
      }
    }
  } catch {}
  return {
    base: staged ? "index" : base || "HEAD",
    staged,
    changedFiles,
    hazards,
    dependents,
    capped,
  };
}

/**
 * Human lines for a hazard list (empty list → no lines).
 * @param {CouplingHazard[]} hazards @param {{maxSites?: number}} [opts]
 * @returns {string[]}
 */
export function renderHazards(hazards, { maxSites = 5 } = {}) {
  const lines = [];
  for (const h of hazards) {
    lines.push(`${h.priority === "high" ? "!!" : "! "} ${h.file}:${h.line}  ${h.message}`);
    for (const s of h.coupled.slice(0, maxSites))
      lines.push(`     → ${s.file}:${s.line}  ${s.why}`);
    if (h.coupled.length > maxSites) lines.push(`     … ${h.coupled.length - maxSites} more`);
  }
  return lines;
}
