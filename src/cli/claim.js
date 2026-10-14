// forge CLI — the claim interop commands: `claim export`. Domain logic lives in
// ../claim_export.js; dispatch and presentation here. cli.js registers these into
// its dispatch table; nothing here runs at import time.
import { writeFileSync } from "node:fs";
import { BRAND, heading, paint } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

HANDLERS.claim = async (argv) => {
  const [sub, ...rest] = argv.slice(1);
  if (sub === "export") return cmdExport(rest);
  console.error(`  ${BRAND.cli} claim: unknown subcommand ${sub ?? "(none)"} — export`);
  console.error(paint(`  usage: ${BRAND.cli} claim export [--out <file>] [--pretty]`, "dim"));
  process.exitCode = 1;
};

/**
 * `forge claim export` — dump the repo ledger's live claims as interoperable JSON
 * (`forge-claim-export/1`). Any tool can read this without knowing forge internals;
 * it is step 1 toward claims as an open standard.
 * @param {string[]} argv
 */
async function cmdExport(argv) {
  const { CLAIM_EXPORT_FORMAT, exportClaims } = await import("../claim_export.js");
  const outIdx = argv.indexOf("--out");
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && !outFile) {
    console.error(`  ${BRAND.cli} claim export: --out needs a file path`);
    process.exitCode = 1;
    return;
  }
  const pretty = argv.includes("--pretty");
  const unknown = argv.filter(
    (a) =>
      a.startsWith("--") &&
      a !== "--out" &&
      a !== "--pretty" &&
      argv[argv.indexOf(a) - 1] !== "--out",
  );
  if (unknown.length) {
    console.error(`  ${BRAND.cli} claim export: unknown flag ${unknown[0]}`);
    process.exitCode = 1;
    return;
  }
  const doc = exportClaims();
  const json = pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
  if (outFile) {
    writeFileSync(outFile, `${json}\n`, "utf8");
    heading(`${BRAND.brand} claim export\n`);
    console.log(`  exported ${doc.claimCount} claim(s) → ${outFile}`);
  } else {
    console.log(json);
    return;
  }
  if (doc.refusedSecret > 0)
    console.log(
      paint(`  refused ${doc.refusedSecret} secret-shaped claim(s) — never exported`, "warn"),
    );
  console.log(paint(`  format: ${CLAIM_EXPORT_FORMAT}`, "dim"));
}

export default HANDLERS;
