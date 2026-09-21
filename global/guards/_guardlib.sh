# shellcheck shell=bash
# Sourced helpers for Forge guards. Not executable on its own.
# Provides field extraction (a real JSON parser) and an atomic re-entrancy lock so a
# guard can never recurse — the class of bug behind the runaway-loop cost
# incident (claude-code #4095: 1.67B tokens / 5h, est. $16k–50k).

GUARDLIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARDLIB_LOADED=0

# Read the common hook fields in ONE node pass and cache them for this process. A guard
# asks for 2-4 fields and node costs far more to start than jq does, so batching keeps the
# PreToolUse path cheap (measured on Windows: ~1s per node start).
_guardlib_load() {
  # GUARDLIB_STATUS is a shell status: 0 = the payload parsed, 1 = it did not.
  [ "${GUARDLIB_LOADED:-0}" = "1" ] && return "${GUARDLIB_STATUS:-1}"
  GUARDLIB_LOADED=1
  GUARDLIB_STATUS=1
  local ok=""
  {
    IFS= read -r -d '' ok &&
      IFS= read -r -d '' GUARDLIB_F_session_id &&
      IFS= read -r -d '' GUARDLIB_F_tool_name &&
      IFS= read -r -d '' GUARDLIB_F_command &&
      IFS= read -r -d '' GUARDLIB_F_file_path &&
      IFS= read -r -d '' GUARDLIB_F_transcript_path &&
      IFS= read -r -d '' GUARDLIB_F_cwd &&
      IFS= read -r -d '' GUARDLIB_F_prompt
  } < <(printf '%s' "$INPUT" | node "$GUARDLIB_DIR/hookfield.mjs" -0 \
    session_id \
    tool_name \
    "tool_input.command" \
    "tool_input.file_path|tool_input.notebook_path|tool_input.path" \
    transcript_path \
    cwd \
    prompt) || true
  [ "$ok" = "1" ] && GUARDLIB_STATUS=0
  return "$GUARDLIB_STATUS"
}

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
    return
  fi
  case "$1" in
    session_id | tool_name | command | file_path | transcript_path | cwd | prompt)
      _guardlib_load || return 0 # unparsable payload → empty field, same as jq's `// empty`
      local var="GUARDLIB_F_$1"
      printf '%s' "${!var-}"
      ;;
    *) printf '%s' "$INPUT" | node "$GUARDLIB_DIR/hookfield.mjs" "$path" ;;
  esac
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
