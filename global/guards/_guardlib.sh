# shellcheck shell=bash
# Sourced helpers for Forge guards. Not executable on its own.
# Provides field extraction (a real JSON parser) and an atomic re-entrancy lock so a
# guard can never recurse — the class of bug behind the runaway-loop cost
# incident (claude-code #4095: 1.67B tokens / 5h, est. $16k–50k).

GUARDLIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# forge_field <key> — read a field from $INPUT (the raw hook JSON on stdin).
# `command`/`file_path` are the usual `tool_input.*` shortcuts; anything else is read from
# the top level. Parsed by jq when it is installed, else by node through hookfield.mjs —
# never by a regex: the old grep fallback cut the value at the first escaped quote, so
# `echo "x"; cat .env` arrived as `echo \` and every rule after it silently missed.
forge_field() {
  local path
  case "$1" in
    command | file_path) path="tool_input.$1" ;;
    *) path="$1" ;;
  esac
  if command -v jq > /dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -r ".${path} // empty"
  else
    printf '%s' "$INPUT" | node "$GUARDLIB_DIR/hookfield.mjs" "$path"
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
