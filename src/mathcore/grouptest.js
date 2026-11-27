// Merge-queue batch size as a group-testing problem (Dorfman 1943).
// Model: each queued change breaks the build on the current base independently with probability
// p, and a batch build fails exactly when it contains at least one breaking change. Interactions
// between individually good changes are outside this model and are caught by the combined check.

/** Builds per change for "build the batch, on failure build each change alone". */
export function dorfmanPerItem(b, p) {
  if (!Number.isInteger(b) || b < 1) throw new Error("batch size must be a positive integer");
  if (!(p >= 0 && p <= 1)) throw new Error("need 0 <= p <= 1");
  return b === 1 ? 1 : 1 / b + 1 - (1 - p) ** b;
}

/**
 * Expected builds to classify a batch of size b by halving: build the batch, on failure build the
 * left half; if the left half passes the right half is known to contain a breaking change.
 * U(b) = 1 + (1 - q^b) A(b), where A(b) is the expected extra builds given at least one breaker:
 * A(1) = 0, A(b) = 1 + [(1 - q^l)(A(l) + U(r)) + q^l (1 - q^r) A(r)] / (1 - q^b), l = floor(b/2).
 */
export function halvingExpected(b, p) {
  if (!Number.isInteger(b) || b < 1) throw new Error("batch size must be a positive integer");
  if (!(p >= 0 && p <= 1)) throw new Error("need 0 <= p <= 1");
  const q = 1 - p;
  const A = new Map();
  const U = new Map();
  const known = (n) => {
    if (n === 1) return 0;
    if (A.has(n)) return A.get(n);
    const l = Math.floor(n / 2);
    const r = n - l;
    const bad = 1 - q ** n;
    const value =
      bad === 0
        ? 0
        : 1 + ((1 - q ** l) * (known(l) + unknown(r)) + q ** l * (1 - q ** r) * known(r)) / bad;
    A.set(n, value);
    return value;
  };
  const unknown = (n) => {
    if (U.has(n)) return U.get(n);
    const value = 1 + (1 - q ** n) * known(n);
    U.set(n, value);
    return value;
  };
  return unknown(b);
}

/** The same halving procedure executed on one concrete pattern. Used as the test oracle. */
export function halvingBuilds(bits) {
  const anyBad = (xs) => xs.some(Boolean);
  const known = (xs) => {
    if (xs.length === 1) return 0;
    const l = Math.floor(xs.length / 2);
    const left = xs.slice(0, l);
    const right = xs.slice(l);
    return 1 + (anyBad(left) ? known(left) + unknown(right) : known(right));
  };
  const unknown = (xs) => 1 + (anyBad(xs) ? known(xs) : 0);
  return unknown(bits);
}

/** Batch size minimizing expected builds per change. Ties go to the smaller batch. */
export function bestBatch(p, { max = 64, strategy = "halving" } = {}) {
  let best = { size: 1, perItem: 1 };
  for (let b = 2; b <= max; b++) {
    const perItem = strategy === "halving" ? halvingExpected(b, p) / b : dorfmanPerItem(b, p);
    if (perItem < best.perItem - 1e-12) best = { size: b, perItem };
  }
  return best;
}
