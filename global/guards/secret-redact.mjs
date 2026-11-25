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
//
// One kind of string is not text: a file handed to the model as base64 (Read on an image
// or a PDF, an MCP screenshot). Base64 is full of long mixed-case runs, so the entropy
// detector cut it up, the result was still a string of the right shape, and the API then
// refused the image ("invalid base64 data"). Such a leaf passes through byte-identical.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The whole string is base64 and starts with the bytes PNG, JPEG, GIF, WebP or PDF must
// start with, optionally behind a `data:` URI prefix (how Bash reports an image). A string
// that merely starts like one and goes on as text does not match, so it is still scanned;
// only whitespace may follow (a command's trailing newline). Linear time: one anchored
// pass, no nested quantifiers.
const ENCODED_MEDIA =
  /^(?:data:[\w.+-]+\/[\w.+-]+;base64,)?(?:iVBORw0KGgo|\/9j\/|R0lGOD[dl]h|UklGR[A-Za-z0-9+/]{6}XRUJQ|JVBERi0)[A-Za-z0-9+/]*={0,2}\s*$/;

/** Recursively redact every string leaf while preserving the value's exact structure. */
function redactValue(value, redactSecrets) {
  if (typeof value === "string") {
    if (ENCODED_MEDIA.test(value)) return value;
    if (Buffer.byteLength(value, "utf8") > 1024 * 1024)
      return "[Output withheld: text exceeds the 1 MiB redaction limit.]";
    return redactSecrets(value);
  }
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
  // A file:// URL, not a bare path: on Windows join() yields `C:\…\secrets.js`, which is not
  // a valid dynamic-import specifier (backslashes / drive-letter) and throws — degrading the
  // redactor to a no-op. pathToFileURL makes the import portable (no-op difference on POSIX).
  let red;
  let degraded = false;
  try {
    const { redactSecrets } = await import(
      pathToFileURL(join(here, "..", "..", "src", "secrets.js")).href
    );
    red = redactValue(val, redactSecrets);
  } catch {
    // Once the original shape is known, a failed scanner must withhold all text fields.
    degraded = true;
    const marker = "[Output withheld: ForgeKit could not check the result.]";
    red = JSON.parse(JSON.stringify(val, (_key, leaf) => typeof leaf === "string" ? marker : leaf));
    process.stderr.write("forge: secret redaction DEGRADED; tool output withheld.\n");
  }
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
          ...(degraded && process.env.FORGE_GUARD_STRICT === "1"
            ? {additionalContext:"ForgeKit redaction degraded. Tool output was withheld; repair the ForgeKit installation."} : {}),
        },
      }),
    );
  }
}

// A failure before a structured replacement can be emitted is visible to strict-mode hosts.
main().catch((err) => {
  process.stderr.write(
    `forge: secret redaction DEGRADED (${err?.message ?? err})\n`,
  );
  process.exit(process.env.FORGE_GUARD_STRICT === "1" ? 2 : 0);
});
