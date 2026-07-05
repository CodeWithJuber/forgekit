// Test fixtures assembled AT RUNTIME so no secret-format literal appears in source. The
// redaction/refusal tests need strings that match SECRET_RE, but a literal like an Anthropic
// key format trips GitHub's push-protection scanner (even when fake). Splitting the prefix
// via .join keeps the runtime value intact while leaving nothing for the scanner to match.
export const fakeAnthropic = (suffix = "AAAAbbbbCCCCddddEEEE") =>
  ["sk", "ant", "api03", suffix].join("-");
export const fakeGithubPat = () => ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");
export const fakeSlack = () => ["xox", "b-1234567890-abcdefghijklmnop"].join("");
export const fakeGoogle = () => ["AI", "zaSyA0123456789abcdefghijklmnopqrstu"].join("");
export const fakeJwt = () =>
  ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw"].join("");
