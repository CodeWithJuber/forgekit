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
// (case kept), and polarity/negation words. A false conflict costs a human glance; a missed
// one serves or keeps the opposite rule. Pure — no I/O.

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

/**
 * The behaviour-carrying features of a text.
 * @param {string} text
 * @returns {{operators: string[], numbers: string[], literals: string[],
 *   identifiers: string[], paths: string[], polarity: string[]}}
 */
export function criticalFeatures(text) {
  const s = String(text ?? "").normalize("NFC");
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
    const tok = raw.replace(/^[^\p{L}\p{N}_$./\\]+|[^\p{L}\p{N}_$/\\]+$/gu, "");
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

/** True when neither text changes polarity, operators, numbers, literals, identifiers or
 *  paths relative to the other. Similar-and-conflicting texts are NOT the same instruction.
 *  @param {string} a @param {string} b @param {{kinds?: readonly string[]}} [opts] */
export const sameSemantics = (a, b, opts) => semanticConflicts(a, b, opts).length === 0;

/** One-line human description of a conflict list: `polarity: enable ≠ disable; …`. */
export function describeConflicts(conflicts) {
  return conflicts
    .map((c) => `${c.kind}: ${c.a.join(" ") || "∅"} ≠ ${c.b.join(" ") || "∅"}`)
    .join("; ");
}
