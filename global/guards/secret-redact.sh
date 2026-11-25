#!/usr/bin/env bash
# PostToolUse guard — redact secrets from a tool's output BEFORE it enters context, using
# the `updatedToolOutput` hook primitive. Thin launcher: all parse/redact/emit logic lives
# in secret-redact.mjs (Node) against the ONE source of truth (src/secrets.js), so the guard
# no longer depends on jq. Stream stdin directly to the scanner so large payloads never
# short-circuit on a prefilter's pipe. The guard reports missing dependencies on stderr.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd -P)"
MJS="$DIR/secret-redact.mjs"
if command -v node >/dev/null 2>&1 && [ -f "$MJS" ]; then
  exec node "$MJS"
fi

# A secret-shaped candidate is present but we cannot redact — do NOT silently drop it.
# FORGE_GUARD_STRICT=1 escalates the degradation to exit 2 (stderr surfaced to Claude);
# default is advisory. Neither mode can block a PostToolUse — the tool already ran.
echo "forge secret-redact: DEGRADED — node unavailable or redactor missing; tool output was NOT scanned for secrets. Install Node 20+ to restore redaction." >&2
if [ "${FORGE_GUARD_STRICT:-0}" = "1" ]; then
  exit 2
fi
exit 0
