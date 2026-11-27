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
  // Keywords and runtime globals that precede "(" without being a project call:
  // `} else (`, `async () =>`, `new URL(`.
  "else",
  "async",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "BigInt",
  "setImmediate",
  "queueMicrotask",
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

/**
 * Pure: the names a source file binds by importing them: ESM `import a, { b as c } from`,
 * `import * as ns from`, CommonJS and dynamic-import destructuring (`const { d } = require(…)`
 * or `= await import(…)`), and Python `from m import e, f as g` / `import m as h`. A call to one
 * of these is a call to a dependency or a runtime module, not a symbol the project failed to
 * define, so verify's possible-hallucination check skips them.
 * @param {string} text
 * @returns {Set<string>}
 */
export function importedBindings(text) {
  const names = new Set();
  const add = (raw) => {
    for (const part of String(raw).split(",")) {
      const m = /^\s*(?:type\s+)?[\w$]+(?:\s*(?:as|:)\s*([\w$]+))?\s*$/.exec(part);
      if (!m) continue;
      const name = m[1] ?? part.trim().replace(/^type\s+/, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  };
  const src = String(text);
  for (const m of src.matchAll(
    /\bimport\s+(?:type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?\s*from\s*["']/g,
  )) {
    if (m[1]) names.add(m[1]);
    if (m[2]) add(m[2]);
    if (m[3]) names.add(m[3]);
  }
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+(?:\{([^}]*)\}|([\w$]+))\s*=\s*(?:await\s+)?(?:require|import)\s*\(/g,
  )) {
    if (m[1]) add(m[1]);
    if (m[2]) names.add(m[2]);
  }
  for (const m of src.matchAll(/^\s*from\s+[\w.]+\s+import\s+\(?([^)\n]*)\)?/gm)) add(m[1]);
  for (const m of src.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm))
    names.add(m[2] ?? m[1].split(".")[0]);
  return names;
}
