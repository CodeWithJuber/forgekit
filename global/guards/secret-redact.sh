#!/usr/bin/env bash
# PostToolUse guard — redact secrets from a tool's output BEFORE it enters context, using
# the `updatedToolOutput` hook primitive. Thin launcher: all parse/redact/emit logic lives
# in secret-redact.mjs (Node) against the ONE source of truth (src/secrets.js), so the guard
# no longer depends on jq. A cheap shell prefilter skips the node spawn for the common case
# (most tool output has nothing secret-shaped). If a candidate IS present but the redactor
# cannot run, it prints a VISIBLE degraded-security warning instead of silently passing the
# secret through (P0-05). Advisory: only emits a rewrite when something changed, never blocks.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd -P)"
MJS="$DIR/secret-redact.mjs"
INPUT="$(cat)"

# Fast prefilter over the raw hook JSON — skip node entirely unless a credential-shaped
# candidate (known prefix, PEM header, key-ish assignment, or a 20+ char token run) exists.
printf '%s' "$INPUT" | grep -qE -- '-----BEGIN |ghp_|github_pat_|sk-|xox[baprs]-|AIza|ya29\.|eyJ|AKIA|(api[_-]?key|secret|passwd|password|token)[A-Za-z0-9_-]*["'"'"']?[[:space:]]*[:=]|[A-Za-z0-9+=_-]{20,}' || exit 0

if command -v node >/dev/null 2>&1 && [ -f "$MJS" ]; then
  printf '%s' "$INPUT" | node "$MJS"
  exit 0
fi

# A secret-shaped candidate is present but we cannot redact — do NOT silently drop it.
echo "forge secret-redact: DEGRADED — node unavailable or redactor missing; tool output was NOT scanned for secrets. Install Node 20+ to restore redaction." >&2
exit 0
