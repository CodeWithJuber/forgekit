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

// ---------------------------------------------------------------------------------------
// Literals (review N01 round 2). A quoted span is compared WHOLE and verbatim — its inner
// whitespace, case and code points are data. Quotes are found by a linear scanner, not a
// regex: ASCII `"`/`'` (one line; a `'` between two letters is an apostrophe — `Don't` opens
// nothing), backtick runs (`x`, ``x``: the closer is a run of the same length), and the
// typographic pairs (“…”, ‘…’, «…», „…“, 「…」, 『…』, ＂…＂, ‹…›, 《…》). A failed search
// is remembered, so no stretch of text is scanned twice for the same closer.
// ---------------------------------------------------------------------------------------

const TYPO_CLOSERS = new Map([
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
  ["„", "“”"],
  ["‚", "‘’"],
  ["「", "」"],
  ["『", "』"],
  ["＂", "＂"],
  ["‹", "›"],
  ["《", "》"],
]);
const WORDISH = /[\p{L}\p{N}_]/u;
const wordAt = (s, i) => i >= 0 && i < s.length && WORDISH.test(s[i]);

/**
 * Every quoted literal in `s`, in document order, as [start, end) offsets.
 * @param {string} s
 * @returns {[number, number][]}
 */
export function literalSpans(s) {
  /** @type {[number, number][]} */
  const spans = [];
  const n = s.length;
  /** @type {Map<string, number>} closer kind → offset up to which none exists */
  const none = new Map();
  let i = 0;
  const failed = (kind, upTo) => {
    none.set(kind, upTo);
    i += 1;
  };
  while (i < n) {
    const c = s[i];
    if ((c === '"' || c === "'") && !wordAt(s, i - 1)) {
      let eol = s.indexOf("\n", i);
      if (eol < 0) eol = n;
      if ((none.get(c) ?? -1) >= eol) {
        i += 1;
        continue;
      }
      let end = -1;
      for (let j = i + 1; j < eol; j++) {
        if (s[j] === "\\") j += 1;
        else if (s[j] === c && !(c === "'" && wordAt(s, j - 1) && wordAt(s, j + 1))) {
          end = j + 1;
          break;
        }
      }
      if (end < 0) failed(c, eol);
      else {
        spans.push([i, end]);
        i = end;
      }
      continue;
    }
    if (c === "`") {
      let k = i;
      while (k < n && s[k] === "`") k += 1;
      const kind = `\`${k - i}`;
      let end = -1;
      if ((none.get(kind) ?? -1) < n)
        for (let j = k; j < n; ) {
          if (s[j] !== "`") {
            j += 1;
            continue;
          }
          let m = j;
          while (m < n && s[m] === "`") m += 1;
          if (m - j === k - i) {
            end = m;
            break;
          }
          j = m;
        }
      if (end < 0) {
        none.set(kind, n);
        i = k;
      } else {
        spans.push([i, end]);
        i = end;
      }
      continue;
    }
    const closers = TYPO_CLOSERS.get(c);
    if (closers) {
      if ((none.get(c) ?? -1) >= n) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < n && !closers.includes(s[j])) j += 1;
      if (j >= n) failed(c, n);
      else {
        spans.push([i, j + 1]);
        i = j + 1;
      }
      continue;
    }
    i += 1;
  }
  return spans;
}

// ---------------------------------------------------------------------------------------
// Layout — whitespace that can be DATA (review N01, then round 2). Similarity is layout-blind
// by design, but whitespace is structure (Python and YAML indentation, a Makefile tab, a line
// break that separates two shell commands, `return\n{`), fixed-width columns are data, and a
// CRLF is not an LF. So every fenced block is compared verbatim, and so is EVERY whitespace
// run other than a single ASCII space — newlines, tabs, indentation, double spaces, a no-break
// space — each with its neighbouring tokens, in document order. Only the text's own leading
// and trailing whitespace is ignored. (Whitespace inside a quoted literal is that literal's.)
// ---------------------------------------------------------------------------------------

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const LIT = ""; // a masked literal: one code point, never whitespace or a symbol
const FENCE = ""; // a masked fenced block

/** Split a text into its fenced blocks (verbatim) and the rest, with each block replaced by
 *  one FENCE mark so its neighbours stay stable. */
function splitFences(text) {
  const fences = [];
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
        fences.push(block.join("\n"));
        fence = "";
      }
    } else if (m) {
      fence = m[1];
      block = [line];
      rest.push(FENCE);
    } else rest.push(line);
  }
  if (fence) fences.push(block.join("\n")); // unclosed: code to the end
  return { fences, rest: rest.join("\n") };
}

/** `s` with every literal replaced by one LIT mark, and the literals themselves. */
function maskLiterals(s) {
  const literals = [];
  let out = "";
  let at = 0;
  for (const [a, b] of literalSpans(s)) {
    literals.push(s.slice(a, b));
    out += s.slice(at, a) + LIT;
    at = b;
  }
  return { literals, masked: out + s.slice(at) };
}

/** Whitespace runs other than one ASCII space, with their neighbours, in document order. */
function whitespaceItems(masked) {
  const out = [];
  const parts = masked.trim().split(/(\s+)/u);
  for (let i = 1; i + 1 < parts.length; i += 2)
    if (parts[i] !== " ")
      out.push(`space ${JSON.stringify(`${parts[i - 1]}${parts[i]}${parts[i + 1]}`)}`);
  return out;
}

/**
 * The layout features of a text: every fenced block verbatim, then every whitespace run
 * other than a single space, with its neighbours — in document order, JSON-quoted so the
 * whitespace is visible.
 * @param {string} text
 * @returns {string[]}
 */
export function layoutFeatures(text) {
  const { fences, rest } = splitFences(text);
  return [
    ...fences.map((f) => `fence ${JSON.stringify(f)}`),
    ...whitespaceItems(maskLiterals(rest).masked),
  ];
}

// ---------------------------------------------------------------------------------------
// Symbols (review N01 round 2): `x + 1` and `x - 1`, `+=` and `-=`, `i++` and `i--`, `&` and
// `|` score as one text to every similarity measure. Every run of symbol characters is a
// feature, in document order — except prose punctuation: a trailing `.` `,` `;` `:` `!` `?`
// `…` before whitespace or the end, a free-standing dash between spaces, and a hyphen or
// apostrophe inside a word (`well-known`, `don't`).
// ---------------------------------------------------------------------------------------

const SYMBOL_CHAR = /[^\p{L}\p{M}\p{N}_\s\p{Cf}\ue000\ue001]/u;
const PROSE_TAIL = new Set([...".,;:…"]);
const OPERATOR_CHAR = /[-+*/%&|^~!=<>?:]/;
const WORD_OR_LIT = /[\p{L}\p{N}_\ue000]/u;

/** The word (or literal mark) next to offset `i` in direction `step`, across spaces. */
function neighbour(cps, i, step) {
  let k = i;
  while (k >= 0 && k < cps.length && /\s/u.test(cps[k])) k += step;
  const out = [];
  while (k >= 0 && k < cps.length && WORD_OR_LIT.test(cps[k]) && out.length < 40) {
    out.push(cps[k]);
    k += step;
  }
  return (step < 0 ? out.reverse() : out).join("").replaceAll(LIT, "⟨lit⟩");
}

/** Symbol runs in document order; an operator is recorded with its operands (`a - b` is not
 *  `b - a`). Prose punctuation is not a symbol: a trailing `.` `,` `;` `:` `…` after a word
 *  (before whitespace or the end), a hyphen or apostrophe inside a word, and a free-standing
 *  dash between two words (an en/em dash always; `-` only between words of two or more
 *  letters — `x - 1` is a minus). `!` and `?` stay: `save!` is not `save`.
 *  @param {string} masked text with literals and fences masked */
function symbolRuns(masked) {
  const out = [];
  const cps = [...masked];
  const n = cps.length;
  for (let i = 0; i < n; ) {
    if (!SYMBOL_CHAR.test(cps[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && SYMBOL_CHAR.test(cps[j])) j += 1;
    let run = cps.slice(i, j);
    const before = i > 0 ? cps[i - 1] : " ";
    const after = j < n ? cps[j] : " ";
    const spaceBefore = /\s/u.test(before);
    const spaceAfter = /\s/u.test(after);
    if (WORD_OR_LIT.test(before) || /[)\]}]/.test(before))
      if (spaceAfter || j === n) {
        let k = run.length;
        while (k > 0 && PROSE_TAIL.has(run[k - 1])) k -= 1;
        run = run.slice(0, k);
      }
    const s = run.join("");
    const inWord = WORDISH.test(before) && WORDISH.test(after) && /^[-'’]$/.test(s);
    const left = neighbour(cps, i - 1, -1);
    const right = neighbour(cps, j, 1);
    const proseDash =
      spaceBefore &&
      spaceAfter &&
      (/^[–—]$/.test(s) || (s === "-" && /^\p{L}{2,}$/u.test(left) && /^\p{L}{2,}$/u.test(right)));
    if (s && !inWord && !proseDash) out.push(OPERATOR_CHAR.test(s) ? `${left} ${s} ${right}` : s);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Spelling (review N01 round 2): `named parse` vs `named Parse`, fullwidth `ｐａｒｓｅ`, a
// Cyrillic `а` inside `hаndler`, a zero-width joiner at a word's edge — the same word to a
// reader, a different name to a program. Two words whose SKELETON matches (NFKC, format
// characters removed, common Cyrillic/Greek look-alikes mapped to Latin, lower case) but
// whose code points differ are a conflict. A capital at the start of a sentence is grammar,
// not spelling, and is exempt.
// ---------------------------------------------------------------------------------------

// Cyrillic and Greek letters that render as Latin ones (a practical subset of Unicode's
// confusables): a word that uses one where the other text has the Latin letter is flagged.
const CONFUSABLE = new Map(
  (
    "\u0430a \u0435e \u043eo \u0440p \u0441c \u0443y \u0445x \u0456i \u0458j \u0455s \u0501d " +
    "\u04cfl \u051bq \u051dw \u0261g \u0410A \u0412B \u0415E \u041aK \u041cM \u041dH " +
    "\u041eO \u0420P \u0421C \u0422T \u0425X \u0423Y \u0406I \u0408J \u0405S \u0391A " +
    "\u0392B \u0395E \u0396Z \u0397H \u0399I \u039aK \u039cM \u039dN \u039fO \u03a1P " +
    "\u03a4T \u03a5Y \u03a7X \u03b1a \u03bfo \u03c1p \u03bdv \u03b9i \u03bak \u03c7x \u03c5u"
  )
    .split(" ")
    .map((pair) => /** @type {[string, string]} */ ([...pair])),
);
const FORMAT_RE = /\p{Cf}/gu;
const skeleton = (w) =>
  [...w.normalize("NFKC").replace(FORMAT_RE, "")]
    .map((ch) => CONFUSABLE.get(ch) ?? ch)
    .join("")
    .toLowerCase();

/** Word tokens (letters, digits, marks, format characters) with a sentence-start flag. */
function wordsOf(masked) {
  const out = [];
  let start = true;
  for (const m of masked.matchAll(/[\p{L}\p{M}\p{N}_\p{Cf}]+|[.!?]+|\S/gu)) {
    const t = m[0];
    if (/^[.!?]+$/.test(t)) {
      start = true;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(t)) {
      out.push({ raw: t, start });
      start = false;
    } else if (!/^[\s"'“”‘’«»([{]$/u.test(t)) start = false;
  }
  return out;
}

/** skeleton → the set of spellings a text uses for it (sentence-start capitals folded). */
function spellingsOf(masked) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  for (const { raw, start } of wordsOf(masked)) {
    const cps = [...raw];
    const shown =
      start && /^\p{Lu}$/u.test(cps[0]) && cps.slice(1).every((ch) => !/\p{Lu}/u.test(ch))
        ? cps[0].toLowerCase() + cps.slice(1).join("")
        : raw;
    const key = skeleton(raw);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)?.add(shown);
  }
  return map;
}

/**
 * The behaviour-carrying features of a text, each in DOCUMENT ORDER (review N01 round 2:
 * sorted lists made `a - b` and `b - a`, or two swapped indented lines, the same text).
 * @param {string} text
 * @returns {{operators: string[], numbers: string[], literals: string[],
 *   identifiers: string[], paths: string[], polarity: string[], layout: string[],
 *   symbols: string[], format: string[]}}
 */
export function criticalFeatures(text) {
  const s = String(text ?? "");
  const { fences, rest } = splitFences(s);
  // Literals are compared whole; they are masked before the rest is scanned so a quoted ">="
  // or a quoted word never double-counts as an operator or a polarity word.
  const { literals, masked } = maskLiterals(rest);
  const plain = masked.replaceAll(LIT, " ").replaceAll(FENCE, " ");
  const operators = plain.match(OPERATOR_RE) ?? [];
  const numbers = (plain.match(NUMBER_RE) ?? []).map((n) =>
    n.toLowerCase().replace(/\s+/g, "").replace(/_/g, ""),
  );
  const identifiers = [];
  const paths = [];
  const polarity = [];
  for (const raw of plain.split(/\s+/)) {
    // edge punctuation only — inner punctuation (dots, underscores, slashes) is identity
    const tok = trimEdges(raw);
    if (!tok) continue;
    if (PATH_RE.test(tok) && /[\p{L}\p{N}]/u.test(tok)) paths.push(tok);
    else if (IDENT_RE.test(tok)) identifiers.push(tok);
    const word = tok.toLowerCase();
    if (NEGATORS.has(word) || NEGATED_CONTRACTION.test(word) || POLE_WORDS.has(word))
      polarity.push(word);
  }
  // Format characters (zero-width space/joiner, bidi controls…) are invisible and change a
  // name: each token holding any is a feature, with the code points it holds.
  const format = [];
  for (const tok of masked.split(/\s+/u)) {
    const cf = tok.match(FORMAT_RE);
    if (cf)
      format.push(
        `${cf.map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ")} in ${JSON.stringify(tok)}`,
      );
  }
  return {
    operators,
    numbers,
    literals,
    identifiers,
    paths,
    polarity: sorted(polarity),
    layout: [...fences.map((f) => `fence ${JSON.stringify(f)}`), ...whitespaceItems(masked)],
    symbols: symbolRuns(masked),
    format,
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
  "symbols",
  "spelling",
  "format",
]);
export const FLIP_KINDS = /** @type {const} */ ([
  "polarity",
  "operators",
  "numbers",
  "literals",
  "symbols",
]);

/**
 * Every feature class on which two texts disagree — empty when they carry the same
 * behaviour-bearing tokens in the same order. Each conflict names the class and what each
 * side has that the other lacks; a pair with the same tokens in a different order is marked
 * `order: true` and shows both sequences.
 * @param {string} a
 * @param {string} b
 * @param {{kinds?: readonly string[]}} [opts] restrict to these feature classes
 * @returns {{kind: string, a: string[], b: string[], order?: boolean}[]}
 */
export function semanticConflicts(a, b, { kinds = ALL_KINDS } = {}) {
  const fa = criticalFeatures(a);
  const fb = criticalFeatures(b);
  const out = [];
  for (const kind of kinds) {
    if (kind === "spelling") {
      const sa = spellingsOf(maskLiterals(splitFences(a).rest).masked);
      const sb = spellingsOf(maskLiterals(splitFences(b).rest).masked);
      const onlyA = [];
      const onlyB = [];
      for (const [key, forms] of sa) {
        const other = sb.get(key);
        if (!other) continue;
        for (const f of forms) if (!other.has(f)) onlyA.push(f);
        for (const f of other) if (!forms.has(f)) onlyB.push(f);
      }
      if (onlyA.length || onlyB.length) out.push({ kind, a: onlyA, b: onlyB });
      continue;
    }
    const [xa, xb] = [fa[kind] ?? [], fb[kind] ?? []];
    if (kind === "polarity" ? !polarityFlip(xa, xb) : sameList(xa, xb)) continue;
    if (kind !== "polarity" && sameList(sorted(xa), sorted(xb))) {
      out.push({ kind, a: xa, b: xb, order: true });
      continue;
    }
    const onlyA = xa.filter((x) => !xb.includes(x));
    const onlyB = xb.filter((x) => !xa.includes(x));
    out.push({ kind, a: onlyA.length ? onlyA : xa, b: onlyB.length ? onlyB : xb });
  }
  return out;
}

/** True when neither text changes polarity, operators, numbers, literals, identifiers,
 *  paths, symbols, spelling, format characters or layout relative to the other, in content or
 *  order. Similar-and-conflicting texts are NOT the same instruction.
 *  @param {string} a @param {string} b @param {{kinds?: readonly string[]}} [opts] */
export const sameSemantics = (a, b, opts) => semanticConflicts(a, b, opts).length === 0;

/** The exact-duplicate key of a statement (review N02, then round 2): the text as written,
 *  less its own leading/trailing whitespace and ONE sentence-ending period after a plain
 *  word. Nothing else is folded — not whitespace inside it (a double space, a tab, a line
 *  break can be data), not `!` or `;` (`save!` is not `save`), not a run of dots (`./...` is
 *  not `./`), not case. */
export const statementKey = (s) => {
  const t = String(s ?? "").trim();
  if (!t.endsWith(".") || t.endsWith("..")) return t;
  let k = t.length - 1;
  while (k > 0 && WORDISH.test(t[k - 1])) k -= 1;
  const word = t.slice(k, t.length - 1);
  const edge = k === 0 || /\s/u.test(t[k - 1]);
  return word && edge && /^[\p{L}\p{N}]+$/u.test(word) ? t.slice(0, -1) : t;
};

/**
 * The SAME statement, not a similar one (review N02): equal statement keys, with the guard
 * confirming no behaviour-bearing difference hid in what the key forgives. The only equality
 * that may merge or archive a rule automatically. Similarity — lexical or embedded — can
 * only PROPOSE: "allow admins, deny guests" and "deny admins, allow guests" keep every
 * token, polarity words included, so no token-level check separates them.
 * @param {string} a @param {string} b
 */
export const sameStatement = (a, b) => statementKey(a) === statementKey(b) && sameSemantics(a, b);

/** One-line human description of a conflict list: `polarity: enable ≠ disable; …`. */
export function describeConflicts(conflicts) {
  // A layout item can be a whole code block: shown truncated, compared in full.
  const show = (xs) => xs.map((x) => (x.length > 72 ? `${x.slice(0, 71)}…` : x)).join(" ") || "∅";
  return conflicts
    .map((c) => `${c.kind}${c.order ? " (order)" : ""}: ${show(c.a)} ≠ ${show(c.b)}`)
    .join("; ");
}
