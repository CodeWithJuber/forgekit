// forge reuse — the proof-carrying code cache (docs/plans/substrate-v2/03-reuse-cache.md).
// Verified artifacts become ledger claims keyed by a normalized task fingerprint;
// before generating, ask "have we (or a teammate) already built this?". A hit is
// served ONLY while its proof holds: confidence above the floor (evidence-earned,
// never asserted) AND its dependencies still resolving in the atlas — stale or
// discredited code silently stops being served, because the cache is pruned by
// ground truth, not by an LRU.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { has as atlasHas, indexedText } from "./atlas.js";
import { claimSim, simLabel } from "./embed.js";
import {
  isDormant,
  jaccard,
  mintClaim,
  outcomeRecord,
  SKETCH_K,
  sketch,
  storesVerbatim,
  val,
} from "./ledger.js";
import { appendEvidence, loadClaims, putClaim, readEvidence, repoLedger } from "./ledger_store.js";
import { record as recordMetric } from "./metrics.js";
import {
  jsImports,
  lexOf,
  loadPathAliases,
  maskCode,
  pyImports,
  pyModuleIndex,
  resolvePyImport,
  resolveSpec,
} from "./scope.js";
import { describeConflicts, semanticConflicts } from "./semantic_guard.js";
import { contentHash, gitAuthor } from "./util.js";

/** Serving floor: an artifact is reused only when independent oracles have earned it
 *  past this (a fresh, unverified mint sits at the 0.5 prior and does NOT serve —
 *  proof-carrying means the proof comes first). */
export const SERVE_FLOOR = 0.6;
/** Jaccard thresholds for the lookup ladder. */
export const NEAR_J = 0.8;
export const ADAPT_J = 0.6;
/** Cosine thresholds when the optional embedding sim (FORGE_EMBED) is active. They sit
 *  HIGHER than the Jaccard bars because the scales have different noise floors:
 *  Jaccard over 4-token shingles is ≈0 for unrelated specs, so 0.8/0.6 are far above
 *  noise — but dense embedding cosines routinely land at 0.4–0.6 for unrelated
 *  sentences in the same domain (vectors share background components). Reusing 0.8/0.6
 *  would over-serve; 0.85/0.7 keeps precision comparable to the MinHash ladder. */
export const NEAR_COS = 0.85;
export const ADAPT_COS = 0.7;

// ---------------------------------------------------------------------------
// Identity and normalization — the same neighbourhood, the same instruction and the same
// task are different questions (review C9, F04, then N01):
//   • specDigest (EXACT IDENTITY) — NO normalization at all: a digest of the spec's code
//     units. The v2 key still collapsed whitespace and folded Unicode NFC, so `return "a  b"`
//     and `return "a b"` shared one key and an exact hit served the two-space string for a
//     one-space request (review N01). Whitespace inside a literal is data, indentation is
//     structure (Python, YAML, a Makefile tab), a regex's spaces are its pattern, and composed
//     and decomposed Unicode are different strings to a program — no rewrite, however
//     "harmless", may sit at the as-is boundary. Stored as hex (`body.keyHash`), which the
//     ledger's own NFC/LF canonicalization of claim text cannot fold.
//   • specKey (IDENTITY TEXT) — the spec as given: what the near tier sketches (the sketch is
//     whitespace- and case-insensitive by construction) and the semantic guard compares.
//   • normalizeSpec (SHAPE) — volatile literals and identifiers become typed placeholders,
//     so specs that differ only in those still land in one near-NEIGHBOURHOOD and the adapt
//     tier can offer the artifact as a verified starting point ("generate only the delta").
// Similarity (the near tier's MinHash over the identity text, or an embedding cosine) finds
// NEIGHBOURS; it never by itself authorizes serving code as-is: a near candidate must also
// pass the semantic guard (same operators, numbers, literals, identifiers, paths, polarity
// words and code layout), else it is only offered at the adapt tier, for review. So a spec
// that differs from a verified one only in whitespace reaches near at best — and not even
// that when the whitespace sits in a literal, a code block or beside a code token.
// The tokenizers are Unicode-aware: the ASCII `\w` trim erased every Arabic (or Chinese, or
// Greek) word, so any two non-ASCII specs normalized to "" and collided as exact.
// ---------------------------------------------------------------------------

/** The identity-key format version. v1 keys (pre-F04) were lossy; v2 (pre-N01) collapsed
 *  whitespace and folded NFC. Neither ever reaches the exact tier again. */
export const KEY_VERSION = 3;

const NUM_RE = /^-?\d[\d.,_]*$/;
const PATH_RE = /[\\/]|\.(?:m?[jt]sx?|py|go|rs|java|rb|json|ya?ml|toml|md|css|html)$/i;
const STR_RE = /^["'`].*["'`]$/;
// camelCase, PascalCase-with-inner-cap, snake_case (incl. SCREAMING_SNAKE), dotted.paths
// — code identifiers, not prose. A single ALLCAPS word (DESC, RATE, TODO) is treated as
// prose emphasis and lowercased: shouting is not an identifier. (SHAPE form only — the
// identity form keeps case, and the semantic guard treats ALLCAPS as identity.)
const IDENT_RE = /^(?:[a-z][a-z0-9]*[A-Z]|[A-Z][a-z0-9]+[A-Z]|\w+_\w+|\w+\.\w+)\w*$/;

// Trim leading/trailing punctuation while keeping what MAKES a token: letters, digits and
// marks of any script, plus the code punctuation the classifiers below key on.
const TRIM_RE = /^[^\p{L}\p{N}\p{M}_"'`./\\-]+|[^\p{L}\p{N}\p{M}_"'`./\\-]+$/gu;

/** The identity TEXT of a spec: the spec exactly as given (review N01). */
export function specKey(text) {
  return String(text ?? "");
}

/** The EXACT identity (review N01): sha256 over the spec's UTF-16 code units — lossless for
 *  every JS string, lone surrogates included, so two specs share it only when they are the
 *  same string. @param {unknown} text @returns {string} hex */
export function specDigest(text) {
  return createHash("sha256")
    .update(Buffer.from(String(text ?? ""), "utf16le"))
    .digest("hex");
}

/** Deterministic, pure spec SHAPE normalization (unit-tested surface). */
export function normalizeSpec(text) {
  return String(text)
    .split(/\s+/)
    .map((raw) => {
      const tok = raw.replace(TRIM_RE, "");
      if (!tok) return "";
      if (STR_RE.test(tok)) return "⟨str⟩";
      if (NUM_RE.test(tok)) return "⟨num⟩";
      if (PATH_RE.test(tok)) return "⟨path⟩";
      if (IDENT_RE.test(tok)) return "⟨ident⟩";
      return tok.toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

/** The cache keys: `digest` (the exact identity), `exact` (identity + graph-slice context),
 *  `keySketch` (what the near tier measures) and `sketch` (the shape form the adapt tier and
 *  the LSH prefilter use). */
export function fingerprint(spec, slice = "") {
  const norm = normalizeSpec(spec);
  const key = specKey(spec);
  const digest = specDigest(spec);
  return {
    norm,
    key,
    digest,
    exact: contentHash(`${digest}\u0000${slice}`),
    sketch: sketch(norm),
    keySketch: sketch(key),
  };
}

// ---------------------------------------------------------------------------
// LSH banding — 32 bands × 4 rows over the 128-lane sketch. Collision probability
// 1−(1−J⁴)³²: ≈1.00 at J=0.8, 0.99 at J=0.6 (the ADAPT bar), 0.56 at J=0.4, 0.23 at J=0.3.
// A prefilter that keeps essentially every real candidate while still pruning the unrelated
// mass (unrelated specs sit at J≈0). The old 16×8 banding was documented as "≈0.96 at J=0.8
// and ≈0.17 at J=0.5"; the true figures were 0.95 and 0.06, and at the adapt threshold
// J=0.6 recall was 0.24 — three of every four adapt-tier hits were silently dropped once a
// ledger passed 32 artifacts (review C9).
// ---------------------------------------------------------------------------

const BANDS = 32;
const ROWS = SKETCH_K / BANDS;

export function bandKeys(sk) {
  const keys = [];
  for (let b = 0; b < BANDS; b++)
    keys.push(`${b}:${contentHash(sk.slice(b * ROWS, (b + 1) * ROWS).join(",")).slice(0, 16)}`);
  return keys;
}

// ---------------------------------------------------------------------------
// Artifact claims
// ---------------------------------------------------------------------------

/**
 * Mint an artifact claim body. `code` is a verifiable pointer — {path, sha256} of the
 * committed file (or {inline} for snippets); `iface` = what it exports; `deps` = the
 * codebase symbols it requires (what revalidation checks); `form` = function/module/
 * component/config/test.
 * @returns {{ok:boolean, reason?:string, claim?:any}}
 */
export function artifactClaim(
  {
    spec,
    slice = "",
    iface = [],
    deps = [],
    depContracts = {},
    depSources = {},
    moduleDeps = {},
    code,
    lang = "",
    form = "function",
  },
  t = 0,
) {
  // The ledger stores claim text NFC- and LF-normalized. For inline CODE that is a silent
  // rewrite of the verified bytes (a CRLF inside a string literal, a decomposed "é"), so it
  // is refused, with the lossless alternative named (review N01).
  if (typeof code?.inline === "string" && !storesVerbatim(code.inline))
    return {
      ok: false,
      reason:
        "inline code has CRLF line endings or non-NFC Unicode, which the ledger's canonical storage would rewrite — mint it as a file pointer ({path, sha256}) so the verified bytes are the served bytes",
    };
  return mintClaim({
    kind: "artifact",
    body: {
      code: code ?? {},
      // name → fingerprint of the dependency's declaration at mint time (review F05/N08): a
      // dependency whose contract changed invalidates the artifact; `null` = not established
      // at mint (revalidation then says unknown, never valid). `depSources` pins the module
      // each name was imported from, so a same-name symbol elsewhere is never compared.
      ...(Object.keys(depContracts).length ? { depContracts: sortedObject(depContracts) } : {}),
      ...(Object.keys(depSources).length ? { depSources: sortedObject(depSources) } : {}),
      // module → content digest for what the code depends on as a WHOLE (a default or
      // namespace import, a require, a re-exporting module); `null` = unresolved at mint.
      ...(Object.keys(moduleDeps).length ? { moduleDeps: sortedObject(moduleDeps) } : {}),
      deps: [...deps].sort(),
      form,
      iface: [...iface].sort(),
      // `keyHash` is the exact identity (review N01), `key` the identity text the near tier
      // and the semantic guard read, `spec` the SHAPE form (adapt and the LSH prefilter). A
      // pre-C9 artifact has no key and can only reach adapt; a key from an older version
      // (keyV < 3) was lossy and never reaches exact.
      key: specKey(spec),
      keyHash: specDigest(spec),
      keyV: KEY_VERSION,
      // Whether `key` survives the ledger's canonical storage (NFC, LF) as written. When it
      // does not, the stored key is a folded copy the near tier cannot compare (review N01).
      keyVerbatim: storesVerbatim(specKey(spec)),
      lang,
      slice,
      spec: normalizeSpec(spec),
    },
    scope: { level: "repo" },
    provenance: { agent: "reuse", author: gitAuthor() },
    t,
  });
}

/**
 * Cache-fill: mint the artifact and attach its verification evidence in one step.
 * Without evidence the artifact sits at the 0.5 prior and will NOT serve — pass the
 * oracle result that proved it (a test run, a human accept).
 * @param {string} dir ledger directory
 * @param {object} fields artifactClaim fields
 * @param {{evidence?: {oracle:string, result:"confirm"|"contradict", ref:string}, t?: number}} [opts]
 * @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean, serves?:boolean}}
 */
export function mintArtifact(dir, fields, { evidence, t = 0 } = {}) {
  const minted = artifactClaim(fields, t);
  if (!minted.ok) return { ok: false, reason: minted.reason };
  const put = putClaim(dir, minted.claim);
  if (!put.ok) return put;
  if (evidence) {
    const o = outcomeRecord({ author: gitAuthor(), t, ...evidence });
    if (!o.ok) return { ok: false, reason: "reason" in o ? o.reason : "invalid evidence" };
    const a = appendEvidence(dir, minted.claim.id, o.outcome);
    if (!a.ok) return a;
  }
  // `serves` is what the proof actually earns, not "some evidence was passed": a ref forge
  // cannot resolve (`--ref lgtm`, `ci:1`) is recorded but capped below SERVE_FLOOR (C2).
  const serves = val({ evidence: readEvidence(dir, minted.claim.id) }, t) >= SERVE_FLOOR;
  return { ok: true, id: minted.claim.id, existed: put.existed, serves };
}

// ---------------------------------------------------------------------------
// The lookup ladder — pure over a claim list (store- and fs-free, fully testable).
// ---------------------------------------------------------------------------

const sortedObject = (o) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

// ---------------------------------------------------------------------------
// Dependency contracts (review F05, then N08). A caller relies on a dependency's DECLARATION —
// its name, parameters (destructured keys, defaults and nested patterns included), modifiers
// and annotations — so that is what is fingerprinted. The v1 scanner cut the declaration at
// its first `{` or `=>`, which for `function calc({a})` is the destructuring brace: both
// `calc({a})` and `calc({b})` hashed as `export function calc(`, and an artifact whose
// dependency changed its contract kept serving as valid. Now the declaration is read WHOLE
// (the atlas knows where each definition ends), lexed — comments dropped, whitespace between
// tokens ignored, string literals kept verbatim — and only the BODY is cut: the final
// top-level block of a function, what follows a top-level `=>`, what follows a Python `def`'s
// colon. A class, type or plain value has no body to cut: all of it is the contract. And the
// dependency is the definition the artifact's own import BINDS to (its module identity, from
// the atlas's structural import resolution), never whichever same-name symbol sorts first.
// Whatever cannot be established — an unknown extent, a name defined in several files with no
// import binding to choose one — is null: "unknown", so the hit requires revalidation.
// ---------------------------------------------------------------------------

/** The contract format. Contracts recorded in another format are never compared: unknown. */
export const CONTRACT_VERSION = 2;
const CONTRACT_PREFIX = `v${CONTRACT_VERSION}:`;

const IDENT_START = /[\p{L}\p{N}_$]/u;

/** Split source into contract tokens on its MASKED form (the lexer every structural reader
 *  shares, review N08): comments are dropped, whitespace between tokens is ignored, and a
 *  string, template or regex literal is one token holding its RAW source (whitespace and
 *  escapes included). A regex like `/[/*]/` is a literal, never the start of a comment.
 *  Deterministic on any input. @param {string} text @param {string} ext */
function contractTokens(text, ext) {
  const code = maskCode(text, ext);
  const lang = lexOf(ext);
  const toks = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const delim = lang === "py" && code.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const close = code.indexOf(delim, i + delim.length);
      // Masking blanked a literal's content: a quote whose run to the next one is not blank
      // was code (an apostrophe in JSX text), not a literal. A template may hold code (its
      // `${…}` parts) and runs to its closing backtick.
      if (close >= 0 && (c === "`" || !code.slice(i + delim.length, close).trim())) {
        toks.push(text.slice(i, close + delim.length));
        i = close + delim.length;
        continue;
      }
    }
    if (c === "/" && lang === "js") {
      const close = code.indexOf("/", i + 1);
      if (close > i + 1 && !code.slice(i + 1, close).trim() && text.slice(i + 1, close).trim()) {
        let j = close + 1;
        while (j < n && /[a-z]/i.test(code[j])) j += 1; // flags
        toks.push(text.slice(i, j));
        i = j;
        continue;
      }
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_START.test(code[j])) j += 1;
      toks.push(code.slice(i, j));
      i = j;
      continue;
    }
    const op = ["...", "=>", "->"].find((o) => code.startsWith(o, i)) ?? c;
    toks.push(op);
    i += op.length;
  }
  return toks;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const isIdent = (t) => typeof t === "string" && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(t);

/** Index of the token closing the bracket group opened at `from` (-1 when unbalanced). */
function groupEnd(toks, from) {
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    if (OPEN.has(toks[i])) depth += 1;
    else if (CLOSE.has(toks[i]) && --depth === 0) return i;
  }
  return -1;
}

/** The value's arrow in a `const` declaration: `= [async] [<…>] (…)[: T] =>` or
 *  `= [async] x =>` — the index of that `=>`, or -1 when the value is not an arrow function
 *  (a conditional holding arrows is a plain value: all of it is the contract). */
function valueArrow(toks) {
  const eq = toks.indexOf("=");
  if (eq < 0) return -1;
  let k = eq + 1;
  if (toks[k] === "async") k += 1;
  if (isIdent(toks[k]) && toks[k + 1] === "=>") return k + 1;
  if (toks[k] === "<") {
    let angle = 0;
    for (; k < toks.length; k++) {
      if (toks[k] === "<") angle += 1;
      else if (toks[k] === ">" && --angle === 0) break;
    }
    k += 1;
  }
  if (toks[k] !== "(") return -1;
  k = groupEnd(toks, k);
  if (k < 0) return -1;
  if (toks[k + 1] === "=>") return k + 1;
  if (toks[k + 1] !== ":") return -1;
  // a return type, then the arrow: brackets and generic `<…>` are skipped
  let depth = 0;
  let angle = 0;
  for (let i = k + 2; i < toks.length; i++) {
    const t = toks[i];
    if (OPEN.has(t)) depth += 1;
    else if (CLOSE.has(t)) depth -= 1;
    else if (depth === 0 && t === "<") angle += 1;
    else if (depth === 0 && t === ">" && angle > 0) angle -= 1;
    else if (depth === 0 && angle === 0 && t === "=>") return i;
    else if (depth === 0 && angle === 0 && (t === ";" || t === "," || t === "=")) return -1;
  }
  return -1;
}

/** The contract part of one declaration's tokens: all of it but a function's body. */
function declarationHead(toks, kind, lang) {
  if (kind === "class" || kind === "type") return toks;
  if (lang === "py") {
    let depth = 0;
    let params = false;
    for (let i = 0; i < toks.length; i++) {
      if (OPEN.has(toks[i])) {
        depth += 1;
        if (toks[i] === "(") params = true;
      } else if (CLOSE.has(toks[i])) depth -= 1;
      else if (toks[i] === ":" && depth === 0 && params) return toks.slice(0, i + 1);
    }
    return toks;
  }
  if (kind === "const") {
    const arrow = valueArrow(toks);
    if (arrow >= 0) return toks.slice(0, arrow + 1);
    const eq = toks.indexOf("=");
    const fn = toks[eq + 1] === "async" ? eq + 2 : eq + 1;
    if (eq < 0 || toks[fn] !== "function") return toks; // a plain value IS the contract
  }
  // A block body is the declaration's FINAL top-level `{…}` (a return-type literal before it
  // stays in the head); no final block means no body here (an overload): all of it. An arrow
  // inside a function's return type (`(): () => void {`) is type, never a cut.
  let end = toks.length - 1;
  if (toks[end] === ";") end -= 1;
  if (toks[end] !== "}") return toks;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (toks[i] === "}") depth += 1;
    else if (toks[i] === "{" && --depth === 0) return toks.slice(0, i);
  }
  return toks;
}

const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** Where a definition's declaration text starts: its own statement on the name's line (text
 *  before an earlier `;`, `{` or `}` there is another statement — review N08: an arrow in it
 *  cut the parameters out of the contract), extended upward over decorator lines (multi-line
 *  `@x({…})` groups included) and keyword-only lines (`export`, `async`… split onto their own
 *  line). @returns {{top:number, col:number}} 0-based line, column on that line */
function declarationStart(mlines, li, name, kind, lang) {
  const n = escapeRe(name);
  const pat =
    lang === "py"
      ? new RegExp(`\\b(?:def|class)\\s+${n}(?![\\w$])`)
      : kind === "function"
        ? new RegExp(`\\bfunction(?:\\s*\\*\\s*|\\s+)${n}(?![\\w$])`)
        : kind === "class"
          ? new RegExp(`\\bclass\\s+${n}(?![\\w$])`)
          : kind === "const"
            ? new RegExp(`\\b(?:const|let|var)\\s+${n}(?![\\w$])`)
            : new RegExp(`(?<![\\w$])${n}(?![\\w$])`);
  const line = mlines[li] ?? "";
  const m = pat.exec(line);
  let col = 0;
  if (m) for (let k = m.index - 1; k >= 0 && !col; k--) if (";{}".includes(line[k])) col = k + 1;
  let top = li;
  while (top > 0) {
    let t = mlines[top - 1].trim();
    if (!t) break;
    if (t.endsWith("*")) t = t.slice(0, -1).trimEnd(); // `function*` split from its name
    if (DECL_KEYWORDS.test(t)) {
      top -= 1;
      continue;
    }
    const open = decoratorStart(mlines, top - 1);
    if (open < 0) break;
    top = open;
  }
  return { top, col: top === li ? col : 0 };
}

const DECL_KEYWORDS =
  /^(?:export|default|async|declare|abstract|public|private|protected|static|readonly|override|function|class|const|let|var|def)(?:\s+(?:export|default|async|declare|abstract|public|private|protected|static|readonly|override|function|class|const|let|var|def))*$/;

/** The first line of the decorator ending at line `k` (brackets balanced back to a line that
 *  starts with `@`), or -1 when line `k` ends no decorator. */
function decoratorStart(mlines, k) {
  let balance = 0;
  for (let j = k; j >= 0 && j > k - 40; j--) {
    for (const ch of mlines[j]) {
      if (ch === "(" || ch === "[" || ch === "{") balance += 1;
      else if (ch === ")" || ch === "]" || ch === "}") balance -= 1;
    }
    if (balance > 0) return -1;
    if (balance === 0) return mlines[j].trim().startsWith("@") ? j : -1;
  }
  return -1;
}

/** Named exports of a JS module: exported name → local binding. `null` when its exports are
 *  not declarative (CommonJS assignments, `export =`): then any defined name may be exported.
 *  @param {string} code masked code */
function jsExportMap(code) {
  if (/\bmodule\.exports\b|(?<![\w$.])exports\.[\w$]+\s*=|\bexport\s*=(?!=)/.test(code))
    return null;
  /** @type {Map<string, string>} */
  const map = new Map();
  const DECL =
    /\bexport\s+(?!default\b)(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function(?:\s*\*\s*|\s+)|class\s+|const\s+enum\s+|(?:const|let|var|enum|interface|type|namespace)\s+)([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(DECL)) map.set(m[1], m[1]);
  for (const m of code.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}(?!\s*from\b)/g))
    for (const part of m[1].split(",")) {
      const mm = part
        .trim()
        .replace(/^type\s+/, "")
        .match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (mm) map.set(mm[2] || mm[1], mm[1]);
    }
  return map;
}

const langOf = (file) => (/\.pyi?$/.test(file) ? "py" : "js");

/**
 * A dependency's contract, or why none can be given.
 * @param {string} root @param {any} atlas @param {string} name the name as the module EXPORTS it
 * @param {string|null} file the module the artifact's import binds `name` to (null: unbound)
 * @returns {{sig: string}|{gone: string}|{unknown: string}}
 */
function contractOf(root, atlas, name, file) {
  const top = (x) => !x.local;
  const named = (atlas?.symbols ?? []).filter(
    (x) => (x.name === name || x.qname === name) && top(x),
  );
  const files = [...new Set(named.map((x) => x.file))];
  if (!file && files.length !== 1)
    return {
      unknown: files.length
        ? `defined in ${files.length} files and no import binding says which`
        : "not in the atlas",
    };
  const where = file ?? files[0];
  let text;
  try {
    text = readFileSync(join(root, where), "utf8");
  } catch {
    return file ? { gone: `${where} no longer exists` } : { unknown: `${where} is unreadable` };
  }
  // The atlas's line numbers and extents locate definitions only in the text it indexed.
  if (!indexedText(atlas, where, text))
    return { unknown: `${where} changed since the atlas was built (rebuild it)` };
  const ext = extname(where);
  const lang = langOf(where);
  const code = maskCode(text, ext);
  const parts = [];
  // What the import binds: the module's export of `name` (an `export { impl as calc }` binds
  // `calc` to `impl`), so a re-pointed or dropped export is a changed contract, never valid.
  let binding = name;
  if (lang === "js") {
    // A module with declarative exports that no longer exports the name breaks the import.
    const exported = jsExportMap(code);
    if (exported && !exported.has(name)) return { gone: `${where} no longer exports ${name}` };
    binding = exported?.get(name) ?? name;
    if (binding !== name) parts.push(["export", name, binding]);
  }
  const raw = text.split("\n");
  const mlines = code.split("\n");
  const inFile = (atlas?.symbols ?? []).filter((x) => x.file === where && top(x));
  const imported = new Set(
    lang === "js" ? jsImports(code, text).flatMap((imp) => imp.names.map((x) => x.local)) : [],
  );
  const seen = new Set();
  /** @returns {string|null} why the contract is unknown ("" — the name is not defined) */
  const add = (id, depth) => {
    if (seen.has(id)) return null;
    seen.add(id);
    const defs = inFile.filter((x) => x.name === id).sort((a, b) => a.line - b.line);
    if (!defs.length) return "";
    // Every same-file definition of the name (TS overloads), in source order.
    for (const sym of defs) {
      if (!sym.line || !sym.endLine || sym.endLine < sym.line)
        return `the extent of ${id} in ${where} is not known`;
      const { top: from, col } = declarationStart(mlines, sym.line - 1, id, sym.kind, lang);
      const decl = [raw[from].slice(col), ...raw.slice(from + 1, sym.endLine)].join("\n");
      const toks = contractTokens(decl, ext);
      const head = declarationHead(toks, sym.kind, lang);
      if (!head.length) return `the declaration of ${id} is empty`;
      parts.push([sym.kind ?? "", head]);
      // `const calc = impl` is an alias: the contract is impl's too (same file, ≤3 hops). An
      // alias of an IMPORTED binding cannot be established from this module: unknown.
      if (sym.kind === "const" && lang === "js") {
        const eq = toks.indexOf("=");
        const value = toks.slice(eq + 1).filter((t) => t !== ";");
        const alias = value.length && value.every((t, k) => (k % 2 ? t === "." : isIdent(t)));
        if (eq >= 0 && alias && imported.has(value[0]))
          return `${binding} aliases ${value[0]}, which ${where} imports from another module`;
        if (eq >= 0 && alias && inFile.some((x) => x.name === value[0])) {
          if (depth >= 3) return `the alias chain of ${binding} is too long`;
          const why = add(value[0], depth + 1);
          if (why) return why;
        }
      }
    }
    return null;
  };
  const why = add(binding, 0);
  if (why === "") return { gone: `no longer defined in ${where}` };
  if (why) return { unknown: why };
  return { sig: `${CONTRACT_PREFIX}${contentHash(JSON.stringify(parts)).slice(0, 16)}` };
}

/**
 * A dependency's contract fingerprint (review F05/N08): a hash of its whole declaration minus
 * its body (see above), prefixed with the contract version. `file` pins the definition the
 * caller's import binds to; without it the name must be defined in exactly one file. `null`
 * when the contract cannot be established — the caller must then treat it as unknown.
 * @param {string} root
 * @param {any} atlas
 * @param {string} name
 * @param {{file?: string|null}} [opts]
 * @returns {string|null}
 */
export function depContract(root, atlas, name, { file = null } = {}) {
  const r = contractOf(root, atlas, name, file);
  return "sig" in r ? r.sig : null;
}

/**
 * Revalidation at the serving boundary (review F05). A proof is about the bytes and the
 * interfaces that existed when it was earned; before an artifact is served it must be checked
 * against what exists NOW:
 *   - its file (a `{path, sha256}` pointer) must exist with the SAME content digest — a proof
 *     of old bytes does not validate the current file, and a deleted file is not reusable;
 *   - every dependency must still resolve, every dependency contract recorded at mint must
 *     still match the current declaration (same name, changed signature ⇒ stale), and every
 *     module the code depends on as a whole (`moduleDeps`: a default or namespace import, a
 *     `require`, a module that is only re-exported) must still hold the same bytes.
 * `status` is "valid", "invalid" (with `problems`) or "unknown": no repo root means the file
 * could not be checked, and no fresh atlas means the dependencies could not — UNKNOWN, never
 * silently "ok". Inline artifacts carry their own code and need no file check.
 * @param {any} artifact
 * @param {any} atlas
 * @param {{root?: string|null}} [opts]
 * @returns {{status: "valid"|"invalid"|"unknown", ok: boolean, checked: boolean,
 *   missing: string[], changed: string[], problems: string[], unknown: string[]}}
 */
export function revalidate(artifact, atlas, { root = null } = {}) {
  const code = artifact?.body?.code ?? {};
  const deps = artifact?.body?.deps ?? [];
  const problems = [];
  const unknown = [];
  const read = (rel) => {
    try {
      return readFileSync(join(/** @type {string} */ (root), rel), "utf8");
    } catch {
      return null;
    }
  };
  if (code.path) {
    if (!root) unknown.push(`file ${code.path} (no repo root to check it against)`);
    else {
      const text = read(code.path);
      if (text === null) problems.push(`file ${code.path} no longer exists`);
      else if (code.sha256 && contentHash(text) !== code.sha256)
        problems.push(`file ${code.path} changed since it was verified`);
    }
  }
  const missing = [];
  const changed = [];
  const sources = artifact?.body?.depSources ?? {};
  if (!atlas) {
    if (deps.length) unknown.push("dependencies (no fresh atlas)");
  } else {
    // A bound dependency's existence is its contract's question (an aliased export has no
    // atlas symbol of its own name); an unbound one must still resolve by name.
    for (const d of deps) if (!(d in sources) && !atlasHas(atlas, d)) missing.push(d);
    for (const [name, sig] of Object.entries(artifact?.body?.depContracts ?? {})) {
      if (missing.includes(name)) continue;
      if (typeof sig !== "string" || !sig.startsWith(CONTRACT_PREFIX)) {
        unknown.push(
          `contract of ${name} (${typeof sig === "string" ? "recorded in an older format" : "not established at mint"})`,
        );
        continue;
      }
      if (!root) {
        unknown.push(`contract of ${name} (no repo root)`);
        continue;
      }
      const now = contractOf(root, atlas, name, sources[name] ?? null);
      if ("unknown" in now) unknown.push(`contract of ${name} (${now.unknown})`);
      else if ("gone" in now || now.sig !== sig) changed.push(name);
    }
  }
  for (const [file, sha] of Object.entries(artifact?.body?.moduleDeps ?? {})) {
    if (typeof sha !== "string") unknown.push(`import ${file} (not resolved at mint)`);
    else if (!root) unknown.push(`module ${file} (no repo root)`);
    else {
      const text = read(file);
      if (text === null) problems.push(`module ${file} no longer exists`);
      else if (contentHash(text) !== sha) changed.push(`module ${file}`);
    }
  }
  if (missing.length) problems.push(`missing ${missing.join(", ")}`);
  if (changed.length) problems.push(`changed contract: ${changed.join(", ")}`);
  const status = problems.length ? "invalid" : unknown.length ? "unknown" : "valid";
  return {
    status,
    ok: status === "valid",
    checked: status !== "unknown",
    missing,
    changed,
    problems,
    unknown,
  };
}

/**
 * exact → near → adapt → miss (docs/plans/substrate-v2/03 §3).
 * Optional `sim(normSpec, claim) → cosine|null` (the embeddings tier — built by
 * callers via embed.claimSim, keeping this ladder provider-free): when it yields a
 * number for a candidate, cosine thresholds NEAR_COS/ADAPT_COS apply; when it yields
 * null for that candidate (missing vector), MinHash Jaccard with NEAR_J/ADAPT_J is the
 * per-candidate fallback — a partially-embedded ledger never loses lexical recall.
 * Similarity alone never serves code as-is (review F04): a near candidate whose operators,
 * numbers, literals, identifiers, paths, polarity words or their bindings differ from the
 * query is held at the adapt tier (a starting point to review), with the conflict named in
 * `reasons`. And similarity never establishes equivalence (review Q01): every hit carries
 * `semanticEquivalence` — "identical" for exact (the byte-identical spec), "unverified" for
 * near and adapt — and `requiresReview`, true for every non-exact hit.
 * Every hit is revalidated at the serving boundary (review F05, see revalidate): an
 * `invalid` artifact is never served; an `unknown` one is returned with
 * `requiresRevalidation: true` — never presented as checked.
 * @param {any[]} claims live ledger claims (any kind — filtered here)
 * @param {string} spec the task
 * @param {{slice?:string, atlas?:any, nowDay?:number, root?:string|null,
 *          sim?:((query:any, claim:any)=>number|null)|null}} opts
 * @returns {{tier:"exact"|"near"|"adapt"|"miss", artifact?:any, jaccard?:number,
 *            similarity?:number, simBackend?:string, revalidation?:object,
 *            semanticEquivalence?:"identical"|"unverified", requiresReview?:boolean,
 *            requiresRevalidation?:boolean, reasons:string[], sim?:string,
 *            invalidated?:{id:string, missing:string[], changed:string[], problems:string[]}[]}}
 *            `sim` is stamped by reuseQuery/reusePeek (the backend label the CLI prints);
 *            lookup itself never sets it.
 */
export function lookup(
  claims,
  spec,
  { slice = "", atlas = null, nowDay = 0, sim = null, root = null } = {},
) {
  const { key, digest, sketch: qs, keySketch: qk } = fingerprint(spec, slice);
  const reasons = [];
  const invalidated = [];
  const artifacts = claims.filter(
    (c) => c.kind === "artifact" && !c.tombstone && !isDormant(c, nowDay),
  );

  const proved = (c, why) => {
    const v = val(c, nowDay);
    if (v >= SERVE_FLOOR) return true;
    reasons.push(`${why} ${c.id.slice(0, 8)} below proof floor (val ${v.toFixed(2)})`);
    return false;
  };
  // Revalidate at the boundary; an invalid artifact is recorded and skipped.
  const servable = (c, why) => {
    const rv = revalidate(c, atlas, { root });
    if (rv.status !== "invalid") return rv;
    invalidated.push({
      id: c.id,
      missing: rv.missing,
      changed: rv.changed,
      problems: rv.problems,
    });
    reasons.push(`${why} ${c.id.slice(0, 8)} failed revalidation: ${rv.problems.join("; ")}`);
    return null;
  };
  // Review Q01: only the exact tier ESTABLISHES that the task is the one the artifact was
  // verified for (the same spec, byte for byte). A near or adapt hit is a similar candidate —
  // no check here can establish that two texts mean the same — so it is always marked as one
  // that requires review, with its equivalence unverified. `revalidation` is a separate
  // question: whether the artifact and its dependencies still hold, not whether it fits.
  const served = (tier, c, rv, extra = {}) => ({
    tier,
    artifact: c,
    ...extra,
    semanticEquivalence: /** @type {"identical"|"unverified"} */ (
      tier === "exact" ? "identical" : "unverified"
    ),
    requiresReview: tier !== "exact",
    revalidation: rv,
    ...(rv.status === "valid" ? {} : { requiresRevalidation: true }),
    reasons,
    invalidated,
  });

  // 1. exact: the same task, byte for byte (the digest of the spec as given, current key
  //    version), same graph-slice context. A blank spec is not an identity: it never matches.
  for (const c of artifacts) {
    if (
      key.trim() &&
      c.body.keyV === KEY_VERSION &&
      c.body.keyHash === digest &&
      (c.body.slice ?? "") === slice &&
      proved(c, "exact")
    ) {
      const rv = servable(c, "exact");
      if (rv) return served("exact", c, rv, { jaccard: 1, similarity: 1 });
    }
  }

  // 2–3. near/adapt: LSH candidates when the pool is big, all-pairs when small. With a
  // sim the LSH prefilter is skipped — banding indexes MinHash sketches, not vectors,
  // and would drop exactly the paraphrase candidates only the embedding can see
  // (cosine over precomputed vectors is cheap, so all-pairs is fine).
  // (`_specSketch`/`_keySketch`, not `_sketch`: ledger.js memoizes the CLAIM-text sketch
  //  under that name, and the two would overwrite each other.)
  const shapeOf = (c) => (c._specSketch ??= sketch(c.body.spec ?? ""));
  const keyOf = (c) => (c._keySketch ??= sketch(c.body.key ?? ""));
  let pool = artifacts;
  if (!sim && artifacts.length > 32) {
    const qBands = new Set(bandKeys(qs));
    pool = artifacts.filter((c) => bandKeys(shapeOf(c)).some((k) => qBands.has(k)));
  }
  // near compares IDENTITY (same names, similar prose); adapt compares SHAPE too, so
  // `add pagination to listOrders` can still be offered the listUsers artifact as a
  // starting point — the tier that says "generate only the delta" — but never as-is.
  const measure = (c) => {
    if (sim) {
      const s = sim(key, c);
      if (typeof s === "number" && Number.isFinite(s))
        return { c, v: s, backend: "embed", near: s >= NEAR_COS, adapt: s >= ADAPT_COS };
    }
    const jKey = c.body.key ? jaccard(qk, keyOf(c)) : 0;
    const jShape = jaccard(qs, shapeOf(c));
    const v = Math.max(jKey, jShape);
    return { c, v, backend: "minhash", near: jKey >= NEAR_J, adapt: v >= ADAPT_J };
  };
  const ranked = pool
    .map(measure)
    .filter((x) => x.adapt)
    .sort((a, b) => b.v - a.v || (a.c.id < b.c.id ? -1 : 1));
  // F04: similarity found a neighbour; the semantic guard decides whether it is the same
  // instruction. Any behaviour-bearing difference holds the candidate at adapt.
  // A key from an older version was stored lossy, and a key the ledger stored folded (CRLF,
  // non-NFC) is not the text that was verified: neither can be compared, so neither is near.
  for (const x of ranked) {
    if (!x.near) continue;
    const held =
      x.c.body.keyV !== KEY_VERSION
        ? "its key was recorded by an older version"
        : x.c.body.keyVerbatim !== true
          ? "its key was stored normalized (CRLF or non-NFC text), so it cannot be compared as written"
          : "";
    const conflicts = held ? [] : semanticConflicts(spec, x.c.body.key ?? "");
    if (!held && !conflicts.length) continue;
    x.near = false;
    reasons.push(
      `near ${x.c.id.slice(0, 8)} held at adapt — ${held || `differs in ${describeConflicts(conflicts)}`}`,
    );
  }

  const hit = (tier, x, revalidation) =>
    served(tier, x.c, revalidation, {
      // `jaccard` keeps its honest meaning (a Jaccard estimate) — only set on the
      // MinHash backend. `similarity` is the score the tier decision actually used.
      jaccard: x.backend === "minhash" ? x.v : undefined,
      similarity: x.v,
      simBackend: x.backend,
    });
  // No early break: backends interleave in one ranking, so a non-near embed candidate
  // may sort above a near MinHash one — skip, don't stop.
  for (const x of ranked) {
    if (!x.near || !proved(x.c, "near")) continue;
    const rv = servable(x.c, "near");
    if (rv) return hit("near", x, rv);
  }
  for (const x of ranked) {
    if (x.near) continue; // handled above
    if (!proved(x.c, "adapt")) continue;
    // adapt injects the artifact as a starting point: its FILE must still be the verified
    // bytes (a deleted/changed file is no starting point); its deps are the delta's problem.
    const body = { ...x.c.body, deps: [], depContracts: {}, moduleDeps: {} };
    const rv = revalidate({ ...x.c, body }, null, {
      root,
    });
    if (rv.status === "invalid") {
      reasons.push(`adapt ${x.c.id.slice(0, 8)} skipped: ${rv.problems.join("; ")}`);
      continue;
    }
    return hit("adapt", x, rv);
  }
  return { tier: "miss", reasons, invalidated };
}

// ---------------------------------------------------------------------------
// Store-level query: lookup + evidence write-back + metrics — what the CLI and the
// substrate stage call.
// ---------------------------------------------------------------------------

/** Rough tokens a hit avoids generating (chars/3.6 heuristic; calibrated in P8). */
const savedEstimate = (tier, artifact) => {
  const size =
    JSON.stringify(artifact?.body?.code ?? {}).length + (artifact?.body?.spec.length ?? 0);
  const factor = tier === "exact" ? 1 : tier === "near" ? 0.85 : 0.5;
  return Math.round((size / 3.6) * factor);
};

/** Build the optional embedding sim for the ladder (FORGE_EMBED set → cosine over
 *  NORMALIZED specs, the same text space MinHash compares; unset or provider failure
 *  → null and the caller's MinHash path is unchanged). One provider call embeds the
 *  query plus every candidate spec, disk-cached under `.forge/embed-cache.jsonl`. */
const specSim = (root, spec, claims) =>
  claimSim(
    root,
    specKey(spec),
    claims.filter((c) => c.kind === "artifact" && !c.tombstone),
    // The IDENTITY text, so the vector sees the identifiers the tier decision cares about
    // (a pre-C9 artifact has only the shape form).
    (c) => c.body?.key ?? c.body?.spec ?? "",
  );

export function reuseQuery(root, spec, { slice = "", atlas = null, nowDay = 0 } = {}) {
  const dir = repoLedger(root);
  const claims = existsSync(join(dir, "claims")) ? loadClaims(dir) : [];
  const sim = specSim(root, spec, claims);
  const r = lookup(claims, spec, { slice, atlas, nowDay, sim, root });
  r.sim = simLabel(sim);

  // A FAILED revalidation is an oracle outcome (graph.reval): an artifact whose deps
  // vanished demotes itself — for everyone. A PASSING one is not written back: serving is
  // never confirmation (review C2 — ten daily serves used to lift val 0.643 → 0.864 and
  // kept an artifact served after two failing test runs). Only a real oracle raises val.
  // A changed file or dependency CONTRACT is not written back either: the proof was true of
  // the bytes it saw — the artifact is merely not servable as the current code (review F05).
  for (const inv of r.invalidated ?? []) {
    if (!inv.missing.length) continue;
    const o = outcomeRecord({
      oracle: "graph.reval",
      result: "contradict",
      ref: `atlas:missing:${inv.missing.slice(0, 3).join(",")}`,
      author: gitAuthor(),
      t: nowDay,
    });
    if (o.ok) appendEvidence(dir, inv.id, o.outcome);
  }

  recordMetric(root, {
    stage: "cache",
    outcome: r.tier === "miss" ? "miss" : `hit_${r.tier}`,
    savedEstimate: r.tier === "miss" ? 0 : savedEstimate(r.tier, r.artifact),
    ref: r.artifact?.id,
  });
  return r;
}

/** Read-only lookup for the ambient/hook path — never appends evidence or metrics
 *  (hooks must not write on every prompt; the explicit gate meters instead).
 *  @returns {ReturnType<typeof lookup>} */
export function reusePeek(root, spec, { slice = "", atlas = null, nowDay = 0 } = {}) {
  const dir = repoLedger(root);
  if (!existsSync(join(dir, "claims"))) return { tier: "miss", reasons: [], sim: "minhash" };
  const claims = loadClaims(dir);
  const sim = specSim(root, spec, claims);
  const r = lookup(claims, spec, { slice, atlas, nowDay, sim, root });
  r.sim = simLabel(sim);
  return r;
}

// ---------------------------------------------------------------------------
// Cache-fill helpers for `forge reuse mint` — extract the verifiable pointer and
// the structural facts from a real file (regex tier, same honesty as the atlas).
// ---------------------------------------------------------------------------

// Code imports that must resolve in the repo; an unresolved `./styles.css` is an asset.
const CODE_SPEC = /(?:^|\/)[^/.]*$|\.(?:[cm]?[jt]sx?|py)$/;
const MAX_REEXPORT_HOPS = 3;

/**
 * What a file's imports bind to (review N08). Each import is resolved structurally — the
 * resolver the atlas and `forge scope` share: relative specifiers, tsconfig path aliases,
 * Python relative and absolute imports — never by a repo-wide name guess:
 *   - a NAMED import whose target module defines (and exports) the name is a symbol
 *     dependency: its contract is fingerprinted and pinned to that module (`depSources`);
 *     through a re-export (`export { calc } from "./impl"`, `export *`, a Python `__init__`
 *     that imports it) the definition is followed up to three hops, and every module passed
 *     through is a whole-module dependency, so re-pointing the re-export invalidates too;
 *   - everything else — a default, namespace or side-effect import, `require`, `import()`, a
 *     Python `import pkg.mod`, a name the module defines in a form forge does not index — is a
 *     whole-module dependency: its content digest (`moduleDeps`);
 *   - a relative code import that resolves to no file is recorded unresolved (`null`), so
 *     revalidation says unknown, never valid.
 * @param {string} root @param {string} relPath @param {any} atlas
 */
function importDeps(root, relPath, atlas) {
  const files = new Set(Object.keys(atlas?.fileHashes ?? {}));
  /** @type {Set<string>} */
  const deps = new Set();
  /** @type {Record<string, string|null>} */
  const depContracts = {};
  /** @type {Record<string, string>} */
  const depSources = {};
  /** @type {Record<string, string|null>} */
  const moduleDeps = {};
  const textOf = new Map();
  const read = (rel) => {
    if (!textOf.has(rel)) {
      let t = null;
      try {
        t = readFileSync(join(root, rel), "utf8");
      } catch {}
      textOf.set(rel, t);
    }
    return textOf.get(rel);
  };
  const wholeModule = (rel) => {
    const t = read(rel);
    moduleDeps[rel] = t === null ? null : contentHash(t);
  };
  const defined = (rel, name) =>
    (atlas?.symbols ?? []).some((x) => x.file === rel && x.name === name && !x.local);
  const aliases = loadPathAliases(root);
  const pyIndex = pyModuleIndex(files);
  /**
   * @typedef {{target: string|null, spec: string, code: boolean,
   *   names: {imported: string, local: string}[], whole: boolean, reexport: boolean}} ImportDep
   */
  /** Imports of one module, resolved. @param {string} rel @returns {ImportDep[]} */
  const importsOf = (rel) => {
    const t = read(rel);
    if (t === null) return [];
    const ext = extname(rel);
    const code = maskCode(t, ext);
    if (lexOf(ext) === "py") {
      /** @type {ImportDep[]} */
      const out = [];
      for (const imp of pyImports(code)) {
        const hits = resolvePyImport(rel, imp, pyIndex);
        if (!hits.length && imp.level > 0)
          out.push({
            target: null,
            spec: `${".".repeat(imp.level)}${imp.module}`,
            code: true,
            names: [],
            whole: true,
            reexport: false,
          });
        for (const h of hits)
          out.push({
            target: h.file,
            spec: h.file,
            code: true,
            names: h.names.filter((x) => x.imported !== "*"),
            whole: !h.names.length || h.names.some((x) => x.imported === "*"),
            reexport: true, // a Python module re-exports whatever it imports
          });
      }
      return out;
    }
    if (lexOf(ext) !== "js") return [];
    return jsImports(code, t).map((imp) => {
      const target = resolveSpec(rel, imp.spec, files, aliases);
      const named = imp.names.filter((x) => x.imported !== "default" && x.imported !== "*");
      return {
        target,
        spec: imp.spec,
        code: imp.spec.startsWith(".") && CODE_SPEC.test(imp.spec),
        names: target ? named : [],
        whole: !named.length || named.length < imp.names.length,
        reexport: imp.form === "reexport",
      };
    });
  };
  /** The module defining `name` as exported by `rel`, following re-exports; every module
   *  passed through is recorded whole. @returns {{file:string, name:string}|null} */
  const bind = (rel, name, hops) => {
    const t = read(rel);
    if (t === null) return null;
    const ext = extname(rel);
    if (lexOf(ext) === "js") {
      const exported = jsExportMap(maskCode(t, ext));
      const local = exported ? exported.get(name) : name;
      if (local !== undefined && defined(rel, local)) return { file: rel, name };
    } else if (defined(rel, name)) return { file: rel, name };
    if (hops >= MAX_REEXPORT_HOPS) return null;
    for (const imp of importsOf(rel)) {
      if (!imp.target || !imp.reexport) continue;
      const via = imp.names.find((x) => (x.local ?? x.imported) === name);
      const next = via
        ? bind(imp.target, via.imported, hops + 1)
        : imp.whole
          ? bind(imp.target, name, hops + 1)
          : null;
      if (next) {
        wholeModule(rel); // the re-export itself is part of what the import binds to
        return next;
      }
    }
    return null;
  };
  for (const imp of importsOf(relPath)) {
    if (!imp.target) {
      if (imp.code) moduleDeps[imp.spec] = null;
      continue;
    }
    if (imp.whole) wholeModule(imp.target);
    for (const x of imp.names) {
      const hit = bind(imp.target, x.imported, 0);
      if (!hit) {
        wholeModule(imp.target);
        continue;
      }
      if (depSources[hit.name] && depSources[hit.name] !== hit.file) {
        // one name bound to two modules: neither contract alone describes it
        wholeModule(hit.file);
        wholeModule(depSources[hit.name]);
        continue;
      }
      deps.add(hit.name);
      depSources[hit.name] = hit.file;
      depContracts[hit.name] = depContract(root, atlas, hit.name, { file: hit.file });
    }
  }
  return { deps: [...deps], depContracts, depSources, moduleDeps };
}

/**
 * The verifiable pointer + structural facts of a real file: `{path, sha256}`, its exports, and
 * — given an atlas — what its imports bind to (see importDeps): each symbol dependency's
 * contract fingerprint and module, and each whole-module dependency's content digest, so a
 * later change to any of them invalidates the artifact (review F05/N08). A dependency whose
 * contract cannot be established is recorded as `null`. Without an atlas nothing can be
 * resolved: the named imports are listed, and revalidation says the dependencies are unknown.
 * @param {string} root
 * @param {string} relPath
 * @param {{atlas?: any}} [opts]
 */
export function describeFile(root, relPath, { atlas = null } = {}) {
  const text = readFileSync(join(root, relPath), "utf8");
  const ext = extname(relPath);
  const code = maskCode(text, ext);
  const iface = lexOf(ext) === "js" ? [...(jsExportMap(code)?.keys() ?? [])] : [];
  const bound = atlas
    ? importDeps(root, relPath, atlas)
    : {
        deps: [
          ...new Set(
            (lexOf(ext) === "js" ? jsImports(code, text) : [])
              .flatMap((imp) => imp.names.map((x) => x.imported))
              .filter((x) => x !== "default" && x !== "*"),
          ),
        ],
        depContracts: {},
        depSources: {},
        moduleDeps: {},
      };
  return {
    code: { path: relPath, sha256: contentHash(text) },
    iface: [...new Set(iface)].sort(),
    deps: bound.deps.sort(),
    depContracts: bound.depContracts,
    depSources: bound.depSources,
    moduleDeps: bound.moduleDeps,
    lang: relPath.split(".").pop() ?? "",
  };
}
