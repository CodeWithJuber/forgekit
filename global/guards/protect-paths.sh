#!/usr/bin/env bash
# PreToolUse hook: block reads/edits of secret/credential files and obviously destructive Bash.
# Thin launcher: the payload parsing and the whole rule set live in protect-paths.mjs (Node),
# the same split secret-redact.sh uses — one real JSON parser instead of jq-or-a-regex, and no
# shell pipeline that can lose a match to SIGPIPE under `pipefail`. The hook launcher (run.mjs)
# skips this file and runs protect-paths.mjs on node directly, fail-closed; this shim remains for
# direct `bash protect-paths.sh` callers.
# Exit 2 = block the tool call and feed the reason back to Claude (works across versions).
# FAIL CLOSED: exit 1 is a NON-blocking hook error in Claude Code, so a guard that cannot
# evaluate the call must deny, never fall through.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MJS="$DIR/protect-paths.mjs"
INPUT="$(cat)"

if command -v node >/dev/null 2>&1 && [ -f "$MJS" ]; then
  # Propagate the verdict verbatim — an exit 2 here is what blocks the tool call.
  printf '%s' "$INPUT" | node "$MJS"
  exit "$?"
fi

echo "BLOCKED by protect-paths guard: node unavailable or protect-paths.mjs missing — the guard cannot evaluate this tool call, so it is blocked (install Node 20+ to restore it)." >&2
exit 2
