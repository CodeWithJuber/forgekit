#!/usr/bin/env bash
# PreToolUse guard — doom-loop breaker. Detects thrashing (the SAME (tool,args)
# repeated) so an agent stuck patching the same thing gets caught early, before it
# burns a night's tokens. Advisory (never blocks). Tune FORGE_LOOP_THRESHOLD (default 4).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/_guardlib.sh"

INPUT="$(cat)"
sid="$(forge_field session_id)"
sig="$(printf '%s|%s|%s' "$(forge_field tool_name)" "$(forge_field command)" "$(forge_field file_path)" | cksum | cut -d' ' -f1)"
hist="${TMPDIR:-/tmp}/forge-loop-${sid:-nosession}"

printf '%s\n' "$sig" >> "$hist"
tail -n 8 "$hist" > "$hist.tmp" 2>/dev/null && mv "$hist.tmp" "$hist"

reps="$(grep -c "^${sig}$" "$hist" 2>/dev/null || echo 0)"
threshold="${FORGE_LOOP_THRESHOLD:-4}"
if [ "$reps" -ge "$threshold" ]; then
  echo "forge doom-loop: the same action repeated ${reps}x — likely thrashing. Stop, find the root cause, or ask a human (self-correction rule: cap ~3 tries)." >&2
fi

exit 0
