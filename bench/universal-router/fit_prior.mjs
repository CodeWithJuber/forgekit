#!/usr/bin/env node
// Fit the universal router's shipped prior (data/router_prior.json) from public per-task
// results. Input: a JSON file built from SWE-bench Verified and SWE-bench/experiments
// (harness-bench writes it; see bench/universal-router/README.md):
//   { source: {...}, tasks: [{id, text}], outcomes: { <registry id>: { <task id>: {resolved, cost} } } }
//
//   node bench/universal-router/fit_prior.mjs <input.json> [--out data/router_prior.json] [--only <task ids json>]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPrior } from "../../src/router/prior.js";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const input = JSON.parse(readFileSync(args[0], "utf8"));
// fileURLToPath, not `.pathname`: on Windows `.pathname` is `/C:/…`, which is not a path.
const out = opt("--out", fileURLToPath(new URL("../../data/router_prior.json", import.meta.url)));
const only = opt("--only") ? new Set(JSON.parse(readFileSync(opt("--only"), "utf8"))) : null;
const t0 = Date.now();
const prior = buildPrior(input, only);
writeFileSync(out, `${JSON.stringify(prior, null, 2)}\n`);
console.log(
  `wrote ${out}: ${prior.models.length} models, ${prior.provenance.tasks} tasks, k=${prior.mirt.k}, ` +
    `scale=${prior.selection.chosen.scale}, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
