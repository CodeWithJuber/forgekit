// forge uidiff — is a JS/TS change PRESENTATIONAL only? The completion gate asks a code
// change for test evidence, but a Tailwind className tweak in a .tsx file is the same visual
// change as an edit to a .css file, and neither is exercised by a unit test. This module
// answers that one question: after blanking what only affects presentation, does the code
// skeleton still match? Blanked are:
//   - the value of a `className=` / `class=` / `style=` JSX ATTRIBUTE (inside an open
//     `<Tag …>`: a string, or the `{…}` expression, whose only effect is the class/style it
//     produces). The same words anywhere else (`static className = …`, `let style = …`) are
//     code. In .jsx/.tsx a `className:` key and a `style: {…}` object are blanked too (props
//     tables); `{ style: "currency" }` (Intl) and `{ class: … }` never are.
//   - the string contents inside a class-variant call (cva, tv, cn, clsx, cx, classNames,
//     twMerge, twJoin), so a variant's classes can change but its keys cannot,
//   - JSX text between tags, and every comment and whitespace run.
// Inside a blanked expression, what could DO something stays visible: a call (`f(`), `new`,
// `delete`, `await`, `yield`, `import`, an assignment or `++`/`--`. So `className={(wipe(),
// "a")}` is code. Anything else that moved (a prop, a handler, an import, a new element, a
// variant key, a logic string) keeps the skeletons apart, so the file stays code. Pure and
// deterministic. It errs toward "code": an unusual construct (a regex literal holding a
// quote, a string with raw HTML) only ever makes the skeletons differ.

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
// JSX attributes whose whole value is presentation.
const ATTRS = new Set(["className", "class", "style"]);
// Words that act even inside a presentational expression (see the header).
const EFFECT_WORDS = new Set(["new", "delete", "await", "yield", "import"]);
// Keywords after which `<` starts an expression (a JSX element), like punctuation does.
const EXPR_KEYWORDS = new Set(["return", "yield", "await", "default", "case", "else", "do"]);
// Punctuation after which `<` starts an expression. `)`, `]`, a word, a number or a string
// before it make it a comparison or a generic (`a < b`, `Array<T>`).
const EXPR_PUNCT = new Set([..."([{,;=:?&|!+-*%~^"].concat("=>"));

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
 * `tags`: the source may hold JSX (false for .ts, where `<T>` is only ever a type).
 * `keys`: `className:`/`style: {…}` object keys are presentational (.jsx/.tsx props tables).
 * @param {string} src
 * @param {{tags?: boolean, keys?: boolean}} [opts]
 * @returns {string}
 */
export function uiSkeleton(src, { tags = true, keys = true } = {}) {
  const s = String(src ?? "");
  const n = s.length;
  const kept = [];
  let out = "";
  let depth = 0;
  /** @type {{depth: number, blank: boolean}[]} */
  const spans = []; // presentational regions, by the bracket depth that opened them
  /** @type {{depth: number, pres: boolean}[]} */
  const tpl = []; // open `${` expressions of template literals
  /** @type {{depth: number, mode: "tag" | "children" | "close"}[]} */
  const jsx = []; // open JSX: inside `<Tag …>`, between its tags, or inside `</Tag>`
  let pendingSpan = -1; // index of the `{`/`(` that opens a span
  let pendingBlank = false;
  let pendingString = -1; // index of a quote that opens a presentational string
  let prev = ""; // the last token: a word, a punctuator, or "" (start / string / number)
  const blanking = () => spans.some((sp) => sp.blank);
  const emit = (x) => {
    if (!blanking()) out += x;
  };
  const skipWs = (j) => {
    while (j < n && /\s/.test(s[j])) j += 1;
    return j;
  };
  const top = () => jsx[jsx.length - 1];
  const at = (mode) => top()?.mode === mode && top()?.depth === depth;
  const closeFramesAbove = () => {
    while (jsx.length && (top()?.depth ?? 0) > depth) jsx.pop();
  };
  // Does `<` at i open a JSX element (or fragment)? Between an element's tags any `<` does;
  // elsewhere only where an expression can start, and never a TS generic (`<T,>`,
  // `<T extends U>`).
  const opensTag = (i) => {
    if (!tags) return false;
    const m = /^<([A-Za-z][\w.:-]*)?\s*(,|extends\b)?/.exec(s.slice(i, i + 256));
    if (!m || (!m[1] && s[i + 1] !== ">") || m[2]) return false;
    if (at("children")) return true;
    return prev === "" || EXPR_PUNCT.has(prev) || EXPR_KEYWORDS.has(prev);
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
    prev = '"';
    if (j >= n) return n;
    if (s[j] === "`") {
      emit("`");
      return j + 1;
    }
    depth += 1;
    tpl.push({ depth, pres });
    emit("${");
    prev = "{";
    return j + 2;
  };

  let i = 0;
  while (i < n) {
    const c = s[i];
    // Between an element's tags everything but `<`, `{` and whitespace is text: `//`, `/*`,
    // quotes and brackets included (`<p>Don't (yet)</p>`, `<a>https://x</a>`).
    const text = at("children");
    if (!text && c === "/" && s[i + 1] === "/") {
      const e = s.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (!text && c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (!text && (c === '"' || c === "'")) {
      i = quoted(i, c, spans.length > 0 || pendingString === i);
      prev = '"';
      continue;
    }
    if (!text && c === "`") {
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
      const k = skipWs(j);
      if (!blanking()) out += word;
      else if (s[k] === "(" || (s[k] === "?" && s[k + 1] === "." && s[skipWs(k + 2)] === "("))
        out += `${word}(`; // a call acts, even inside a presentational expression
      else if (EFFECT_WORDS.has(word)) out += word;
      prev = word;
      if (!text) {
        // `className="…"` / `style={…}` as a JSX attribute (`==`/`=>` are comparisons and
        // arrows), or, in .jsx/.tsx, a `className:` / `style: {…}` object key.
        const v = skipWs(k + 1);
        const inTag = at("tag");
        const attr =
          inTag && ATTRS.has(word) && s[k] === "=" && s[k + 1] !== "=" && s[k + 1] !== ">";
        const key =
          keys &&
          !inTag &&
          s[k] === ":" &&
          (word === "className" || (word === "style" && s[v] === "{"));
        if (attr || key) {
          if (s[v] === "{") {
            pendingSpan = v;
            pendingBlank = true;
          } else if (s[v] === '"' || s[v] === "'" || s[v] === "`") pendingString = v;
        } else if (CLASS_FNS.has(word) && s[k] === "(") {
          pendingSpan = k;
          pendingBlank = false;
        }
      }
      i = j;
      continue;
    }
    if ((c === "(" || c === "[" || c === ")" || c === "]") && text) {
      emit(c); // a bracket in JSX text is text
      prev = c;
      i += 1;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      emit(c);
      depth += 1;
      if (pendingSpan === i) spans.push({ depth, blank: pendingBlank });
      prev = c;
      i += 1;
      continue;
    }
    if (c === ")" || c === "}" || c === "]") {
      if (c === "}" && tpl.length && tpl[tpl.length - 1].depth === depth) {
        const t = tpl.pop();
        depth -= 1;
        closeFramesAbove();
        emit("}");
        i = template(i + 1, t?.pres ?? false);
        continue;
      }
      if (spans.length && spans[spans.length - 1].depth === depth) spans.pop();
      depth = Math.max(0, depth - 1);
      closeFramesAbove();
      emit(c);
      prev = c;
      i += 1;
      continue;
    }
    if (c === "<") {
      if (text && s[i + 1] === "/") {
        jsx.pop(); // `</Tag>`: the element's children end here
        jsx.push({ depth, mode: "close" });
      } else if (opensTag(i)) jsx.push({ depth, mode: "tag" });
    } else if (c === ">") {
      const frame = top();
      if (frame && at("tag")) {
        if (prev === "/")
          jsx.pop(); // `<br />`: no children
        else frame.mode = "children";
      } else if (at("close")) jsx.pop();
    } else if (c === ";" && at("tag")) jsx.pop(); // not a tag after all: a statement ended
    if (!blanking()) out += c;
    else if (c === "=" && s[i + 1] !== "=" && s[i + 1] !== ">" && !"=!<>".includes(s[i - 1]))
      out += "="; // an assignment acts, even inside a presentational expression
    else if ((c === "+" || c === "-") && s[i + 1] === c) {
      out += c + c;
      i += 2;
      prev = c;
      continue;
    }
    prev = c === ">" && s[i - 1] === "=" ? "=>" : c;
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
 * @param {{tags?: boolean, keys?: boolean}} [opts] see uiSkeleton
 */
export function presentationalOnly(before, after, opts) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  if (before === after) return false;
  return uiSkeleton(before, opts) === uiSkeleton(after, opts);
}
