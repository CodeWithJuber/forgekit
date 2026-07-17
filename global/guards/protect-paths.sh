#!/usr/bin/env bash
# PreToolUse hook: block edits to secret/credential files and obviously destructive Bash.
# Exit 2 = block the tool call and feed the reason back to Claude (works across versions).
set -euo pipefail

input="$(cat)"

# Extract fields without requiring jq (fallback to grep).
if command -v jq >/dev/null 2>&1; then
  tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
  fpath="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
else
  tool="$(printf '%s' "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  fpath="$(printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  cmd="$(printf '%s' "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
fi

deny() {
  # Structured decision for current Claude Code; exit-2 + stderr as the version-agnostic fallback.
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  fi
  echo "BLOCKED by protect-paths guard: $1" >&2
  exit 2
}

# Protect secret/credential files from writes.
case "$fpath" in
  *.env|*/.env|*.env.*|*/.env.*) deny "refusing to modify env file ($fpath). Edit it yourself if intended." ;;
  *.pem|*/id_rsa|*/id_ed25519|*.key) deny "refusing to modify credential/key file ($fpath)." ;;
  */secrets/*|*/.ssh/*) deny "refusing to modify path under secrets/ or .ssh/ ($fpath)." ;;
esac

# Guard clearly destructive shell commands.
if [ -n "${cmd:-}" ]; then
  case "$cmd" in
    *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf --no-preserve-root"*) deny "destructive rm detected." ;;
    *"git push --force"*|*"git push -f"*) deny "force-push blocked. Ask the user first." ;;
    *"DROP TABLE"*|*"DROP DATABASE"*|*"TRUNCATE "*) deny "destructive SQL detected. Confirm with the user." ;;
  esac
  # Close the Bash secret-READ bypass (P0-04): the Read tool denies .env/keys, but a shell
  # `cat .env` / `git show HEAD:.env` sidesteps that. Match a reader command anchored to a
  # real command boundary (start, or after ; | &) so prose inside a quoted arg (a commit
  # message mentioning ".env") isn't a false positive, AND require a protected path token.
  # Best-effort defence in depth — a content scan like `rg TOKEN .` with no named path can't
  # be caught here; that's what secret-redact.sh is for.
  reader='(^|[;&|])[[:space:]]*((cat|less|more|head|tail|nl|xxd|od|strings|base64|rg|grep|ag)[[:space:]]|git[[:space:]]+(show|log)[[:space:]])'
  # \b anchors the extensions so `.key` matches a real key file but NOT `Object.keys`,
  # and `.env` matches `.env`/`.env.prod` but NOT `.environment`.
  secret='(\.env(\.[A-Za-z0-9_-]+)?\b|id_rsa\b|id_ed25519\b|\.pem\b|\.key\b|/secrets/|/\.ssh/)'
  if printf '%s' "$cmd" | grep -qE "$reader" && printf '%s' "$cmd" | grep -qE "$secret"; then
    deny "reading a protected secret path via Bash is blocked. Read it yourself if intended."
  fi
  # Pipe-to-shell (e.g. curl … | sh). Boundary-aware so legit `… | shellcheck` is not caught.
  if [[ "$cmd" =~ \|[[:space:]]*(sh|bash|zsh)([[:space:]]|$) ]]; then
    deny "piping content to a shell is blocked."
  fi
fi

exit 0
