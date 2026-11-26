// Text and term utilities for the replay engine: tokens, generalization of token sequences,
// matching with slot capture, and a small type lattice for slot values.

const EDGE = /^[\s"'`([{]+|[\s"'`)\]}.,!?;:]+$/gu;

/** Whitespace tokens with surrounding quotes and sentence punctuation removed. */
export function words(text) {
  return String(text)
    .trim()
    .split(/\s+/u)
    .map((t) => t.replace(EDGE, ""))
    .filter(Boolean);
}

/** Lossless fine tokens: runs of letters, digits and underscore, or one other character. */
export function fine(text) {
  return String(text).match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]/gu) ?? [];
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** A pattern is a list of { c: constant } and { v: slotIndex } items. */
export function patternOf(tokens) {
  return tokens.map((t) => ({ c: t.toLowerCase() }));
}

/**
 * Generalize a pattern so that it also covers `tokens`: keep a longest common subsequence of
 * constants, and turn everything between kept constants into one slot. Sequence generalization has
 * no unique least general result, so this is a deterministic choice, checked afterwards by
 * requiring every example to match with exactly one binding.
 */
export function generalize(pattern, tokens) {
  const n = pattern.length;
  const m = tokens.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const hit = pattern[i].c !== undefined && same(pattern[i].c, tokens[j]);
      L[i][j] = hit ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  const out = [];
  let gap = false;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (gap) out.push({ v: 0 });
    gap = false;
  };
  while (i < n && j < m) {
    if (
      pattern[i].c !== undefined &&
      same(pattern[i].c, tokens[j]) &&
      L[i][j] === L[i + 1][j + 1] + 1
    ) {
      flush();
      out.push({ c: pattern[i].c });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      gap = true;
      i++;
    } else {
      gap = true;
      j++;
    }
  }
  if (i < n || j < m) gap = true;
  flush();
  let next = 0;
  return out.map((item) => (item.c !== undefined ? item : { v: next++ }));
}

export function slotCount(pattern) {
  return pattern.filter((item) => item.v !== undefined).length;
}

export function constantCount(pattern) {
  return pattern.length - slotCount(pattern);
}

/**
 * All ways `tokens` is an instance of `pattern`, up to `limit`. A slot captures zero or more
 * tokens, returned joined by one space. More than one result means the reading is ambiguous.
 */
export function matchPattern(pattern, tokens, limit = 2) {
  const results = [];
  const dead = new Set();
  const current = [];
  const walk = (i, j) => {
    if (results.length >= limit) return true;
    const key = i * (tokens.length + 1) + j;
    if (dead.has(key)) return false;
    if (i === pattern.length) {
      if (j !== tokens.length) return false;
      results.push(current.slice());
      return true;
    }
    const item = pattern[i];
    let found = false;
    if (item.c !== undefined) {
      if (j < tokens.length && same(item.c, tokens[j])) found = walk(i + 1, j + 1);
    } else {
      for (let end = j; end <= tokens.length; end++) {
        current.push(tokens.slice(j, end).join(" "));
        if (walk(i + 1, end)) found = true;
        current.pop();
        if (results.length >= limit) break;
      }
    }
    if (!found) dead.add(key);
    return found;
  };
  walk(0, 0);
  return results;
}

// Slot value classes, ordered: digits <= alnum, alpha <= alnum, alnum <= ident, ident <= text.
/** @type {[string, RegExp][]} */
const CLASSES = [
  ["digits", /^\p{N}+$/u],
  ["alpha", /^\p{L}+$/u],
  ["alnum", /^[\p{L}\p{N}]+$/u],
  ["ident", /^[\p{L}\p{N}_.\-/:@]+$/u],
];
const RANK = { digits: 1, alpha: 1, alnum: 2, ident: 3, text: 4 };

export function classOf(token) {
  for (const [name, re] of CLASSES) if (re.test(token)) return name;
  return "text";
}

export function joinClass(a, b) {
  if (a === b) return a;
  const top = Math.max(RANK[a], RANK[b]);
  if (top === 1) return "alnum"; // digits with alpha
  return top === 2 ? "alnum" : top === 3 ? "ident" : "text";
}

function within(cls, type) {
  return cls === type || RANK[cls] < RANK[type];
}

/** Type of a slot from the values it was seen with: token class and token-count range. */
export function typeOf(values) {
  let cls = null;
  let min = Infinity;
  let max = 0;
  for (const value of values) {
    const toks = value === "" ? [] : value.split(" ");
    min = Math.min(min, toks.length);
    max = Math.max(max, toks.length);
    for (const t of toks) cls = cls === null ? classOf(t) : joinClass(cls, classOf(t));
  }
  return { cls: cls ?? "text", min, max };
}

export function accepts(type, value) {
  const toks = value === "" ? [] : value.split(" ");
  if (toks.length < type.min || toks.length > type.max) return false;
  return toks.every((t) => within(classOf(t), type.cls));
}

/** Scalar leaves of a JSON value in a canonical order, with their paths. */
export function flatten(value, path = [], out = []) {
  if (Array.isArray(value)) {
    if (!value.length) out.push({ path, kind: "A0", v: [] });
    for (let i = 0; i < value.length; i++) flatten(value[i], [...path, i], out);
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (!keys.length) out.push({ path, kind: "O0", v: {} });
    for (const k of keys) flatten(value[k], [...path, k], out);
  } else {
    const kind =
      value === null
        ? "z"
        : typeof value === "string"
          ? "s"
          : typeof value === "number"
            ? "n"
            : "b";
    out.push({ path, kind, v: value });
  }
  return out;
}

export function unflatten(leaves) {
  if (leaves.length === 1 && leaves[0].path.length === 0) return leaves[0].v;
  const root = typeof leaves[0].path[0] === "number" ? [] : {};
  for (const { path, v } of leaves) {
    let at = root;
    for (let i = 0; i < path.length - 1; i++) {
      if (at[path[i]] === undefined) at[path[i]] = typeof path[i + 1] === "number" ? [] : {};
      at = at[path[i]];
    }
    at[path[path.length - 1]] = v;
  }
  return root;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function shapeKey(step) {
  return JSON.stringify([step.tool, flatten(step.args ?? {}).map((l) => [l.path, l.kind])]);
}

/** Character-trigram cosine. A cheap proposer of related families. It never authorizes a replay. */
export function trigramCosine(a, b) {
  const grams = (text) => {
    const s = `  ${words(text).join(" ").toLowerCase()}  `;
    const bag = new Map();
    for (let i = 0; i + 3 <= s.length; i++)
      bag.set(s.slice(i, i + 3), (bag.get(s.slice(i, i + 3)) ?? 0) + 1);
    return bag;
  };
  const x = grams(a);
  const y = grams(b);
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (const [g, c] of x) {
    nx += c * c;
    dot += c * (y.get(g) ?? 0);
  }
  for (const c of y.values()) ny += c * c;
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}
