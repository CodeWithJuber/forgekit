# shellcheck shell=bash
# Sourced helpers for Forge guards. Not executable on its own.
# Provides field extraction (jq or grep) and an atomic re-entrancy lock so a
# guard can never recurse — the class of bug behind the runaway-loop cost
# incident (claude-code #4095: 1.67B tokens / 5h, est. $16k–50k).

# forge_field <key> — read a field from $INPUT (the raw hook JSON on stdin).
forge_field() {
  if command -v jq >/dev/null 2>&1; then
    case "$1" in
      command) printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' ;;
      file_path) printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' ;;
      *) printf '%s' "$INPUT" | jq -r ".$1 // empty" ;;
    esac
  else
    printf '%s' "$INPUT" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
  fi
}

# forge_lock <key> — return 0 if the lock was acquired, 1 if already held.
# Atomic via mkdir; auto-released on process exit; reclaims locks older than 60s.
forge_lock() {
  local dir="${TMPDIR:-/tmp}/forge-lock-$1"
  if mkdir "$dir" 2>/dev/null; then
    trap 'rmdir "'"$dir"'" 2>/dev/null || true' EXIT
    return 0
  fi
  # Reclaim only locks older than 10 min — safely longer than any guard's real
  # hold (the session-learner model call is capped at ~90s), so we never steal a
  # lock that's still legitimately held.
  if [ -n "$(find "$dir" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$dir" 2>/dev/null || true
    mkdir "$dir" 2>/dev/null && { trap 'rmdir "'"$dir"'" 2>/dev/null || true' EXIT; return 0; }
  fi
  return 1
}
