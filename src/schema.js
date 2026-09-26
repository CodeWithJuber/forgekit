// forge schema — narrow runtime validation for data that crosses a trust boundary: files a
// user or teammate can edit (.forge/models.json, .forge/route_outcomes.jsonl), imported
// records, and verifier events. JSDoc types are checked by tsc at build time only; bytes
// read from disk or an MCP call arrive untyped, so they are validated here before anything
// computes with them (review A04). One small, shared vocabulary instead of a bespoke partial
// validator per module. Zero dependencies (ADR-0001) — this is deliberately not a JSON-Schema
// implementation, just the handful of shapes forge's boundaries need.

/**
 * @typedef {{type: "string", nonEmpty?: boolean, max?: number, pattern?: RegExp}
 *   | {type: "number", integer?: boolean, min?: number, max?: number}
 *   | {type: "boolean"}
 *   | {type: "enum", values: readonly unknown[]}
 *   | {type: "array", items?: Spec, length?: number, maxLength?: number}
 *   | {type: "object", props?: Record<string, Spec>, required?: readonly string[]}} BaseSpec
 * @typedef {BaseSpec & {nullable?: boolean}} Spec
 */

/**
 * Every violation of `spec` by `value`, as human-readable `path: problem` strings. Numbers
 * must be FINITE (NaN/Infinity never pass). Unknown object keys are allowed (forward
 * compatibility); only the declared ones are checked.
 * @param {unknown} value
 * @param {Spec} spec
 * @param {string} [path]
 * @returns {string[]}
 */
export function violations(value, spec, path = "value") {
  if (value === null || value === undefined) return spec.nullable ? [] : [`${path}: required`];
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") return [`${path}: expected a string`];
      if (spec.nonEmpty && !value.trim()) return [`${path}: must not be empty`];
      if (spec.max !== undefined && value.length > spec.max)
        return [`${path}: longer than ${spec.max} characters`];
      if (spec.pattern && !spec.pattern.test(value)) return [`${path}: malformed`];
      return [];
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return [`${path}: expected a finite number`];
      if (spec.integer && !Number.isInteger(value)) return [`${path}: expected an integer`];
      if (spec.min !== undefined && value < spec.min) return [`${path}: below ${spec.min}`];
      if (spec.max !== undefined && value > spec.max) return [`${path}: above ${spec.max}`];
      return [];
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: expected true or false`];
    case "enum":
      return spec.values.includes(value)
        ? []
        : [`${path}: expected one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`];
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected an array`];
      if (spec.length !== undefined && value.length !== spec.length)
        return [`${path}: expected ${spec.length} items, got ${value.length}`];
      if (spec.maxLength !== undefined && value.length > spec.maxLength)
        return [`${path}: more than ${spec.maxLength} items`];
      const items = spec.items;
      return items ? value.flatMap((v, i) => violations(v, items, `${path}[${i}]`)) : [];
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected an object`];
      const o = /** @type {Record<string, unknown>} */ (value);
      const out = [];
      for (const k of spec.required ?? [])
        if (o[k] === undefined || o[k] === null)
          if (!spec.props?.[k]?.nullable) out.push(`${path}.${k}: required`);
      for (const [k, s] of Object.entries(spec.props ?? {}))
        if (o[k] !== undefined) out.push(...violations(o[k], s, `${path}.${k}`));
      return out;
    }
    default:
      return [`${path}: unknown schema type`];
  }
}

/**
 * Validate and report: `{ok: true}` or `{ok: false, errors}`.
 * @param {unknown} value
 * @param {Spec} spec
 * @param {string} [path]
 */
export function validate(value, spec, path) {
  const errors = violations(value, spec, path);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
