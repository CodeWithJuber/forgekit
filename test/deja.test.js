import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSummary,
  DEJA_REL_FLOOR,
  dejaAdvisory,
  dejaFromLedger,
  dejaLine,
  dejaLookup,
  isHarnessPrompt,
  recordSessionSummary,
} from "../src/deja.js";
import { mintClaim, val } from "../src/ledger.js";
import { loadClaims, putClaim, readUses, repoLedger } from "../src/ledger_store.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-deja-"));

// A minimal live claim for the pure lookup/line tests (no fs).
const claim = (kind, text, { t = 100, evidence = [] } = {}) => ({
  v: 1,
  id: `id_${kind}_${text}`.replace(/\W+/g, "").slice(0, 40),
  kind,
  body: { text },
  scope: { level: "repo" },
  provenance: { t },
  evidence,
});

test("buildSummary: sorted-unique files, redacted gist, test-pass flag", () => {
  const s = buildSummary([
    { type: "prompt", text: "add   rate limiting\nto the export route" },
    { type: "edit", file: "src/b.js" },
    { type: "edit", file: "src/a.js" },
    { type: "edit", file: "src/a.js" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ]);
  assert.deepEqual(s.files, ["src/a.js", "src/b.js"]);
  assert.equal(s.text, "add rate limiting to the export route");
  assert.equal(s.tested, true);
});

test("buildSummary: a failing-only test run is not 'tested'; null when empty", () => {
  const s = buildSummary([
    { type: "edit", file: "x.js" },
    { type: "bash", command: "npm test", exitCode: 1 },
  ]);
  assert.equal(s.tested, false);
  assert.equal(buildSummary([]), null);
  assert.equal(buildSummary([{ type: "bash", command: "ls" }]), null);
});

test("buildSummary: a secret in the first prompt is redacted out of the gist", () => {
  const s = buildSummary([
    {
      type: "prompt",
      text: "wire the client with sk-abcdEFGH1234ijklMNOP secret",
    },
    { type: "edit", file: "src/c.js" },
  ]);
  assert.ok(!/sk-abcdEFGH1234ijklMNOP/.test(s.text), "raw token must not survive");
  assert.ok(s.text.includes("[REDACTED]"));
});

test("dejaLookup only ranks task-shaped kinds (summary/lesson/diagnosis)", () => {
  const claims = [
    claim("summary", "add rate limiting to the export route"),
    claim("lesson", "update the openapi spec after changing a route"),
    claim("fact", "the export route lives in src/export.js"),
    claim("edge", "export route rate limiting"),
  ];
  const hits = dejaLookup(claims, "add rate limiting to the export route", {
    nowDay: 100,
  });
  const kinds = new Set(hits.map((h) => h.claim.kind));
  assert.ok(!kinds.has("fact") && !kinds.has("edge"), "ephemeral kinds excluded");
  assert.equal(hits[0].claim.kind, "summary", "the matching summary ranks first");
});

test("dejaLine: floor gate silences noise; verified marker rides evidence", () => {
  const strong = { claim: claim("summary", "x"), score: 0.6, rel: DEJA_REL_FLOOR + 0.1 };
  const weak = { claim: claim("summary", "x"), score: 0.9, rel: DEJA_REL_FLOOR - 0.01 };
  assert.equal(dejaLine(weak, 100), "", "below floor → silent");
  assert.ok(dejaLine(strong, 100).includes("déjà vu"));
  assert.ok(!dejaLine(strong, 100).includes("verified"), "no evidence → not verified");

  const confirmed = claim("summary", "x", {
    evidence: [
      {
        oracle: "test.run",
        result: "confirm",
        ref: "session:1",
        t: 100,
        h: "abc",
      },
    ],
  });
  assert.ok(val(confirmed, 100) > 0.5);
  assert.ok(dejaLine({ claim: confirmed, score: 0.9, rel: 1 }, 100).includes("(verified)"));
});

test("dejaAdvisory: kill switch and empty task both yield silence", () => {
  const root = fixture();
  const prev = process.env.FORGE_DEJA;
  process.env.FORGE_DEJA = "0";
  assert.equal(dejaAdvisory(root, "anything", 100), "");
  if (prev === undefined) delete process.env.FORGE_DEJA;
  else process.env.FORGE_DEJA = prev;
  assert.equal(dejaAdvisory(root, "   ", 100), "");
});

test("buildSummary: host-injected notification prompts are not the session's task", () => {
  const note =
    "<task-notification> <task-type>queued-remote-notifications</task-type> <status>pending</status>";
  assert.equal(isHarnessPrompt(note), true);
  assert.equal(isHarnessPrompt("  <system-reminder>scheduled check-in</system-reminder>"), true);
  assert.equal(isHarnessPrompt('<wake reason="external-event">'), true);
  assert.equal(
    isHarnessPrompt("fix the <Header> overflow"),
    false,
    "a tag mid-sentence is a person",
  );
  assert.equal(isHarnessPrompt("<Hero> spacing is off"), false, "a JSX name is not a host wrapper");
  // Only notifications and no edits: nothing worth remembering.
  assert.equal(buildSummary([{ type: "prompt", text: note }]), null);
  // The first prompt a person typed wins over an earlier notification.
  const s = buildSummary([
    { type: "prompt", text: note },
    { type: "prompt", text: "tighten the pricing grid gap" },
    { type: "edit", file: "src/Pricing.tsx" },
  ]);
  assert.equal(s.text, "tighten the pricing grid gap");
  // Notifications only, but files changed: fall back to the files, never the wrapper.
  const f = buildSummary([
    { type: "prompt", text: note },
    { type: "edit", file: "src/a.js" },
  ]);
  assert.equal(f.text, "touched src/a.js");
});

test("dejaAdvisory: a host-injected notification never triggers a déjà-vu lookup", () => {
  const root = fixture();
  const note = "<task-notification> <task-type>queued-remote-notifications</task-type>";
  recordSessionSummary(
    root,
    "sess-N",
    [
      { type: "prompt", text: `${note} x` },
      { type: "edit", file: "a.js" },
    ],
    100,
  );
  assert.equal(dejaAdvisory(root, note, 101), "");
});

test("recordSessionSummary mints a retrievable summary; passing tests make it verified", () => {
  const root = fixture();
  const events = [
    { type: "prompt", text: "build a paginated users endpoint" },
    { type: "edit", file: "src/users.js" },
    { type: "bash", command: "node --test", exitCode: 0 },
  ];
  const r = recordSessionSummary(root, "sess-A", events, 200);
  assert.ok(r.ok && r.id, "a summary claim is minted");
  assert.equal(r.tested, true);

  const stored = loadClaims(repoLedger(root)).find((c) => c.id === r.id);
  assert.equal(stored.kind, "summary");
  assert.ok(val(stored, 200) > 0.5, "the confirm outcome pushes val above the 0.5 prior");

  const hits = dejaFromLedger(root, "paginate the users endpoint", {
    nowDay: 200,
  });
  assert.equal(hits[0].claim.id, r.id, "the fresh summary is retrievable next session");
});

test("dejaAdvisory actually fires for a repeated task (DEJA_REL_FLOOR is inside the real range)", () => {
  // Regression guard: the gate must fire for a repeat and stay silent otherwise, or the
  // anti-repetition feature is either a silent no-op or a permanent false positive.
  const root = fixture();
  recordSessionSummary(
    root,
    "sess-oauth",
    [
      {
        type: "prompt",
        text: "add oauth login flow with pkce to the auth module",
      },
      { type: "edit", file: "src/auth.js" },
    ],
    200,
  );
  const hit = dejaAdvisory(root, "add oauth login flow with pkce to the auth module", 200);
  assert.ok(hit.includes("déjà vu"), "a repeated task surfaces the advisory");
  // A surfaced hit is a use of that claim (ledger retention learns from it)…
  const [summary] = loadClaims(repoLedger(root));
  assert.deepEqual(readUses(repoLedger(root)).get(summary.id), [200]);
  const miss = dejaAdvisory(root, "optimize the image resizing pipeline for thumbnails", 201);
  assert.equal(miss, "", "an unrelated task stays silent (below the noise floor)");
  // …and a silent miss is not.
  assert.deepEqual(readUses(repoLedger(root)).get(summary.id), [200]);
});

test("recordSessionSummary is best-effort and returns cleanly on an empty session", () => {
  const root = fixture();
  const r = recordSessionSummary(root, "sess-empty", [], 200);
  assert.equal(r.ok, false);
  assert.deepEqual(dejaFromLedger(root, "anything", { nowDay: 200 }), []);
});

test("déjà vu is gated on RELEVANCE (C8): an unrelated prompt never surfaces a symbol lesson", () => {
  const root = fixture();
  const dir = repoLedger(root);
  // The exact shape that used to fire on every prompt: a symbol-scoped lesson (scope 1.0)
  // whose total score cleared the old 0.39 floor regardless of the query.
  const lesson = mintClaim({
    kind: "lesson",
    body: {
      whatWentWrong: "broke parseConfig callers",
      correctedBehavior: "update callers of parseConfig",
      trigger: { symbols: ["parseConfig"], keywords: [], files: ["src/config.js"], action: "edit" },
    },
    scope: { level: "symbol" },
    t: 100,
  }).claim;
  putClaim(dir, lesson);
  recordSessionSummary(
    root,
    "sess-dark",
    [{ type: "prompt", text: "add dark mode toggle to the settings page" }],
    100,
  );
  for (const day of [100, 400]) {
    assert.equal(
      dejaAdvisory(root, "translate the README into French", day),
      "",
      `day ${day}: an unrelated task is silent`,
    );
    const hit = dejaAdvisory(root, "add dark mode toggle to the settings page", day);
    assert.match(hit, /déjà vu/, `day ${day}: the real repeat still fires`);
    assert.match(hit, /dark mode/);
  }
});

test("buildSummary: only a REAL test run counts as verification", () => {
  const tested = (command) =>
    buildSummary([
      { type: "prompt", text: "refactor billing" },
      { type: "bash", command, exitCode: 0 },
    ]).tested;
  assert.equal(tested("npm test"), true);
  assert.equal(tested("cd api && npx vitest run"), true);
  assert.equal(tested("echo 'run npm test later'"), false, "mentioning a test is not running one");
  assert.equal(tested("grep -r 'jest' package.json"), false);
  assert.equal(tested("npm test || true"), false, "a swallowed exit code proves nothing");
});
