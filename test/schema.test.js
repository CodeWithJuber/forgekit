// Review 2026-09-26 — A04: runtime validation at trust boundaries (files users/teammates can
// edit, imported records), since JSDoc types are only checked at build time.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { outcomeRecord, val, validOutcome } from "../src/ledger.js";
import { loadRegistry } from "../src/router/registry.js";
import { validate, violations } from "../src/schema.js";

test("schema: finite numbers, bounds, enums, arrays and nested objects", () => {
  const spec = /** @type {import("../src/schema.js").Spec} */ ({
    type: "object",
    required: ["id", "cost"],
    props: {
      id: { type: "string", nonEmpty: true, max: 5 },
      cost: { type: "number", min: 0 },
      kind: { type: "enum", values: ["a", "b"] },
      x: { type: "array", items: { type: "number" }, length: 2 },
      note: { type: "string", nullable: true },
    },
  });
  assert.equal(validate({ id: "m1", cost: 0.1, kind: "a", x: [1, 2], note: null }, spec).ok, true);
  const errs = violations(
    { id: "", cost: Number.POSITIVE_INFINITY, kind: "z", x: [1, Number.NaN, 3] },
    spec,
    "row",
  );
  assert.ok(errs.includes("row.id: must not be empty"), errs.join("|"));
  assert.ok(errs.includes("row.cost: expected a finite number"));
  assert.ok(errs.some((e) => e.startsWith("row.kind: expected one of")));
  assert.ok(errs.includes("row.x: expected 2 items, got 3"));
  assert.deepEqual(violations(undefined, spec), ["value: required"]);
  assert.deepEqual(violations({ id: "ok", cost: -1 }, spec), ["value.cost: below 0"]);
});

test("registry overrides: malformed entries are refused and reported, valid ones apply", () => {
  const d = mkdtempSync(join(tmpdir(), "forge-schema-"));
  mkdirSync(join(d, ".forge"), { recursive: true });
  writeFileSync(
    join(d, ".forge", "models.json"),
    JSON.stringify({
      models: [
        { id: "cheap-local", price_in: 0.1, price_out: 0.2, providers: { gw: "local/x" } },
        { id: "negative", price_in: -1, price_out: 1 },
        { id: "bad-provider", providers: { gw: 42 } },
        { price_in: 1 },
      ],
    }),
  );
  const reg = loadRegistry(d);
  assert.ok(reg.models.some((m) => m.id === "cheap-local"));
  assert.ok(!reg.models.some((m) => m.id === "negative" || m.id === "bad-provider"));
  assert.equal(reg.warnings.length, 3, reg.warnings.join("\n"));
  writeFileSync(join(d, ".forge", "models.json"), "{ not json");
  assert.match(loadRegistry(d).warnings[0], /not valid JSON/);
});

test("evidence records: a non-finite day or an oversized ref never counts", () => {
  const ok = outcomeRecord({ oracle: "test.run", result: "confirm", ref: "ci:1", t: 3 }).outcome;
  assert.equal(validOutcome(ok), true);
  assert.equal(validOutcome({ ...ok, t: Number.NaN }), false);
  assert.equal(validOutcome({ ...ok, t: "3" }), false);
  assert.equal(validOutcome({ ...ok, ref: `ci:${"9".repeat(3000)}` }), false);
  assert.equal(val({ evidence: [{ ...ok, t: Number.NaN }] }, 3), 0.5, "ignored, not poisoning val");
});
