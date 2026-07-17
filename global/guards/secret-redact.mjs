#!/usr/bin/env node
// PostToolUse redactor — the whole thing in Node so it no longer depends on jq (P0-05).
// Reads the hook JSON on stdin, redacts the tool output via the ONE source of truth
// (src/secrets.js), and emits an `updatedToolOutput` rewrite only when something changed.
// The shell launcher (secret-redact.sh) calls this and warns loudly if node is missing —
// redaction never silently no-ops.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  const out = typeof val === "string" ? val : JSON.stringify(val);
  if (!out) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const { redactSecrets } = await import(
    join(here, "..", "..", "src", "secrets.js")
  );
  const red = redactSecrets(out);
  if (red !== out) {
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

main().catch(() => process.exit(0));
