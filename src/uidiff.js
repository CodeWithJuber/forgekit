// forge uidiff — is a JS/TS change PRESENTATIONAL only? The completion gate asks a code
// change for test evidence, but a Tailwind className tweak in a .tsx file is the same visual
// change as an edit to a .css file, and neither is exercised by a unit test. This module
// answers that one question: after blanking what only affects presentation, does the code
// skeleton still match? Blanked are:
//   - the value of a `className=` / `class=` / `style=` attribute (a string, or the whole
//     `{…}` expression, whose only effect is the class/style it produces),
//   - the string contents inside a class-variant call (cva, tv, cn, clsx, cx, classNames,
//     twMerge, twJoin), so a variant's classes can change but its keys cannot,
//   - JSX text between tags, and every comment and whitespace run.
// Anything else that moved (a prop, a handler, an import, a new element, a variant key, a
// logic string) keeps the skeletons apart, so the file stays code. Pure and deterministic.
// It errs toward "code": an unusual construct (a regex literal holding a quote, a string
// with raw HTML) only ever makes the skeletons differ, and code is today's gate behaviour.

// Calls whose string arguments are class lists: shadcn's cn, cva/tv variant tables, the
// classnames family. Keys and structure stay in the skeleton; only string contents blank.
const CLASS_FNS = new Set([
  "cva",
  "tv",
  "cn",
  "clsx",
  "cx",
  "classNames",
  "classnames",
  "twMerge",
  "twJoin",
]);
// Attributes (and object keys) whose whole value is presentation.
const ATTRS = new Set(["className", "class", "style"]);

const STR = "\uE000"; // a kept (non-presentational) string literal (private-use marker)
const BLANK = "\uE001"; // a presentational string literal, contents dropped

// JSX text: the run after a tag's `>` up to the next `<` or `{`. An OPENING tag must not be
// preceded by an identifier, `)`, `]`, a string or a template (with whitespace gone,
// `a < b` reads `a<b` and a TS generic reads `Array<T>` — neither is JSX); `return<div>` is
// the one keyword that may. Closing tags and fragments cannot be generics. The text itself
// may not hold code punctuation, so a generic that slips through never blanks a call,
// assignment or statement.
const JSX_TEXT =
  /((?:(?<![\w$.)\]`\uE000\uE001])|(?<=\breturn))<[A-Za-z][\w.:-]*(?:=>|[^<>])*?>|<\/[A-Za-z][\w.:-]*>|<>|<\/>)([^<>{}()[\];=|`\uE000\uE001]*)(?=[<{])/g;

/**
 * The presentational skeleton of a JS/TS/JSX source: whitespace and comments dropped,
 * presentational values blanked, kept string contents appended after a NUL so a change to
 * a logic string still shows. Two sources with equal skeletons differ only in presentation.
 * @param {string} src
 * @returns {string}
 */
export function uiSkeleton(src) {
  const s = String(src ?? "");
  const n = s.length;
  const kept = [];
  let out = "";
  let depth = 0;
  /** @type {{depth: number, blank: boolean}[]} */
  const spans = []; // presentational regions, by the bracket depth that opened them
  /** @type {{depth: number, pres: boolean}[]} */
  const tpl = []; // open `${` expressions of template literals
  let pendingSpan = -1; // index of the `{`/`(` that opens a span
  let pendingBlank = false;
  let pendingString = -1; // index of a quote that opens a presentational string
  const blanking = () => spans.some((sp) => sp.blank);
  const emit = (x) => {
    if (!blanking()) out += x;
  };
  const skipWs = (j) => {
    while (j < n && /\s/.test(s[j])) j += 1;
    return j;
  };

  // A quoted string starting at i. Unterminated strings end at the newline (a quote in
  // JSX text or a regex literal must not swallow the rest of the file).
  const quoted = (i, q, pres) => {
    let j = i + 1;
    let body = "";
    while (j < n && s[j] !== q && s[j] !== "\n") {
      if (s[j] === "\\" && j + 1 < n) {
        body += s[j] + s[j + 1];
        j += 2;
        continue;
      }
      body += s[j];
      j += 1;
    }
    if (pres) emit(BLANK);
    else if (!blanking()) {
      out += STR;
      kept.push(body);
    }
    return j < n && s[j] === q ? j + 1 : j;
  };

  // Template literal text from i (just past a backtick or a closing `}` of `${`). Returns
  // the index after the closing backtick, or after `${` with the expression pushed.
  const template = (i, pres) => {
    let j = i;
    let body = "";
    while (j < n) {
      if (s[j] === "\\" && j + 1 < n) {
        body += s[j] + s[j + 1];
        j += 2;
        continue;
      }
      if (s[j] === "`") break;
      if (s[j] === "$" && s[j + 1] === "{") break;
      body += s[j];
      j += 1;
    }
    if (pres) emit(BLANK);
    else if (!blanking()) {
      out += STR;
      kept.push(body);
    }
    if (j >= n) return n;
    if (s[j] === "`") {
      emit("`");
      return j + 1;
    }
    depth += 1;
    tpl.push({ depth, pres });
    emit("${");
    return j + 2;
  };

  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      const e = s.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = quoted(i, c, spans.length > 0 || pendingString === i);
      continue;
    }
    if (c === "`") {
      const pres = spans.length > 0 || pendingString === i;
      emit("`");
      i = template(i + 1, pres);
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(s[j])) j += 1;
      const word = s.slice(i, j);
      emit(word);
      const k = skipWs(j);
      // `className="…"` / `style={…}` (JSX), or the same names as object keys
      // (`{ className: "…" }` in a props table). `==`/`=>` are comparisons and arrows.
      const assigns = s[k] === "=" && s[k + 1] !== "=" && s[k + 1] !== ">";
      if (ATTRS.has(word) && (assigns || s[k] === ":")) {
        const v = skipWs(k + 1);
        if (s[v] === "{") {
          pendingSpan = v;
          pendingBlank = true;
        } else if (s[v] === '"' || s[v] === "'" || s[v] === "`") pendingString = v;
      } else if (CLASS_FNS.has(word) && s[k] === "(") {
        pendingSpan = k;
        pendingBlank = false;
      }
      i = j;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      emit(c);
      depth += 1;
      if (pendingSpan === i) spans.push({ depth, blank: pendingBlank });
      i += 1;
      continue;
    }
    if (c === ")" || c === "}" || c === "]") {
      if (c === "}" && tpl.length && tpl[tpl.length - 1].depth === depth) {
        const t = tpl.pop();
        depth -= 1;
        emit("}");
        i = template(i + 1, t?.pres ?? false);
        continue;
      }
      if (spans.length && spans[spans.length - 1].depth === depth) spans.pop();
      depth = Math.max(0, depth - 1);
      emit(c);
      i += 1;
      continue;
    }
    emit(c);
    i += 1;
  }
  return `${out.replace(JSX_TEXT, "$1")}\u0000${kept.join("\u0000")}`;
}

/**
 * True when `before` → `after` changed ONLY presentation (see the header). Identical
 * sources are not a presentational change (nothing moved), and a missing side (a new or
 * deleted file) never is: a new component is code.
 * @param {string|null|undefined} before
 * @param {string|null|undefined} after
 */
export function presentationalOnly(before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  if (before === after) return false;
  return uiSkeleton(before) === uiSkeleton(after);
}
