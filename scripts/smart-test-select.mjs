#!/usr/bin/env node
// CI uses the same selector as a developer's CLI. External evidence must be
// supplied by a trusted pipeline before this step to authorize a smaller run.
import { resolveChangedFiles, selectTests } from "../src/test_select.js";

const root = process.cwd();
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const head = value("--head");
const files = resolveChangedFiles(root, {
  base: value("--base"),
  head,
  changed: value("--changed"),
});
const plan = await selectTests({ root, files: files ?? [], head, evidence: value("--evidence") });
// This CI job invokes Node's test runner. A different contract requires its own runner.
if (!plan.fullSuite && (!("runner" in plan) || plan.runner !== "node:test")) {
  console.log(
    JSON.stringify({
      tier: "high",
      reason: "Evidence belongs to a different test runner",
      tests: [],
      lint: [],
      typecheck: true,
      fullSuite: true,
    }),
  );
} else console.log(JSON.stringify(plan));
