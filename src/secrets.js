// forge secrets — the ONE source of truth for secret detection and redaction.
// Everything that refuses or masks credentials (ledger mint, recall/lesson persist,
// adjudicate prompt/reply gate, diagnose traces, the secret-redact.sh guard) resolves
// here, so JS and shell can never disagree about what a secret is.
//
// Two complementary detectors:
//  (i) FORMAT grammars — regexes over *documented* credential shapes (GitHub PAT,
//      Anthropic/OpenAI sk-, Slack xox, Google AIza/ya29, JWT, AWS AKIA, PEM). These
//      are parsers of known token grammars, kept as regex deliberately.
//  (ii) ENTROPY scoring (src/math.js) — a graded gate for tokens no format list has
//      an entry for. A ≥20-char mixed-case-plus-digit token whose Shannon entropy
//      reaches random-credential territory is treated as a secret even when its
//      vendor prefix is unknown. Hex-only strings (git SHAs, digests) are exempt by
//      construction: they lack the mixed-case signal and are indistinguishable from
//      content hashes anyway — precision first (see the recall.js history: a bare
//      English mention like "implement password hashing" must NOT be refused).

import { shannonEntropy } from "./math.js";

// (i) Known credential grammars. `-----BEGIN ` is the PEM header; the final branch
// is a secret-ish key ASSIGNED to a value (never a bare English mention).
const FORMATS = [
  "-----BEGIN ",
  "\\bghp_[A-Za-z0-9]{16,}",
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",
  "\\bsk-[A-Za-z0-9_-]{16,}",
  "\\bxox[baprs]-[A-Za-z0-9-]{10,}",
  "\\bAIza[0-9A-Za-z_-]{20,}",
  "\\bya29\\.[A-Za-z0-9._-]+",
  "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  "AKIA[0-9A-Z]{16}",
];
const KEYISH = "(?:api[_-]?key|secret|passwd|password|token)";
const ASSIGNED = `\\b[\\w-]*${KEYISH}[\\w-]*["']?\\s*[:=]\\s*["']?\\S`;

/** The historical detection regex (formats + key-assigned-to-value), unchanged
 *  semantics — kept exported because tests and downstream code match against it.
 *  New code should call hasSecret(), which adds the entropy gate. */
export const SECRET_RE = new RegExp(`(${[...FORMATS, ASSIGNED].join("|")})`, "i");

// (ii) Entropy gate thresholds, exported so tests pin the calibration. Entropy alone
// cannot separate long camelCase identifiers from keys (both clear 4 bits/char at
// 25+ chars — measured, not assumed), so the gate also requires SCATTERED digits:
// ≥3 separate digit runs. Random 62-alphabet tokens have ~16% digits spread
// throughout (P(<3 runs at 20+ chars) is small); identifiers put digits in one or
// two lumps (`UserProfileCard2`, `convertBase64ToUtf8`). Precision first — a rare
// low-digit credential slipping past this gate still hits the format grammars.
export const ENTROPY_MIN_LEN = 20;
export const ENTROPY_MIN_BITS = 3.9;
export const ENTROPY_MIN_DIGIT_RUNS = 3;

// Candidate extraction: contiguous base64-class runs. Deliberately excludes `/` so a
// file path splits into segments instead of scoring as one token — paths were the #1
// false positive (a redacted path corrupts the very tool output the guard protects).
const TOKEN_RE = /[A-Za-z0-9+=_-]{20,}/g;

/**
 * Is this bare token secret-shaped by math alone? Requires all of: length, mixed
 * charset (lower AND upper AND digit — excludes hex/UUID/camelCase-without-digits),
 * ≥3 scattered digit runs (excludes identifiers with a lone version/counter digit),
 * and near-random Shannon entropy.
 * @param {string} tok
 */
export function isHighEntropyToken(tok) {
  const s = String(tok);
  if (s.length < ENTROPY_MIN_LEN) return false;
  if (!(/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s))) return false;
  if ((s.match(/[0-9]+/g) || []).length < ENTROPY_MIN_DIGIT_RUNS) return false;
  return shannonEntropy(s) >= ENTROPY_MIN_BITS;
}

/**
 * Does this text contain a secret? Format grammar OR entropy-detected token.
 * This is the detection entry point every refusal site should use.
 * @param {string} text
 */
export function hasSecret(text) {
  const s = String(text);
  if (SECRET_RE.test(s)) return true;
  const toks = s.match(TOKEN_RE);
  return toks ? toks.some(isHighEntropyToken) : false;
}

// Redaction machinery — used by the secret-redact guard (via node import) and any
// JS caller that wants to keep surrounding text. PEM blocks are masked whole;
// assigned values keep their key (context stays readable, value is gone).
// Case-insensitive and tolerant of a truncated header/footer — hasSecret's PEM
// branch is case-insensitive too, and a detected-but-unredacted block would leak
// straight through the guard ("one truth, two verbs" means these must agree).
const PEM_BLOCK_G = /-----BEGIN [\s\S]*?(?:-----END [^\n-]*-----|$)/gi;
const FORMAT_G = new RegExp(FORMATS.slice(1).join("|"), "gi");
// Redaction is deliberately NARROWER than detection here: detection (SECRET_RE's
// ASSIGNED branch) refuses on any assigned value — cheap and conservative for a
// store. Redaction rewrites live tool output, so it only masks values that look
// like opaque tokens (quoted, or an 8+ char credential-class run) — never a code
// expression: reading `const token = jwt.sign(payload, key)` must NOT be mangled.
const ASSIGNED_G = new RegExp(
  `(\\b[\\w-]*${KEYISH}[\\w-]*["']?\\s*[:=]\\s*)("[^"\\n]{4,}"|'[^'\\n]{4,}'|[A-Za-z0-9+=_-]{8,}(?![\\w(]))`,
  "gi",
);

/**
 * Replace every detected secret with [REDACTED], preserving surrounding text.
 * Same detectors as hasSecret — one truth, two verbs.
 * @param {string} text
 */
export function redactSecrets(text) {
  let s = String(text);
  s = s.replace(PEM_BLOCK_G, "[REDACTED]");
  s = s.replace(FORMAT_G, "[REDACTED]");
  s = s.replace(ASSIGNED_G, "$1[REDACTED]");
  s = s.replace(TOKEN_RE, (t) => (isHighEntropyToken(t) ? "[REDACTED]" : t));
  return s;
}
