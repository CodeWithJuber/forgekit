#!/usr/bin/env node
// Hook-JSON field reader for the bash guards — a real JSON parser, so no guard depends on
// jq (absent from stock Git for Windows and many minimal images) and none falls back to a
// regex. The old grep fallback stopped at the first escaped quote: `echo "x"; cat .env`
// was read as `echo \`, so the secret-read deny never fired, and the status line lost
// every segment. node is always present where the guards run — every hook is launched as
// `node run.mjs <guard>.sh`.
//
//   node hookfield.mjs <path>          → that field, raw (no trailing newline)
//   node hookfield.mjs -0 <path>...    → "1", then each field, every one NUL-terminated
//
// A path is dot-separated (`tool_input.command`); `a|b` tries alternatives and the first
// non-empty wins. Missing/null → empty; a number/boolean/object prints as JSON text (what
// `jq -r` prints). Empty stdin reads as `{}`. Invalid JSON → exit 3 and NO output, so a
// `-0` caller that finds no leading "1" knows the parse failed and can fail closed.
// Node built-ins only.

/** @param {unknown} root @param {string} path */
function field(root, path) {
  for (const alt of path.split("|")) {
    /** @type {unknown} */
    let v = root;
    for (const key of alt.split(".")) {
      v =
        v !== null && typeof v === "object"
          ? /** @type {Record<string, unknown>} */ (v)[key]
          : undefined;
    }
    if (v === undefined || v === null || v === "") continue;
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  return "";
}

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
/** @type {unknown} */
let data;
try {
  data = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.exit(3);
}
const args = process.argv.slice(2);
if (args[0] === "-0") {
  process.stdout.write(
    `1\0${args
      .slice(1)
      .map((p) => `${field(data, p)}\0`)
      .join("")}`,
  );
} else if (args[0]) {
  process.stdout.write(field(data, args[0]));
}
