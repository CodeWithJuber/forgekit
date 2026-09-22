// forge secrets — the ONE source of truth for secret detection and redaction.
// Everything that refuses or masks credentials (ledger mint, recall/lesson persist,
// adjudicate prompt/reply gate, diagnose traces, the secret-redact.sh guard) resolves
// here, so JS and shell can never disagree about what a secret is.
//
// Two complementary detectors:
//  (i) FORMAT grammars — regexes over *documented* credential shapes (GitHub PAT,
//      GitLab PAT, Anthropic/OpenAI sk-, Slack xox, Google AIza/ya29, JWT, AWS
//      AKIA/ASIA, PEM, credentials embedded in a URL). These are parsers of known
//      token grammars, kept as regex deliberately.
//  (ii) ENTROPY scoring (src/math.js) — a graded gate for tokens no format list has
//      an entry for. A ≥20-char mixed-case-plus-digit token whose Shannon entropy
//      reaches random-credential territory is treated as a secret even when its
//      vendor prefix is unknown. Hex-only strings (git SHAs, digests) are exempt by
//      construction: they lack the mixed-case signal and are indistinguishable from
//      content hashes anyway — precision first (see the recall.js history: a bare
//      English mention like "implement password hashing" must NOT be refused).
//
// LINEAR TIME is a hard requirement: these regexes run on every tool output (the
// secret-redact hook), on staged diffs and on model prompts. Every quantifier that
// could re-scan a long run from many start positions is BOUNDED (`{0,64}`, never `*`
// next to another unbounded run) — an unbounded `[\w-]*KEY[\w-]*` was cubic on
// `token-token-…` (12 KB took 40 s, past the hook timeout, so the output passed
// through unredacted).

import { shannonEntropy } from "./math.js";

// (i) Known credential grammars. `-----BEGIN ` is the PEM header.
const FORMATS = [
  "-----BEGIN ",
  "\\bghp_[A-Za-z0-9]{16,}",
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",
  "\\bglpat-[A-Za-z0-9_-]{20,}",
  "\\bsk-[A-Za-z0-9_-]{16,}",
  "\\bxox[baprs]-[A-Za-z0-9-]{10,}",
  "\\bAIza[0-9A-Za-z_-]{20,}",
  "\\bya29\\.[A-Za-z0-9._-]+",
  "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  "AKIA[0-9A-Z]{16}",
  "\\bapikey_[0-9a-f]{40}_[0-9a-f]{64}\\b",
];
// Grammars that only mean "credential" in their exact case: AWS STS temporary key
// ids (`ASIA…`). Under the /i flag the prefix would also match ordinary words.
const CASE_FORMATS = ["\\bASIA[0-9A-Z]{16}\\b"];
// A credential embedded in a URL's userinfo: `scheme://user:PASSWORD@host` (postgres,
// mongodb+srv, amqp, redis `://:pw@`, `https://oauth2:glpat-…@`). Requires BOTH the
// `:` and the `@` — a plain `https://host:8080/path` or `ssh://git@host` never matches.
// Group 1 is kept on redaction (scheme + user stay readable), group 2 is the password.
const URL_CRED = "(\\b[a-z][a-z0-9+.-]{0,31}://[^\\s/:@]{0,256}:)([^\\s/@]{1,256})(?=@)";
// Key names whose ASSIGNED value is a credential, matched anywhere in the key
// (DB_PASSWORD, apiKey, x-auth-token). The bounded suffix lets `SECRET_KEY_BASE=` match.
const KEYISH = "(?:api[_-]?key|secret|passwd|password|token)";
// Broader words ("auth", "credentials") are credential-bearing only in the env/query
// grammar (`AUTH=…`, `?auth=…`, `CREDENTIALS=…`) — never in prose or YAML ("auth: use
// OAuth"), and never as a prefix (`author=`): they must END the key, then a bare `=`.
const AUTHISH = "(?:auth(?:orization)?|credentials?)";
// The final branches: a secret-ish key ASSIGNED to a value (never a bare English
// mention), and an `Authorization: <scheme> <credential>` header.
const ASSIGNED = `${KEYISH}[\\w-]{0,64}["']?\\s*[:=]\\s*["']?\\S`;
const AUTH_ASSIGNED = `${AUTHISH}["']?=["']?[^\\s"'&;]`;
const AUTH_HEADER = `\\bauthorization["']?\\s*:\\s*["']?(?:basic|bearer|digest|token)\\s+[^\\s"']{4}`;

/** The detection regex (formats + URL credentials + key-assigned-to-value) — kept
 *  exported because tests and downstream code match against it. New code should call
 *  hasSecret(), which adds the case-sensitive grammars and the entropy gate. */
export const SECRET_RE = new RegExp(
  `(${[...FORMATS, URL_CRED, ASSIGNED, AUTH_ASSIGNED, AUTH_HEADER].join("|")})`,
  "i",
);
const CASE_RE = new RegExp(CASE_FORMATS.join("|"));

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
// Content-integrity digests are random-looking by design but PUBLIC: npm/yarn lockfile
// and SRI `sha512-<base64>` (also sha1/256/384), and go.sum `h1:<base64>`. The entropy
// leg flagged 90-100% of them, so every lockfile commit was refused. Such a digest is
// consumed whole (group 1) and never scored; format grammars still apply to it.
const INTEGRITY = "\\b(?:sha(?:1|256|384|512)-[A-Za-z0-9+/]{16,}={0,2}|h1:[A-Za-z0-9+/]{43}=)";
const ENTROPY_SCAN_G = new RegExp(`(${INTEGRITY})|${TOKEN_RE.source}`, "g");

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
  if (SECRET_RE.test(s) || CASE_RE.test(s)) return true;
  for (const m of s.matchAll(ENTROPY_SCAN_G)) {
    if (!m[1] && isHighEntropyToken(m[0])) return true;
  }
  return false;
}

// Redaction machinery — used by the secret-redact guard (via node import) and any
// JS caller that wants to keep surrounding text. PEM blocks are masked whole;
// assigned values keep their key (context stays readable, value is gone).
// Case-insensitive and tolerant of a truncated header/footer — hasSecret's PEM
// branch is case-insensitive too, and a detected-but-unredacted block would leak
// straight through the guard ("one truth, two verbs" means these must agree).
const PEM_BLOCK_G = /-----BEGIN [\s\S]*?(?:-----END [^\n-]*-----|$)/gi;
const URL_CRED_G = new RegExp(URL_CRED, "gi");
const FORMAT_G = new RegExp(FORMATS.slice(1).join("|"), "gi");
const CASE_FORMAT_G = new RegExp(CASE_FORMATS.join("|"), "g");
// Redaction is deliberately NARROWER than detection here: detection (SECRET_RE's
// ASSIGNED branch) refuses on any assigned value — cheap and conservative for a
// store. Redaction rewrites live tool output, so it only masks values that look
// like opaque tokens — never a code expression: reading
// `const token = jwt.sign(payload, key)` must NOT be mangled. Two value grammars:
//  - ENV_ASSIGNED_G: the env/shell/query form `…PASSWORD=value` — the key ENDS in a
//    secret word and `=` is bare (no spaces). The WHOLE shell word is the value, at any
//    length and with any punctuation (`DB_PASSWORD=hunter2`, `p@ssw0rd!2024`, AWS keys
//    with `/`), as long as it ends at whitespace/quote/`;`/`&`/`|` — so a kwarg like
//    `f(password=pw)` and a `$VAR` reference are left alone. An auth scheme word
//    (`AUTH=Basic <b64>`) stays readable; the credential after it is masked.
//  - ASSIGNED_G: any separator (`key = value`, `key: value`) — a quoted literal, or an
//    8+ char credential-class run (`/` allowed, so a base64 AWS secret is masked whole,
//    not only up to its first `/`). A value that STARTS with `/` is a path unless it is
//    high-entropy once its slashes are dropped (`secret_dir = /etc/app` stays readable).
const ENV_ASSIGNED_G = new RegExp(
  `((?:${KEYISH}|${AUTHISH})["']?=(?:(?:basic|bearer|digest|token) +)?)(?![\\s$"'{])([^\\s"'\`;&|<>()]{1,512})(?=[\\s"'\`;&|]|$)`,
  "gi",
);
const ASSIGNED_G = new RegExp(
  `(${KEYISH}[\\w-]{0,64}["']?\\s*[:=]\\s*(?:(?:basic|bearer|token)\\s+)?)("[^"\\n]{4,512}"|'[^'\\n]{4,512}'|[A-Za-z0-9+/=_!@#%^&*~-][A-Za-z0-9+/=_!@#$%^&*~-]{7,511}(?![\\w(]))`,
  "gi",
);
const AUTH_HEADER_G =
  /(\bauthorization["']?\s*:\s*["']?(?:basic|bearer|digest|token)\s+)([^\s"']{4,512})/gi;

/**
 * Replace every detected secret with [REDACTED], preserving surrounding text.
 * Same detectors as hasSecret — one truth, two verbs.
 * @param {string} text
 */
export function redactSecrets(text) {
  let s = String(text);
  s = s.replace(PEM_BLOCK_G, "[REDACTED]");
  // URL userinfo before the key rules: `https://x-access-token:PW@host` must mask PW,
  // not swallow `PW@host` as the value of a `token:` assignment.
  s = s.replace(URL_CRED_G, "$1[REDACTED]");
  s = s.replace(FORMAT_G, "[REDACTED]");
  s = s.replace(CASE_FORMAT_G, "[REDACTED]");
  s = s.replace(AUTH_HEADER_G, "$1[REDACTED]");
  s = s.replace(ENV_ASSIGNED_G, "$1[REDACTED]");
  s = s.replace(ASSIGNED_G, (m, key, val) =>
    val.startsWith("/") && !isHighEntropyToken(val.replaceAll("/", "")) ? m : `${key}[REDACTED]`,
  );
  s = s.replace(ENTROPY_SCAN_G, (t, integrity) =>
    !integrity && isHighEntropyToken(t) ? "[REDACTED]" : t,
  );
  return s;
}
