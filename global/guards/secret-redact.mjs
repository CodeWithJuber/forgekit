#!/usr/bin/env node
// PostToolUse redactor — the whole thing in Node so it no longer depends on jq (P0-05).
// Reads the hook JSON on stdin, redacts the tool output via the ONE source of truth
// (src/secrets.js), and emits an `updatedToolOutput` rewrite only when something changed.
// The shell launcher (secret-redact.sh) calls this and warns loudly if node is missing —
// redaction never silently no-ops.
//
// CR-01: `updatedToolOutput` must match the tool's ORIGINAL output shape — built-in tools
// (Bash, Read, Grep, …) return structured objects, and Claude Code ignores a replacement
// whose shape doesn't match, silently keeping the unredacted original. So redaction is
// recursive and type-preserving: strings are redacted in place, arrays/objects keep their
// exact keys and structure, and every non-string leaf (numbers, booleans, null) passes
// through untouched. A string response stays a string; an object response stays an object.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Recursively redact every string leaf while preserving the value's exact structure. */
function redactValue(value, redactSecrets) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value))
    return value.map((v) => redactValue(v, redactSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v, redactSecrets)]),
    );
  }
  return value;
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // not JSON we understand — leave output untouched
  }

  const val = data.tool_response ?? data.tool_output;
  if (val == null) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const { redactSecrets } = await import(
    join(here, "..", "..", "src", "secrets.js")
  );
  const red = redactValue(val, redactSecrets);
  // Emit a rewrite only when something actually changed. Compare canonically so an
  // untouched structured response produces no output at all (the common case).
  const changed =
    typeof val === "string"
      ? red !== val
      : JSON.stringify(red) !== JSON.stringify(val);
  if (changed) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: red,
        },
      }),
    );
  }
}

// RA-06/CR-02: never fail silently — a broken redactor means the ORIGINAL, unredacted
// output passes through, so say so loudly on stderr. FORGE_GUARD_STRICT=1 exits 2, which
// surfaces the stderr warning to Claude as hook feedback. NOTE: PostToolUse fires AFTER
// the tool ran, so exit 2 here can NOT block or undo the tool call — it is visibility,
// not enforcement. Confidentiality enforcement belongs in PreToolUse (protect-paths.sh).
main().catch((err) => {
  process.stderr.write(
    `forge: secret redaction DEGRADED (${err?.message ?? err})\n`,
  );
  process.exit(process.env.FORGE_GUARD_STRICT === "1" ? 2 : 0);
});
