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
    *" | sh"*|*" | bash"*) deny "piping remote content to a shell is blocked." ;;
  esac
fi

exit 0
