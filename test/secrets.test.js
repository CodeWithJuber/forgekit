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

// ── B1: linear time. The old ASSIGNED branch (`\b[\w-]*KEY[\w-]*…`) was cubic on long
// runs of key-ish words: 6 KB of `token-token-…` took 5 s, 12 KB took 40 s — past the
// hook timeout, so a large tool output passed through UNREDACTED. Sizes grow so a
// regression fails fast at the first over-budget size instead of hanging the suite.
test("hasSecret/redactSecrets: linear time on pathological inputs (ReDoS regression)", () => {
  const BUDGET_MS = 500;
  const units = [
    "token-",
    "a-",
    "a",
    "-----BEGIN ",
    "secret_",
    "password=",
    "token:",
    "x://a:",
    "auth=",
    "Authorization: Bearer ",
    "sha512-",
  ];
  const time = (fn) => {
    const t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  for (const u of units) {
    for (const n of [2500, 5000, 10000, 20000, 40000]) {
      const s = u.repeat(Math.ceil(n / u.length)).slice(0, n);
      const has = time(() => hasSecret(s));
      const red = time(() => redactSecrets(s));
      assert.ok(has < BUDGET_MS, `hasSecret(${JSON.stringify(u)} ×${n}) took ${has.toFixed(0)}ms`);
      assert.ok(
        red < BUDGET_MS,
        `redactSecrets(${JSON.stringify(u)} ×${n}) took ${red.toFixed(0)}ms`,
      );
    }
  }
});

// ── B2: detection gaps. Credential literals are assembled at runtime (see _fixtures.js).
const b64ish = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const pw = ["Xk9pLm2Q", "r7Ws4Tz8"].join("");

test("hasSecret/redactSecrets: URL userinfo credentials are caught and masked (B2)", () => {
  for (const [url, keep] of [
    [`postgres://app:${pw}@db.example.com:5432/app`, "postgres://app:[REDACTED]@db.example.com"],
    [`amqp://guest:${pw}@rabbit.internal:5672/vhost`, "amqp://guest:[REDACTED]@rabbit"],
    [`redis://:${pw}@cache:6379/0`, "redis://:[REDACTED]@cache:6379/0"],
    [
      `mongodb+srv://admin:${pw}@cluster0.abcde.mongodb.net/test`,
      "mongodb+srv://admin:[REDACTED]@",
    ],
    [
      `https://oauth2:${["glpat", "AbCdEfGhIjKlMnOpQrSt"].join("-")}@gitlab.com/g/r.git`,
      "@gitlab.com",
    ],
    [`DATABASE_URL=postgres://app:${pw}@db.example.com/app`, "DATABASE_URL=postgres://app:"],
  ]) {
    assert.ok(hasSecret(url), `detect: ${url}`);
    const out = redactSecrets(url);
    assert.equal(out.includes(pw), false, `redact: ${url} -> ${out}`);
    assert.ok(out.includes(keep), `keeps context: ${out}`);
  }
});

test("hasSecret/redactSecrets: ordinary URLs without userinfo are not secrets (B2 precision)", () => {
  for (const url of [
    "https://example.com:8080/path?x=1",
    "http://localhost:3000/api",
    "ssh://git@github.com:22/org/repo.git",
    "git@github.com:org/repo.git",
    "http://[::1]:8080/",
    "https://user@host.example.com/x",
  ]) {
    assert.equal(hasSecret(url), false, `no FP: ${url}`);
    assert.equal(redactSecrets(url), url, `untouched: ${url}`);
  }
});

test("hasSecret/redactSecrets: AWS STS, AUTH/CREDENTIALS env, TypeSafe keys (B2)", () => {
  const asia = ["AS", "IA", "Q7K2M9X4B8N3P5R6"].join("");
  const hex40 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
  const hex64 = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
  const typesafe = ["api", `key_${hex40}_${hex64}`].join("");
  for (const s of [
    `aws_session key ${asia}`,
    "AUTH=Basic dXNlcjpwYXNzd29yZA==",
    "CREDENTIALS=abcdefghijklmnop",
    typesafe,
    `Authorization: Bearer ${typesafe}`,
  ]) {
    assert.ok(hasSecret(s), `detect: ${s.slice(0, 30)}`);
    const out = redactSecrets(s);
    assert.match(out, /\[REDACTED\]/, `redact: ${s.slice(0, 30)}`);
    for (const frag of [asia, "dXNlcjpwYXNzd29yZA", "abcdefghijklmnop", hex40]) {
      assert.equal(out.includes(frag), false, `no leak of ${frag} in ${out}`);
    }
  }
  // "auth"/"credentials" only count in the env/query grammar — never prose, YAML, or a
  // longer word that merely starts with them.
  for (const s of [
    "auth: use OAuth",
    '"author": "someone"',
    "author=someone",
    'fetch(u, { credentials: "include" })',
  ]) {
    assert.equal(hasSecret(s), false, `no FP: ${s}`);
  }
});

test("redactSecrets: an assigned value is masked WHOLE — past '/' and below 8 chars (B2)", () => {
  // Unquoted values used to be masked only up to the first '/', leaking ~16 chars of
  // 30% of AWS secrets; values under 8 chars were detected but never masked.
  for (const s of [
    `export AWS_SECRET_ACCESS_KEY=${b64ish}`,
    `aws_secret_access_key = ${b64ish}`,
    "DB_PASSWORD=hunter2",
    "DB_PASSWORD=p@ssw0rd!2024",
    "password: Tr0ub4dor&3",
    "curl https://api.example.com/cb?state=x&access_token=abc123",
  ]) {
    const out = redactSecrets(s);
    assert.ok(hasSecret(s), `detect: ${s}`);
    for (const frag of ["K7MDENG", "bPxRfiCY", "wJalrX", "hunter2", "ssw0rd", "4dor", "abc123"]) {
      assert.equal(out.includes(frag), false, `no leak of ${frag}: ${out}`);
    }
  }
  assert.equal(redactSecrets("DB_PASSWORD=hunter2 ok"), "DB_PASSWORD=[REDACTED] ok");
  // …but never a variable reference, a kwarg, a path, or a counter that merely has a
  // secret word in its NAME.
  for (const s of [
    ["DB_PASSWORD=$", "{DB_PASSWORD}"].join(""), // a shell expansion, not a value
    "export TOKEN=$1",
    "f(password=pw)",
    "secret_dir = /etc/app/config",
    "MAX_TOKENS=4096",
    "TOKEN_TTL=3600",
    "token = process.env.TOKEN",
    "password: string;",
  ]) {
    assert.equal(redactSecrets(s), s, `untouched: ${s}`);
  }
});

// ── B4: content-integrity digests are public, random-looking by design. The entropy leg
// flagged 90-100% of lockfile/SRI/go.sum hashes, so every lockfile commit was refused.
test("hasSecret/redactSecrets: lockfile / SRI / go.sum integrity digests are not secrets (B4)", () => {
  const leftPad =
    '"integrity": "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",';
  for (const line of [
    leftPad, // the real left-pad@1.3.0 package-lock line
    "  integrity sha512-+SEC/mFk1a+5mvUANZgbZTaiZXs1nj4iMhL/PHiqDT5TPUEPFIlliEtkKKZB4N862yylHC3UI+/Sj2I0HJEqhA==",
    '<script src="x.js" integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"></script>',
    "github.com/foo/bar v1.2.3 h1:Zq7Rt2Xk9Lp4Vm1Nc8Yb5Ws3Hd6Fg0Aa1Bb2Cc3Dd4E=",
    '"integrity": "sha1-Zq7Rt2Xk9Lp4Vm1Nc8Yb5Ws3Hd6=",',
  ]) {
    assert.equal(hasSecret(line), false, `no FP: ${line.slice(0, 40)}`);
    assert.equal(redactSecrets(line), line);
  }
  // The exemption is shape-bound: a real token beside a digest is still caught.
  assert.ok(hasSecret(`${leftPad} ${fakeGithubPat()}`));
});

// ── The XMP packet id is a published constant (Adobe XMP spec), present in every
// PDF/JPEG/PNG with XMP metadata; the entropy leg flagged it, refusing binary commits.
test("hasSecret/redactSecrets: the XMP packet id is a public constant, not a secret", () => {
  const xmp = "W5M0MpCehiHzreSzNTczkc9d";
  assert.ok(isHighEntropyToken(xmp), "it clears the entropy bar on its own — hence the exemption");
  const packet = `<?xpacket begin="" id="${xmp}"?>`;
  assert.equal(hasSecret(packet), false);
  assert.equal(redactSecrets(packet), packet);
  // Whole-token only: a longer run that merely contains the constant is still scored.
  assert.ok(hasSecret(`x ${xmp}Qx7Lp2`));
  assert.ok(hasSecret(`${packet} ${fakeGithubPat()}`), "a real token beside it is still caught");
});

test("hasSecret/redactSecrets {entropy:false}: format grammars only", () => {
  const tok = fakeUnknownVendor();
  assert.equal(hasSecret(tok, { entropy: false }), false, "entropy-only token passes");
  assert.equal(redactSecrets(tok, { entropy: false }), tok);
  assert.ok(hasSecret(fakeGithubPat(), { entropy: false }), "format grammar still applies");
  assert.notEqual(redactSecrets(fakeGithubPat(), { entropy: false }), fakeGithubPat());
  assert.ok(hasSecret(tok), "the default keeps the entropy leg");
});
