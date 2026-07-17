// forge math — dependency-free numeric primitives that back decision code.
// Forge's rule for heuristics: DATA may be a table (exemplars, oracle weights,
// policy lists) but DECISIONS must be a formula — graded, inspectable, testable.
// The similarity family (shingles/sketch/jaccard) lives in ledger.js; the decay/
// posterior family in lessons.js/ledger.js; this module holds the two primitives
// that had no home: entropy (secret detection) and the overlap coefficient
// (task↔exemplar and keyword matching, where MinHash estimation is unnecessary).

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
 * Overlap coefficient of two Sets: |A∩B| / min(|A|,|B|). Either empty → 0.
 * Containment-friendly where Jaccard is size-penalized: a short exemplar fully
 * contained in a long task scores 1.0 — the right semantics for "does this text
 * exhibit that exemplar's concept" (task↔exemplar matching in route.js).
 * @param {Set<unknown>} a
 * @param {Set<unknown>} b
 * @returns {number} 0..1
 */
export function setOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / small.size;
}

/** Character-bigram set of a string — the token space for fuzzy name matching. */
function bigrams(s) {
  const t = String(s ?? "").toLowerCase();
  const out = new Set();
  if (t.length === 1) out.add(t);
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * Nearest candidate to `name` by character-bigram overlap (the same setOverlap the
 * router/intent k-NN uses), or null when nothing clears `floor`. Powers "did you mean"
 * on an unknown command without a new dependency or algorithm.
 * @param {string} name the mistyped token
 * @param {Iterable<string>} candidates the known good names
 * @param {number} [floor] minimum overlap to suggest (default 0.4)
 * @returns {string|null}
 */
export function suggest(name, candidates, floor = 0.4) {
  const b = bigrams(name);
  if (!b.size) return null;
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = setOverlap(b, bigrams(c));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= floor ? best : null;
}
