import assert from "node:assert/strict";
import { test } from "node:test";
import { shannonEntropy } from "../src/math.js";
import {
  ENTROPY_MIN_BITS,
  hasSecret,
  isHighEntropyToken,
  redactSecrets,
  SECRET_RE,
} from "../src/secrets.js";
import { fakeAnthropic, fakeGithubPat, fakeGoogle, fakeJwt, fakeSlack } from "./_fixtures.js";

// A random-looking mixed-case token with NO known vendor prefix — the exact shape
// the format list can never enumerate. Assembled at runtime like the other fixtures.
const fakeUnknownVendor = () => ["Zq7Rt2", "Xk9Lp4", "Vm1Nc8", "Yb5Ws3", "Hd6Fg0"].join("");

test("hasSecret: every known credential format is caught (SECRET_RE parity)", () => {
  for (const fixture of [fakeAnthropic(), fakeGithubPat(), fakeSlack(), fakeGoogle(), fakeJwt()]) {
    assert.ok(SECRET_RE.test(fixture), `SECRET_RE should match ${fixture.slice(0, 8)}…`);
    assert.ok(hasSecret(fixture), `hasSecret should catch ${fixture.slice(0, 8)}…`);
    assert.ok(hasSecret(`prefix text ${fixture} suffix`), "…also when embedded in prose");
  }
});

test("hasSecret: assigned secret-ish key is caught, bare English mention is not", () => {
  assert.ok(hasSecret('api_key = "hunter2-value"'));
  assert.ok(hasSecret("password: swordfish"));
  // The precision invariant from recall.js history — auth-related PROSE must pass.
  assert.equal(hasSecret("implement password hashing in auth.js"), false);
  assert.equal(hasSecret("rotate the api key helper and the secret loader"), false);
});

test("hasSecret: entropy gate catches an unknown-vendor random token (the regex FN)", () => {
  const tok = fakeUnknownVendor();
  assert.ok(shannonEntropy(tok) >= ENTROPY_MIN_BITS, "fixture must sit above the entropy bar");
  assert.equal(SECRET_RE.test(tok), false, "the format list has no entry for this shape");
  assert.ok(hasSecret(tok), "entropy detection must close the format-list gap");
  assert.ok(hasSecret(`deploy log: token ${tok} accepted`));
});

test("isHighEntropyToken: hex digests, UUIDs, identifiers, and prose are NOT secrets", () => {
  // git SHA / digest: no uppercase → exempt by construction.
  assert.equal(isHighEntropyToken("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"), false);
  // UUID: no uppercase.
  assert.equal(isHighEntropyToken("550e8400-e29b-41d4-a716-446655440000"), false);
  // camelCase identifier: no digit / low entropy.
  assert.equal(isHighEntropyToken("getUserAuthenticationTokenFromEnvironment"), false);
  assert.equal(isHighEntropyToken("parseHttpResponseHeaders2"), false);
  // Too short even if random.
  assert.equal(isHighEntropyToken("Zq7Rt2Xk9Lp4"), false);
  // LONG camelCase with a lone digit clears 3.9 bits/char — the scattered-digit-runs
  // requirement is what keeps these out (regression: review found them redacted).
  assert.equal(isHighEntropyToken("TestSecretRedact_HandlesMultilineOutput2"), false);
  assert.equal(isHighEntropyToken("AbstractSingletonProxyFactoryBean2"), false);
  assert.equal(isHighEntropyToken("getUserAuthenticationTokenFromEnvironment2"), false);
  assert.equal(isHighEntropyToken("convertBase64ToUtf8String"), false);
});

test("hasSecret/redactSecrets: file paths and source code are never secrets (regression)", () => {
  // TOKEN_RE excludes '/', so a path splits into short segments instead of fusing
  // into one high-entropy 'token' — the #1 false positive class.
  const path = "src/components/UserProfileCard2/index.js";
  assert.equal(hasSecret(path), false);
  assert.equal(redactSecrets(path), path);
  assert.equal(hasSecret("wire up OAuth2 login in src/auth/OAuth2Provider"), false);
  // Reading auth source must not be mangled: an assigned value that is a code
  // expression is not an opaque token.
  const code = "const token = jwt.sign(payload, key)";
  assert.equal(redactSecrets(code), code);
  const ls = "ls: components/AuthFlow2/LoginForm.tsx";
  assert.equal(redactSecrets(ls), ls);
});

test("hasSecret/redactSecrets: PEM agrees case-insensitively (detect ⇒ redact)", () => {
  const lower = "-----begin rsa private key-----\nMIIEowIBAAKCAQEA\n-----end rsa private key-----";
  assert.ok(hasSecret(lower));
  assert.equal(redactSecrets(lower).includes("MIIEowIBAAKCAQEA"), false);
  const truncated = "-----BEGIN RSA PRIVATE KEY\nMIIEowIBAAKCAQEA";
  assert.ok(hasSecret(truncated));
  assert.equal(redactSecrets(truncated).includes("MIIEowIBAAKCAQEA"), false);
});

test("redactSecrets: masks formats, keeps surrounding text", () => {
  const key = fakeAnthropic("AAAAbbbbCCCCddddEEEEffff");
  const out = redactSecrets(`the key is ${key} and more`);
  assert.equal(out.includes("AAAAbbbbCCCCddddEEEE"), false);
  assert.match(out, /the key is \[REDACTED\] and more/);
});

test("redactSecrets: masks an assigned value but keeps the key name readable", () => {
  const out = redactSecrets("DB_PASSWORD=super-secret-value ok");
  assert.match(out, /DB_PASSWORD=\[REDACTED\]/);
  assert.equal(out.includes("super-secret-value"), false);
  assert.match(out, /ok$/);
});

test("redactSecrets: masks a whole PEM block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`before\n${pem}\nafter`);
  assert.equal(out.includes("MIIEowIBAAKCAQEA"), false);
  assert.match(out, /before\n\[REDACTED\]\nafter/);
});

test("redactSecrets: masks high-entropy unknown-vendor tokens, leaves prose alone", () => {
  const tok = fakeUnknownVendor();
  const prose = "the quick brown fox jumps over the lazy dog";
  assert.equal(redactSecrets(prose), prose);
  const out = redactSecrets(`credential ${tok} issued`);
  assert.equal(out.includes(tok), false);
  assert.match(out, /credential \[REDACTED\] issued/);
});

test("redactSecrets: leaves git SHAs and UUIDs untouched (they are not secrets)", () => {
  const line =
    "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b id 550e8400-e29b-41d4-a716-446655440000";
  assert.equal(redactSecrets(line), line);
});

test("redaction implies detection: anything redactSecrets rewrites, hasSecret catches", () => {
  // One-way by design: detection (a store refusal) is broader than redaction (a
  // rewrite of live tool output, which must never corrupt code or paths).
  const samples = [
    `key ${fakeAnthropic()}`,
    "token = abc123-long-value",
    `bare ${fakeUnknownVendor()}`,
    "plain prose with nothing sensitive",
    "const token = jwt.sign(payload, key)",
  ];
  for (const s of samples) {
    if (redactSecrets(s) !== s) {
      assert.ok(hasSecret(s), `redacted but not detected: ${s.slice(0, 30)}`);
    }
  }
});
