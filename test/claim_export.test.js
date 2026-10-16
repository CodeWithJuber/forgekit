// claim_export tests — the interoperable format must be self-describing and
// secret-safe.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_EXPORT_FORMAT, exportOne } from "../src/claim_export.js";

test("claim_export: format id is pinned and versioned", () => {
  assert.equal(CLAIM_EXPORT_FORMAT, "forge-claim-export/1");
});

test("claim_export: exportOne renders the interoperable shape", () => {
  const claim = {
    id: "abc123",
    kind: "fact",
    body: { text: "the sky is blue" },
    scope: { level: "repo" },
    provenance: { t: 20000, author: "test" },
    evidence: [{ oracle: "human.accept", result: "confirm", t: 20001 }],
    tombstone: null,
  };
  const e = exportOne(claim, 20010);
  assert.ok(e);
  assert.equal(e.id, "abc123");
  assert.equal(e.kind, "fact");
  assert.deepEqual(e.body, { text: "the sky is blue" });
  assert.equal(e.tombstoned, false);
  assert.ok(typeof e.confidence === "number");
  assert.equal(e.evidence.length, 1);
  assert.equal(e.evidence[0].oracle, "human.accept");
});

test("claim_export: exportOne refuses secret-shaped claims", () => {
  const claim = {
    id: "sec1",
    kind: "fact",
    body: { text: 'api_key = "sk-live-9f8e7d6c5b4a"' },
    scope: {},
    provenance: {},
    evidence: [],
    tombstone: null,
  };
  assert.equal(exportOne(claim), null);
});

test("claim_export: tombstoned claims export with the flag set", () => {
  const claim = {
    id: "dead1",
    kind: "lesson",
    body: { text: "old lesson" },
    scope: {},
    provenance: {},
    evidence: [],
    tombstone: { reason: "retracted", t: 20005 },
  };
  const e = exportOne(claim);
  assert.ok(e);
  assert.equal(e.tombstoned, true);
});
