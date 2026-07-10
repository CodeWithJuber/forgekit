// forge math — dependency-free numeric primitives that back decision code.
// Forge's rule for heuristics: DATA may be a table (exemplars, oracle weights,
// policy lists) but DECISIONS must be a formula — graded, inspectable, testable.
// The similarity family (shingles/sketch/jaccard) lives in ledger.js; the decay/
// posterior family in lessons.js/ledger.js; this module holds the primitives that
// had no home: entropy (secret detection) and exact set overlap (small-set
// similarity, where MinHash estimation is unnecessary).

/**
 * Shannon entropy of a string in bits per character (code points). Empty → 0.
 * Random base64/hex credentials sit near their alphabet ceiling (~6/4 bits);
 * English prose sits near 3.5–4.5 with far lower per-token entropy — the gap is
 * what makes entropy a usable secret signal where format lists have no entry.
 * @param {string} s
 * @returns {number}
 */
export function shannonEntropy(s) {
  const counts = new Map();
  let n = 0;
  for (const ch of String(s)) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    n++;
  }
  if (!n) return 0;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Number of character classes present (lowercase, uppercase, digit, other) — a
 * cheap charset-diversity signal: machine-generated tokens mix classes, natural
 * words rarely use more than two.
 * @param {string} s
 * @returns {number} 0..4
 */
export function charsetClasses(s) {
  const str = String(s);
  let classes = 0;
  if (/[a-z]/.test(str)) classes++;
  if (/[A-Z]/.test(str)) classes++;
  if (/[0-9]/.test(str)) classes++;
  if (/[^a-zA-Z0-9]/.test(str)) classes++;
  return classes;
}

/**
 * Exact Jaccard similarity of two Sets: |A∩B| / |A∪B|. Both empty → 0.
 * For small sets (task shingles vs an exemplar) this is exact and cheaper than
 * the MinHash estimate in ledger.js, which exists for scale.
 * @param {Set<unknown>} a
 * @param {Set<unknown>} b
 * @returns {number} 0..1
 */
export function setJaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
