#!/usr/bin/env bash
# PreToolUse guard — the cost governor. Counts tool calls per session, nudges at high
# volume, flags obviously broad commands, and — past the real-spend ceiling — hands the
# decision to the HUMAN.
#
# It used to only `echo … >&2; exit 0`. A PreToolUse hook's stderr is shown to nobody on
# exit 0 (Claude sees stderr only on exit 2, the user sees it only in debug), so the
# governor neither capped nor informed: it was a no-op that looked like a control (B8).
# Now the ceiling emits the `permissionDecision: "ask"` shape, which pauses for the user
# with the reason attached, and the volume nudges ride along as `additionalContext` (not
# as invisible stderr). Still never blocks by itself — `ask` is the user's call.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/_guardlib.sh"

INPUT="$(cat)"
sid="$(forge_field session_id)"
cmd="$(forge_field command)"

# Serialize per session so the counter can't race; also proves re-entrancy safety.
forge_lock "cost-${sid:-nosession}" || exit 0

counter="${TMPDIR:-/tmp}/forge-count-${sid:-nosession}"
count=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$counter"

# JSON-escape a reason string, then emit one PreToolUse decision object. No jq: this guard
# runs everywhere, and a governor that only speaks when jq is installed governs nothing.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' | tr -d '\r\n'; }
emit() { # emit <decision|context> <reason>
  if [ "$1" = "ask" ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}' "$(esc "$2")"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}' "$(esc "$2")"
  fi
  echo "$2" >&2
}

notes=""
add_note() { notes="${notes:+$notes }$1"; }

case "$count" in
  250 | 500 | 1000 | 2000)
    add_note "forge cost: $count tool calls this session — if this feels like a loop, /clear or scope the task (runaway loops are the #1 cost incident)." ;;
esac

case "$cmd" in
  *"find / "* | *"find /" | *"grep -r"*" / "* | *"npm install "*"-g"* | *" | xargs "*)
    add_note "forge cost: broad/expensive command — scope it or delegate to the scout crew: ${cmd:0:80}" ;;
esac

# Real-spend check, throttled to 1/100 calls (ccusage spawns node — keep it off the hot path).
# Past the ceiling the governor ASKS: the human decides whether the next call is worth it.
if [ $((count % 100)) -eq 0 ] && command -v ccusage > /dev/null 2>&1; then
  spend="$(ccusage daily --json 2>/dev/null | grep -o '"totalCost":[0-9.]*' | head -1 | cut -d: -f2)"
  ceil="${FORGE_COST_CEILING:-10}"
  if [ -n "${spend:-}" ] && awk "BEGIN{exit !($spend > $ceil)}" 2>/dev/null; then
    emit ask "forge cost: today's spend \$$spend exceeds the \$$ceil ceiling (FORGE_COST_CEILING). Continue, or switch to Haiku (/model), scope the task, or /clear.${notes:+ $notes}"
    exit 0
  fi
fi

[ -n "$notes" ] && emit context "$notes"

exit 0
