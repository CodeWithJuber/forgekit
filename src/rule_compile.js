// forge know --enforce — a remembered rule that can be checked becomes a check.
//
// Memory is external state: a fact lives in a file and helps only when it is retrieved into a
// model's context and the model follows it. For one kind of fact that is the wrong home. "Never
// import moment", "use pnpm, not npm", "no console.log in src" are policies, and a policy that
// a program can test should not depend on being read. This module compiles such a sentence into
// a deterministic check over the lines a commit adds, and `forge precommit` runs every compiled
// rule whether or not any model saw it.
//
// Compilation is deliberately narrow. A sentence is compiled only when it matches one of a few
// shapes whose meaning is unambiguous (forbid an import, forbid a literal or a known language
// construct in some files, forbid another package manager's lockfile). Anything else is
// refused with the reason, and stays memory: a wrong check is worse than none, because it
// blocks good commits in the name of a rule nobody stated.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RULES_FILE = join(".forge", "rules.json");

/**
 * @typedef {{id: string, text: string, kind: "no-import" | "no-text" | "no-file",
 *   subject: string, pattern?: string, files?: string, ext?: string[], hint?: string,
 *   severity: "block" | "warn"}} Rule
 *   `subject`: the module, literal or file name the rule forbids. `pattern`: a regular
 *   expression source for construct rules. `files`: a directory the rule is limited to.
 *   `ext`: file extensions the rule applies to.
 */

const JS = ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte"];
const PY = ["py"];

/** Language constructs a policy names by word → how to find one in an added line. */
const CONSTRUCTS = {
  eval: { pattern: String.raw`\beval\s*\(`, ext: [...JS, ...PY], label: "eval()" },
  var: { pattern: String.raw`(^|[^.\w$])var\s+[\w$]`, ext: JS, label: "var declarations" },
  any: {
    pattern: String.raw`:\s*any\b|<any>|\bas\s+any\b`,
    ext: ["ts", "mts", "cts", "tsx"],
    label: "the any type",
  },
  "console.log": { pattern: String.raw`\bconsole\.log\s*\(`, ext: JS, label: "console.log" },
  print: { pattern: String.raw`(^|[^.\w])print\s*\(`, ext: PY, label: "print()" },
  debugger: { pattern: String.raw`\bdebugger\s*;?`, ext: JS, label: "debugger statements" },
  "ts-ignore": {
    pattern: String.raw`@ts-ignore`,
    ext: ["ts", "mts", "cts", "tsx"],
    label: "@ts-ignore",
  },
  "default exports": {
    pattern: String.raw`\bexport\s+default\b`,
    ext: JS,
    label: "default exports",
  },
  ".only": {
    pattern: String.raw`\b(?:it|test|describe)\.only\s*\(`,
    ext: JS,
    label: ".only in tests",
  },
  todo: { pattern: String.raw`\bTODO\b`, ext: [], label: "TODO markers" },
};
/** Spellings that name the same construct. */
const CONSTRUCT_ALIASES = {
  "eval()": "eval",
  "console.logs": "console.log",
  "console.log()": "console.log",
  "console logs": "console.log",
  "print statements": "print",
  "print()": "print",
  "debugger statements": "debugger",
  "@ts-ignore": "ts-ignore",
  "ts-ignore comments": "ts-ignore",
  "default export": "default exports",
  "export default": "default exports",
  "it.only": ".only",
  "test.only": ".only",
  todos: "todo",
  "todo comments": "todo",
  "var declarations": "var",
  "the any type": "any",
  "any type": "any",
  "any types": "any",
};
/** Package managers → the lockfile only they write. */
const LOCKFILES = {
  npm: "package-lock.json",
  yarn: "yarn.lock",
  pnpm: "pnpm-lock.yaml",
  bun: "bun.lockb",
  poetry: "poetry.lock",
  pipenv: "Pipfile.lock",
  uv: "uv.lock",
};
/** Words that follow "use"/"import" without naming a package: such a sentence is not compiled. */
const NOT_A_PACKAGE = new Set([
  ...["a", "an", "the", "any", "magic", "hardcoded", "inline", "global", "globals", "classes"],
  ...["mutable", "mutation", "mocks", "real", "relative", "absolute", "long", "short", "deep"],
  ...["nested", "new", "old", "raw", "plain", "native", "third-party", "external", "this", "that"],
  ...["tabs", "spaces", "semicolons", "abbreviations", "comments", "emojis", "it", "them"],
]);

const PKG = String.raw`[\x60"']?(@?[a-z0-9][\w.-]*(?:/[\w.-]+)?)[\x60"']?`;
const IN_DIR = String.raw`(?:\s+(?:anywhere|in\s+(?:the\s+)?(?:code(?:base)?|project|repo)|(?:in|under|inside)\s+[\x60"']?([\w./-]+?)[\x60"']?/?(?:\s+(?:dir(?:ectory)?|folder|files?))?))?`;
const NEVER = String.raw`(?:never|don't|dont|do\s+not|no\s+longer|stop|avoid)`;

/** @param {string} s */
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

/**
 * Compile a policy sentence into a check, or say why it cannot be one.
 * A sentence that only says "use"/"avoid" a word is compiled as a package rule only when the
 * word is a package this repository knows (`known`) or is spelled like one (`@scope/x`,
 * `date-fns`): "prefer composition over inheritance" must not become a ban on importing
 * `inheritance`. An explicit "import", "require" or "install" needs no such evidence.
 * @param {string} text
 * @param {{severity?: "block" | "warn", known?: Iterable<string>}} [opts]
 * @returns {{ok: true, rule: Rule} | {ok: false, reason: string}}
 */
export function compileRule(text, { severity = "block", known = [] } = {}) {
  const knownSet = new Set([...known].map((k) => String(k).toLowerCase()));
  /** @param {string} name */
  const isPackage = (name) =>
    knownSet.has(name.toLowerCase()) || /^@[\w.-]+\/|[-.]/.test(name) || /\//.test(name);
  const raw = String(text ?? "").trim();
  // The rule is the first clause: "do not import request; it is deprecated" → the reason
  // after `;`, a dash or "because" is commentary, not part of what is forbidden.
  const s = raw
    .split(/\s*(?:;|\s[—–-]\s|\s\(|,?\s+(?:because|since|as)\s)/)[0]
    .replace(/[.!]+$/, "")
    .replace(/^(?:please|we|you|always)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return { ok: false, reason: "empty rule" };
  /** @param {Omit<Rule, "id" | "text" | "severity">} r @returns {{ok: true, rule: Rule}} */
  const make = (r) => ({
    ok: true,
    rule: {
      id: `${r.kind}-${slug(r.subject)}${r.files ? `-${slug(r.files)}` : ""}`,
      text: raw,
      severity,
      ...r,
    },
  });
  /** @param {string | undefined} d */
  const dir = (d) => (d ? d.replace(/^\.\//, "").replace(/\/+$/, "") : undefined);

  // 1. "use pnpm, not npm" / "prefer A over B" / "use A instead of B".
  let m = new RegExp(
    String.raw`^(?:use|prefer)\s+${PKG},?\s+(?:instead\s+of|over|rather\s+than|not)\s+${PKG}${IN_DIR}$`,
    "i",
  ).exec(s);
  if (m) {
    const [, want, banned, where] = m;
    const lower = banned.toLowerCase();
    if (lower in LOCKFILES && want.toLowerCase() in LOCKFILES)
      return make({
        kind: "no-file",
        subject: LOCKFILES[/** @type {keyof typeof LOCKFILES} */ (lower)],
        hint: `this project uses ${want}`,
      });
    const construct = constructOf(lower);
    if (construct) return make({ ...construct, files: dir(where), hint: `use ${want}` });
    if (NOT_A_PACKAGE.has(lower) || !(isPackage(banned) || isPackage(want))) return refuse(s);
    return make({ kind: "no-import", subject: banned, files: dir(where), hint: `use ${want}` });
  }
  // 2. A construct by name: "no console.log in src", "never use var", "avoid default exports".
  m = new RegExp(
    String.raw`^(?:${NEVER}\s+(?:use|using|write|writing|add|adding|leave|leaving|commit|committing)|no|avoid)\s+(?:any\s+)?([\w.@()'\x60 -]+?)${IN_DIR}$`,
    "i",
  ).exec(s);
  if (m) {
    const construct = constructOf(
      m[1]
        .replace(/[\x60']/g, "")
        .trim()
        .toLowerCase(),
    );
    if (construct) return make({ ...construct, files: dir(m[2]) });
  }
  // 3. A quoted literal: `never commit "localhost:3000"`, `no "FIXME" in src`.
  m = new RegExp(
    String.raw`^(?:${NEVER}\s+(?:use|write|add|commit|put|leave|hardcode|hard-code)|no)\s+["\x60]([^"\x60]{2,80})["\x60]${IN_DIR}$`,
    "i",
  ).exec(s);
  if (m) return make({ kind: "no-text", subject: m[1], files: dir(m[2]), ext: [] });
  // 4. A package: "never import moment", "do not use lodash in src", "no axios".
  m = new RegExp(
    String.raw`^(?:${NEVER}\s+(use|using|import|importing|require|requiring|add|adding|install|installing|depend\s+on)|avoid)\s+(?:the\s+)?${PKG}(\s+(?:package|library|lib|module|dependency))?${IN_DIR}$`,
    "i",
  ).exec(s);
  if (m && !NOT_A_PACKAGE.has(m[2].toLowerCase())) {
    // "import X" and "the X library" say it is a package; "use X" alone needs evidence.
    const explicit = /^(?:import|require|install|depend)/i.test(m[1] ?? "") || Boolean(m[3]);
    if (explicit || isPackage(m[2]))
      return make({ kind: "no-import", subject: m[2], files: dir(m[4]) });
    return {
      ok: false,
      reason: `"${m[2]}" is not a package this repository lists — say "never import ${m[2]}" to make it a check`,
    };
  }
  m = new RegExp(
    String.raw`^${PKG}\s+is\s+(?:banned|forbidden|not\s+allowed|deprecated\s+here)${IN_DIR}$`,
    "i",
  ).exec(s);
  if (m && !NOT_A_PACKAGE.has(m[1].toLowerCase()) && isPackage(m[1]))
    return make({ kind: "no-import", subject: m[1], files: dir(m[2]) });
  return refuse(s);
}

/** @param {string} s @returns {{ok: false, reason: string}} */
function refuse(s) {
  return {
    ok: false,
    reason: `"${s}" is not one of the shapes a commit check can test (forbid an import, a literal, a known construct such as console.log or default exports, or another package manager's lockfile) — keep it as memory`,
  };
}

/** @param {string} word @returns {Omit<Rule, "id" | "text" | "severity"> | null} */
function constructOf(word) {
  const key = /** @type {keyof typeof CONSTRUCTS} */ (
    word in CONSTRUCTS ? word : /** @type {Record<string, string>} */ (CONSTRUCT_ALIASES)[word]
  );
  const c = key ? CONSTRUCTS[key] : null;
  return c ? { kind: "no-text", subject: c.label, pattern: c.pattern, ext: c.ext } : null;
}

/** @param {string} file @param {Rule} rule */
function applies(file, rule) {
  const f = file.replaceAll("\\", "/");
  if (rule.files && !(f === rule.files || f.startsWith(`${rule.files}/`))) return false;
  const ext = f.includes(".") ? (f.split(".").pop() ?? "").toLowerCase() : "";
  if (rule.kind === "no-import") return JS.includes(ext) || PY.includes(ext);
  return !rule.ext?.length || rule.ext.includes(ext);
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {Rule} rule */
function lineTest(rule) {
  if (rule.kind === "no-import") {
    const mod = escapeRe(rule.subject);
    const js = new RegExp(
      String.raw`(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'\x60]${mod}(?:/[^"'\x60]*)?["'\x60]`,
    );
    const py = new RegExp(
      String.raw`^\s*(?:import|from)\s+${mod.replaceAll("-", "_")}(?:[\s.,]|$)`,
    );
    return (/** @type {string} */ line) => js.test(line) || py.test(line);
  }
  const re = new RegExp(rule.pattern ?? escapeRe(rule.subject));
  return (/** @type {string} */ line) => re.test(line);
}

/**
 * The lines a change adds that break a rule.
 * @param {Rule[]} rules
 * @param {Map<string, string[]>} addedByFile file → its added lines
 * @param {string[]} [files] every changed file (a lockfile can be added with no text lines)
 * @returns {{rule: Rule, file: string, text?: string}[]}
 */
export function checkRules(rules, addedByFile, files = [...addedByFile.keys()]) {
  /** @type {{rule: Rule, file: string, text?: string}[]} */
  const out = [];
  for (const rule of rules) {
    if (rule.kind === "no-file") {
      for (const f of files)
        if ((f.replaceAll("\\", "/").split("/").pop() ?? "") === rule.subject)
          out.push({ rule, file: f });
      continue;
    }
    const test = lineTest(rule);
    for (const [file, lines] of addedByFile) {
      if (!applies(file, rule)) continue;
      const hit = lines.find((l) => test(l));
      if (hit !== undefined) out.push({ rule, file, text: hit.trim().slice(0, 160) });
    }
  }
  return out;
}

/**
 * Package names this repository knows: its manifests' dependencies and what is installed.
 * @param {string} root
 * @returns {string[]}
 */
export function knownPackages(root) {
  /** @type {Set<string>} */
  const out = new Set();
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
      for (const name of Object.keys(pkg[k] ?? {})) out.add(name);
  } catch {}
  for (const f of ["requirements.txt", "requirements-dev.txt", "pyproject.toml"]) {
    try {
      for (const m of readFileSync(join(root, f), "utf8").matchAll(
        /^\s*"?([A-Za-z][\w.-]*)\s*(?:[<>=~!;[",]|$)/gm,
      ))
        out.add(m[1]);
    } catch {}
  }
  try {
    for (const e of readdirSync(join(root, "node_modules"), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (!e.name.startsWith("@")) out.add(e.name);
      else
        for (const sub of readdirSync(join(root, "node_modules", e.name)))
          out.add(`${e.name}/${sub}`);
    }
  } catch {}
  return [...out];
}

/** @param {string} root @returns {Rule[]} */
export function loadRules(root) {
  try {
    const doc = JSON.parse(readFileSync(join(root, RULES_FILE), "utf8"));
    return Array.isArray(doc?.rules) ? doc.rules.filter((r) => r && r.id && r.kind) : [];
  } catch {
    return [];
  }
}

/** @param {string} root @param {Rule[]} rules */
export function saveRules(root, rules) {
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, RULES_FILE), `${JSON.stringify({ version: 1, rules }, null, 2)}\n`);
}

/**
 * Compile and store a rule; a rule with the same id replaces the old one.
 * @param {string} root @param {string} text @param {{severity?: "block" | "warn"}} [opts]
 */
export function addRule(root, text, opts = {}) {
  const compiled = compileRule(text, { ...opts, known: knownPackages(root) });
  if (!compiled.ok) return compiled;
  const rules = loadRules(root).filter((r) => r.id !== compiled.rule.id);
  saveRules(root, [...rules, compiled.rule]);
  return compiled;
}

/** @param {string} root @param {string} id */
export function removeRule(root, id) {
  const rules = loadRules(root);
  const kept = rules.filter((r) => r.id !== id);
  if (kept.length === rules.length) return { ok: false, reason: `no rule with id ${id}` };
  saveRules(root, kept);
  return { ok: true, id };
}

/** One line a person reads: what the rule forbids, and where. @param {Rule} r */
export function describeRule(r) {
  const where = r.files ? ` in ${r.files}/` : "";
  if (r.kind === "no-import")
    return `no import of \`${r.subject}\`${where}${r.hint ? ` (${r.hint})` : ""}`;
  if (r.kind === "no-file") return `no \`${r.subject}\`${r.hint ? ` (${r.hint})` : ""}`;
  return `no ${r.pattern ? r.subject : `"${r.subject}"`}${where}${r.hint ? ` (${r.hint})` : ""}`;
}
