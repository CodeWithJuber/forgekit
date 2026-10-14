// forge claim export — interoperable claim export (step 1 toward an open standard).
// The ledger's on-disk format is content-addressed and forge-specific; this module
// renders claims into a self-describing JSON document any tool can read without
// knowing forge internals. Format version is pinned in FORMAT so consumers can
// gate on it: `forge-claim-export/1`.
//
// Design: every exported claim carries its id, kind, body, scope, provenance,
// evidence outcomes, and a computed confidence — the full state another system
// needs to import the claim WITHOUT trusting forge's decay math (it can recompute
// or apply its own). Secrets are never exported: bodies are scanned with hasSecret
// and refused, same rule as mint.

import { val } from "./ledger.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { hasSecret } from "./secrets.js";
import { epochDay } from "./util.js";

/** The export format id — consumers gate on this. Bump on breaking changes. */
export const CLAIM_EXPORT_FORMAT = "forge-claim-export/1";

/**
 * Render one materialized claim into the interoperable shape.
 * @param {any} claim a materialized claim (ledger_store.loadClaims view)
 * @param {number} nowDay epoch day for the confidence decay clock
 * @returns {object|null} null when the claim body is secret-shaped (refused)
 */
export function exportOne(claim, nowDay = epochDay()) {
  const bodyText = JSON.stringify(claim.body ?? {});
  if (hasSecret(bodyText)) return null; // never export secret-shaped claims
  return {
    id: claim.id,
    kind: claim.kind,
    body: claim.body ?? {},
    scope: claim.scope ?? {},
    provenance: claim.provenance ?? {},
    evidence: (claim.evidence ?? []).map((e) => ({
      oracle: e.oracle ?? null,
      result: e.result ?? null,
      t: e.t ?? 0,
      note: e.note ?? undefined,
    })),
    confidence: val(claim, nowDay),
    tombstoned: Boolean(claim.tombstone),
  };
}

/**
 * Export the repo ledger's live claims in the interoperable format.
 * @param {string} [dir] ledger dir (default: repo ledger at cwd)
 * @param {{nowDay?: number}} [opts]
 * @returns {{format: string, exportedAt: string, claimCount: number, refusedSecret: number, claims: object[]}}
 */
export function exportClaims(dir = repoLedger(), { nowDay = epochDay() } = {}) {
  const claims = loadClaims(dir);
  const out = [];
  let refusedSecret = 0;
  for (const c of claims) {
    const e = exportOne(c, nowDay);
    if (!e) {
      refusedSecret += 1;
      continue;
    }
    out.push(e);
  }
  return {
    format: CLAIM_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    claimCount: out.length,
    refusedSecret,
    claims: out,
  };
}
