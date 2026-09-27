// forge semantic guard — "are these two texts the SAME instruction?", asked before any tier
// acts on similarity alone. Lexical similarity (MinHash/Jaccard) and embedding cosine say two
// texts are NEIGHBOURS; they cannot say the texts mean the same thing: `accept ages >= 18` vs
// `<= 18`, "Enable authentication…" vs "Disable authentication…", `return "ADMIN"` vs
// `"admin"`, `getURL` vs `getUrl` all score ≈ 1 (review F04/F16). Every place that would
// MERGE, DEDUPE or SERVE-AS-IS on similarity runs this first and treats any conflict as a
// blocker: the pair is kept apart (or downgraded to a reviewed tier) with the conflict named.
//
// Deliberately conservative and deterministic: the features are the tokens that carry
// behaviour — operators, numbers (with units), quoted literals, code identifiers and paths
// (case AND code points kept: no Unicode fold, since `"é"` composed and decomposed are two
// different strings to a program), polarity/negation words, and the whitespace that can be
// data (`layout`, review N01). A false conflict costs a human glance; a missed one serves or
// keeps the opposite rule. Pure — no I/O.

// Polarity is judged two ways, so that emphasis ("run X" vs "always run X") is not a flip
// but a real reversal is:
//  1. NEGATION PARITY — the count of negators (not, never, without, n't, skip, ignore, bypass…)
//     mod 2. "validate signatures" vs "skip signature validation" differ; "do not skip
//     validation" vs "validate" do not (a double negative).
//  2. A SPLIT ANTONYM PAIR — one side says a word from one pole of a pair and the other side
//     says the opposite pole but not the first: enable/disable, allow/deny, include/exclude,
//     add/remove, true/false, on/off, always/never, before/after, min/max, asc/desc, …
const NEGATORS = new Set(
  (
    "not no never none nothing nobody nowhere neither nor without cannot " +
    "skip skips skipped skipping ignore ignores ignored ignoring bypass bypasses bypassed " +
    "bypassing avoid avoids avoided avoiding prevent prevents prevented omit omits omitted " +
    "omitting disallow disallows disallowed"
  ).split(/\s+/),
);
// [one pole, the other pole] — inflected forms listed explicitly (no stemmer, no surprises).
const ANTONYM_PAIRS = [
  ["enable enables enabled enabling", "disable disables disabled disabling"],
  [
    "allow allows allowed allowing permit permits permitted",
    "deny denies denied denying block blocks blocked blocking forbid forbids forbidden reject rejects rejected",
  ],
  ["include includes included including", "exclude excludes excluded excluding"],
  [
    "add adds added adding create creates created insert inserts",
    "remove removes removed removing delete deletes deleted deleting drop drops dropped",
  ],
  ["keep keeps kept retain retains", "discard discards discarded"],
  ["true yes", "false"],
  ["on", "off"],
  ["always", "never"],
  ["before", "after"],
  ["min minimum lowest", "max maximum highest"],
  [
    "increase increases increased raise raises raised grow",
    "decrease decreases decreased lower lowers lowered reduce reduces reduced shrink",
  ],
  ["ascending asc", "descending desc"],
  ["sync synchronous synchronously", "async asynchronous asynchronously"],
  ["public external", "private internal"],
  ["encrypt encrypts encrypted", "decrypt decrypts decrypted unencrypted plaintext"],
  ["signed sign", "unsigned"],
  ["valid", "invalid"],
  ["accept accepts accepted", "reject rejects rejected"],
  ["required require requires mandatory must", "optional may"],
  ["strict strictly", "lenient loose loosely"],
  ["secure securely", "insecure insecurely"],
  ["more greater larger above over", "less fewer smaller below under"],
  ["first", "last"],
  ["start starts started", "stop stops stopped"],
  ["show shows shown", "hide hides hidden"],
  ["lock locks locked", "unlock unlocks unlocked"],
].map(([a, b]) => [new Set(a.split(" ")), new Set(b.split(" "))]);
const POLE_WORDS = new Set(ANTONYM_PAIRS.flatMap(([a, b]) => [...a, ...b]));
// A contraction ending in n't (don't, isn't, won't…) is a negator too.
const NEGATED_CONTRACTION = /^[\p{L}]+n['’]t$/u;

const OPERATOR_RE = /===|!==|==|!=|>=|<=|=>|&&|\|\||<<|>>|[<>=]|!(?=[\p{L}\p{N}_$(])/gu;
const NUMBER_RE =
  /(?<![\p{L}\p{N}_])-?\d+(?:[.,_]\d+)*(?:\s?(?:%|ms|s|sec|secs|seconds?|mins?|minutes?|h|hrs?|hours?|d|days?|kb|mb|gb|tb|px|em|rem|x))?(?![\p{L}\p{N}_])/giu;
const LITERAL_RE = /(["'`])(?:(?!\1)[^\\]|\\.)*\1/gu;
// camelCase / PascalCase-with-inner-cap / snake_case / SCREAMING_SNAKE / dotted.path /
// ALLCAPS (≥2 letters) / anything with a digit next to letters — case is part of identity.
const IDENT_RE =
  /^(?:[\p{Ll}][\p{L}\p{N}]*\p{Lu}[\p{L}\p{N}]*|\p{Lu}[\p{Ll}\p{N}]+\p{Lu}[\p{L}\p{N}]*|[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+_?|[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)+|\p{Lu}{2,}[\p{Lu}\p{N}]*|[\p{L}]+\d[\p{L}\p{N}]*)$/u;
const PATH_RE = /[\\/]|\.(?:m?[jt]sx?|py|go|rs|java|rb|json|ya?ml|toml|md|css|html|sh|sql)$/i;

const sorted = (xs) => [...xs].sort();

// What may stay at a token's edges: a leading "." keeps dotfiles and relative paths, a
// trailing one is sentence punctuation. A code-point scan, not `/…|[^…]+$/g`, which
// backtracks quadratically on a long run of punctuation inside one token.
const KEEP_HEAD = /[\p{L}\p{N}_$./\\]/u;
const KEEP_TAIL = /[\p{L}\p{N}_$/\\]/u;
export function trimEdges(raw) {
  const cps = [...raw];
  let a = 0;
  let b = cps.length;
  while (a < b && !KEEP_HEAD.test(cps[a])) a++;
  while (b > a && !KEEP_TAIL.test(cps[b - 1])) b--;
  return cps.slice(a, b).join("");
}

// Whitespace that can be DATA (review N01). Similarity is layout-blind by design, and a
// reworded instruction moves whitespace around harmlessly — but a fenced code block's bytes,
// an indented line of a text that carries code (Python, YAML, a Makefile tab), and any run of
// whitespace other than one space beside a code token (`/a  b/`, `x\t= 1`) can change what the
// code does. Those are compared verbatim; whitespace between two plain words never is, and a
// line break in prose reads as one space. (Whitespace INSIDE a quoted literal is already part
// of that literal.)
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const CODE_LINE_RE = /[(){}[\];=<>|&]|:[ \t]*$/;
const PLAIN_WORD_RE = /^[\p{L}\p{N}_'’-]*$/u;
const LIT_MARK = "\u27e8lit\u27e9"; // a masked literal: a code token with no inner whitespace
const OPENERS = new Set([..."(\"'‘“["]);
const CLOSERS = new Set([...".,;:!?)\"'’”]"]);
/** Strip opening brackets/quotes and closing punctuation from a token's edges — a code-point
 *  scan, linear on any input — then what is left of a plain word is letters and digits;
 *  anything else marks a code token. */
const isPlainWord = (tok) => {
  const cps = [...tok];
  let a = 0;
  let b = cps.length;
  while (a < b && OPENERS.has(cps[a])) a++;
  while (b > a && CLOSERS.has(cps[b - 1])) b--;
  return PLAIN_WORD_RE.test(cps.slice(a, b).join(""));
};

/**
 * The layout features of a text (review N01): every fenced block and every indented line of a
 * code-bearing text, verbatim, plus every whitespace run other than a single space that sits
 * next to a code token, with its neighbours. Sorted; JSON-quoted so whitespace is visible.
 * @param {string} text
 * @returns {string[]}
 */
export function layoutFeatures(text) {
  const out = [];
  const rest = [];
  let fence = "";
  let block = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      block.push(line);
      if (
        m &&
        m[1][0] === fence[0] &&
        m[1].length >= fence.length &&
        !line.slice(m[0].length).trim()
      ) {
        out.push(`fence ${JSON.stringify(block.join("\n"))}`);
        fence = "";
      }
    } else if (m) {
      fence = m[1];
      block = [line];
    } else rest.push(line);
  }
  if (fence) out.push(`fence ${JSON.stringify(block.join("\n"))}`); // unclosed: code to the end
  const lines = rest.join("\n").replace(LITERAL_RE, LIT_MARK).split("\n");
  if (lines.some((l) => CODE_LINE_RE.test(l)))
    for (const l of lines)
      if (/^[ \t]+\S/.test(l)) out.push(`indent ${JSON.stringify(l.trimEnd())}`);
  const parts = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .split(/(\s+)/);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    if (parts[i] === " ") continue;
    const [left, right] = [parts[i - 1], parts[i + 1]];
    if (!isPlainWord(left) || !isPlainWord(right))
      out.push(`space ${JSON.stringify(`${left}${parts[i]}${right}`)}`);
  }
  return sorted(out);
}

/**
 * The behaviour-carrying features of a text.
 * @param {string} text
 * @returns {{operators: string[], numbers: string[], literals: string[],
 *   identifiers: string[], paths: string[], polarity: string[], layout: string[]}}
 */
export function criticalFeatures(text) {
  const s = String(text ?? "");
  /** @type {string[]} */
  const literals = s.match(LITERAL_RE) ?? [];
  // Literals are compared whole; strip them before scanning the rest so a quoted ">=" or a
  // quoted word never double-counts as an operator or a polarity word.
  const rest = s.replace(LITERAL_RE, " ");
  const operators = rest.match(OPERATOR_RE) ?? [];
  const numbers = (rest.match(NUMBER_RE) ?? []).map((n) =>
    n.toLowerCase().replace(/\s+/g, "").replace(/_/g, ""),
  );
  const identifiers = [];
  const paths = [];
  const polarity = [];
  for (const raw of rest.split(/\s+/)) {
    // edge punctuation only — inner punctuation (dots, underscores, slashes) is identity
    const tok = trimEdges(raw);
    if (!tok) continue;
    if (PATH_RE.test(tok) && /[\p{L}\p{N}]/u.test(tok)) paths.push(tok);
    else if (IDENT_RE.test(tok)) identifiers.push(tok);
    const word = tok.toLowerCase();
    if (NEGATORS.has(word) || NEGATED_CONTRACTION.test(word) || POLE_WORDS.has(word))
      polarity.push(word);
  }
  return {
    operators: sorted(operators),
    numbers: sorted(numbers),
    literals: sorted(literals),
    identifiers: sorted(identifiers),
    paths: sorted(paths),
    polarity: sorted(polarity),
    layout: layoutFeatures(s),
  };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const negationParity = (words) =>
  words.filter((w) => NEGATORS.has(w) || NEGATED_CONTRACTION.test(w)).length % 2;

/** Whether two polarity-word lists REVERSE each other (see the header): different negation
 *  parity, or a split antonym pair. Emphasis alone ("always" on one side only) is not. */
export function polarityFlip(a, b) {
  if (negationParity(a) !== negationParity(b)) return true;
  const A = new Set(a);
  const B = new Set(b);
  const has = (set, pole) => [...pole].some((w) => set.has(w));
  for (const [p, q] of ANTONYM_PAIRS) {
    if (has(A, p) && has(B, q) && !has(B, p)) return true;
    if (has(A, q) && has(B, p) && !has(B, q)) return true;
    if (has(B, p) && has(A, q) && !has(A, p)) return true;
    if (has(B, q) && has(A, p) && !has(A, q)) return true;
  }
  return false;
}

/** Every feature class, and the classes that REVERSE meaning (as opposed to adding detail —
 *  a rewrite that names a new identifier or path is more specific, not the opposite). */
export const ALL_KINDS = /** @type {const} */ ([
  "polarity",
  "operators",
  "numbers",
  "literals",
  "identifiers",
  "paths",
  "layout",
]);
export const FLIP_KINDS = /** @type {const} */ (["polarity", "operators", "numbers", "literals"]);

/**
 * Every feature class on which two texts disagree — empty when they carry the same
 * behaviour-bearing tokens. Each conflict names the class and what each side has that the
 * other lacks.
 * @param {string} a
 * @param {string} b
 * @param {{kinds?: readonly string[]}} [opts] restrict to these feature classes
 * @returns {{kind: string, a: string[], b: string[]}[]}
 */
export function semanticConflicts(a, b, { kinds = ALL_KINDS } = {}) {
  const fa = criticalFeatures(a);
  const fb = criticalFeatures(b);
  const out = [];
  for (const kind of kinds) {
    if (
      kind === "polarity" ? !polarityFlip(fa.polarity, fb.polarity) : sameList(fa[kind], fb[kind])
    )
      continue;
    const onlyA = fa[kind].filter((x) => !fb[kind].includes(x));
    const onlyB = fb[kind].filter((x) => !fa[kind].includes(x));
    out.push({ kind, a: onlyA.length ? onlyA : fa[kind], b: onlyB.length ? onlyB : fb[kind] });
  }
  return out;
}

/** True when neither text changes polarity, operators, numbers, literals, identifiers,
 *  paths or code layout relative to the other. Similar-and-conflicting texts are NOT the same instruction.
 *  @param {string} a @param {string} b @param {{kinds?: readonly string[]}} [opts] */
export const sameSemantics = (a, b, opts) => semanticConflicts(a, b, opts).length === 0;

/** The exact-duplicate key of a statement (review N02): whitespace runs collapsed and trailing
 *  sentence punctuation dropped — nothing else (case, quotes, inner punctuation all stay). */
export const statementKey = (s) => {
  const t = String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
  let end = t.length;
  while (end > 0 && ".!;".includes(t[end - 1])) end--; // a scan: `[.!;]+$` backtracks on runs
  return t.slice(0, end);
};

/**
 * The SAME statement, not a similar one (review N02): equal statement keys, with the guard
 * confirming no behaviour-bearing difference hid in the whitespace (inside a literal, in code
 * layout). The only equality that may merge or archive a rule automatically. Similarity —
 * lexical or embedded — can only PROPOSE: "allow admins, deny guests" and "deny admins, allow
 * guests" keep every token, polarity words included, so no token-level check separates them.
 * @param {string} a @param {string} b
 */
export const sameStatement = (a, b) => statementKey(a) === statementKey(b) && sameSemantics(a, b);

/** One-line human description of a conflict list: `polarity: enable ≠ disable; …`. */
export function describeConflicts(conflicts) {
  // A layout item can be a whole code block: shown truncated, compared in full.
  const show = (xs) => xs.map((x) => (x.length > 72 ? `${x.slice(0, 71)}…` : x)).join(" ") || "∅";
  return conflicts.map((c) => `${c.kind}: ${show(c.a)} ≠ ${show(c.b)}`).join("; ");
}
