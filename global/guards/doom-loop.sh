#!/usr/bin/env bash
# PreToolUse guard — doom-loop breaker. Detects thrashing (the SAME (tool,args)
# repeated) so an agent stuck patching the same thing gets caught early, before it
# burns a night's tokens. Advisory (never blocks). Tune FORGE_LOOP_THRESHOLD (default 4).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/_guardlib.sh"

INPUT="$(cat)"
_guardlib_load || exit 0
sid="$(forge_field session_id)"
sig="$(printf '%s|%s|%s' "$(forge_field tool_name)" "$(forge_field command)" "$(forge_field file_path)" | cksum | cut -d' ' -f1)"
history_unavailable() {
  echo "forge doom-loop: repetition history unavailable; check that TMPDIR is writable." >&2
  exit 0
}
umask 077
dir="${TMPDIR:-/tmp}/forge-loop-$UID"
mkdir -p -- "$dir" 2>/dev/null && [ -O "$dir" ] && [ ! -L "$dir" ] || history_unavailable
# Keep host-supplied session IDs out of paths. Concurrent tools share one rolling window.
session_key="$(printf '%s' "${sid:-nosession}" | cksum | cut -d' ' -f1)"
hist="$dir/$session_key"
for attempt in 1 2 3 4 5; do
  if forge_lock "loop-$UID-$session_key"; then break; fi
  [ "$attempt" -lt 5 ] || history_unavailable
  sleep 0.02
done
# Use a subshell so cleanup of the scratch file preserves forge_lock's EXIT trap.
update_history() (
  tmp="$(mktemp "$dir/.recent.XXXXXXXX")" || return 1
  trap 'rm -f -- "$tmp"' EXIT
  if [ -e "$hist" ]; then tail -n 7 "$hist" > "$tmp" || return 1; fi
  printf '%s\n' "$sig" >> "$tmp" && mv -f -- "$tmp" "$hist" || return 1
  awk -v sig="$sig" '$0 == sig { n++ } END { print n+0 }' "$hist"
)
reps="$(update_history 2>/dev/null)" || history_unavailable
threshold="${FORGE_LOOP_THRESHOLD:-4}"
case "$threshold" in *[!0-9]*|'') threshold=4 ;; esac
if [ "$reps" -ge "$threshold" ]; then
  echo "forge doom-loop: the same action repeated ${reps}x — likely thrashing. Stop, find the root cause, or ask a human (self-correction rule: cap ~3 tries)." >&2
fi

exit 0
