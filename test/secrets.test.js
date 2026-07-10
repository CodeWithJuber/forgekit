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

test("hasSecret and redactSecrets agree: anything redacted is detected", () => {
  const samples = [
    `key ${fakeAnthropic()}`,
    "token = abc123",
    `bare ${fakeUnknownVendor()}`,
    "plain prose with nothing sensitive",
  ];
  for (const s of samples) {
    assert.equal(
      redactSecrets(s) !== s,
      hasSecret(s),
      `detect/redact must agree on: ${s.slice(0, 30)}`,
    );
  }
});
