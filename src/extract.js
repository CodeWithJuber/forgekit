// forge extract — the ONE call-site extractor, shared so atlas.js and verify.js can't drift.
// `CALL_RE` matches a called identifier while skipping `.method(` member calls; `CALL_IGNORE` is
// the language/runtime builtins that are never project symbols. Kept dependency-free and pure.

export const CALL_RE = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;

// Builtins/keywords that look like calls but are never a project-defined symbol. Superset of the
// two sets atlas.js and verify.js used to keep separately (so neither under-ignores).
export const CALL_IGNORE = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "await",
  "new",
  "delete",
  "void",
  "yield",
  "import",
  "export",
  "require",
  "super",
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Set",
  "Map",
  "WeakMap",
  "Date",
  "Error",
  "RegExp",
  "Symbol",
  "Buffer",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "fetch",
  "structuredClone",
  "process",
  "assert",
  // Python-ish builtins seen in mixed repos
  "print",
  "range",
  "len",
  "int",
  "str",
  "float",
  "dict",
  "list",
  "set",
  "tuple",
  "bool",
]);

/** Pure: the called identifiers in a block of source (member calls `.foo(` are skipped). */
export function extractCalledSymbols(text, ignore = CALL_IGNORE) {
  const found = new Set();
  for (const line of String(text).split("\n")) {
    CALL_RE.lastIndex = 0;
    let m;
    while ((m = CALL_RE.exec(line))) {
      const name = m[1];
      if (!ignore.has(name)) found.add(name);
    }
  }
  return [...found];
}
