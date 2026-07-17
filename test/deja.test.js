import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSummary,
  DEJA_FLOOR,
  dejaAdvisory,
  dejaFromLedger,
  dejaLine,
  dejaLookup,
  recordSessionSummary,
} from "../src/deja.js";
import { val } from "../src/ledger.js";
import { loadClaims, repoLedger } from "../src/ledger_store.js";

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
  const strong = { claim: claim("summary", "x"), score: DEJA_FLOOR + 0.1 };
  const weak = { claim: claim("summary", "x"), score: DEJA_FLOOR - 0.01 };
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
  assert.ok(dejaLine({ claim: confirmed, score: 0.9 }, 100).includes("(verified)"));
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

test("recordSessionSummary is best-effort and returns cleanly on an empty session", () => {
  const root = fixture();
  const r = recordSessionSummary(root, "sess-empty", [], 200);
  assert.equal(r.ok, false);
  assert.deepEqual(dejaFromLedger(root, "anything", { nowDay: 200 }), []);
});
