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
# as invisible stderr). `forge budget` (src/budget.js) owns the policy: per-day and
# per-task budgets, the alert threshold, and the opt-in circuit breaker (`--hard` →
# `permissionDecision: "deny"`). This guard stays the thin enforcement point — it calls
# `forge budget check` and translates the verdict, nothing more. Without `forge` on PATH
# it falls back to the historic inline ccusage/FORGE_COST_CEILING check.
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
  case "$1" in
    ask)
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}' "$(esc "$2")"
      ;;
    deny)
      # The circuit breaker: only reachable when the user opted in
      # (`forge budget set --hard`). Never the default.
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$(esc "$2")"
      ;;
    *)
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}' "$(esc "$2")"
      ;;
  esac
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

# Budget check, throttled to 1/100 calls (spawns node — keep it off the hot path).
# `forge budget check` reads the repo's budget config, snapshots the session baseline,
# and prints a `decision:` line: allow | context <nudge> | ask <reason> | deny <reason>.
# `deny` only fires when the user explicitly opted into the circuit breaker
# (`forge budget set --hard`); otherwise over-budget ASKS, exactly like the old ceiling.
if [ $((count % 100)) -eq 0 ] && command -v forge > /dev/null 2>&1; then
  verdict="$(forge budget check --session-id "${sid:-nosession}" 2>/dev/null)"
  decision="$(printf '%s' "$verdict" | sed -n 's/^decision: //p' | head -n 1 | tr -d '\r')"
  reason="$(printf '%s' "$verdict" | sed -n 's/^reason: //p' | head -n 1 | tr -d '\r')"
  case "$decision" in
    deny) emit deny "${reason:-forge budget: over budget}"; exit 0 ;;
    ask) emit ask "${reason:-forge budget: over budget}"; exit 0 ;;
    context) [ -n "$reason" ] && add_note "$reason" ;;
  esac
# Fallback when `forge` isn't on PATH: the historic inline ceiling check, unchanged.
elif [ $((count % 100)) -eq 0 ] && command -v ccusage > /dev/null 2>&1; then
  spend="$(ccusage daily --json 2>/dev/null | grep -o '"totalCost":[0-9.]*' | head -1 | cut -d: -f2)"
  ceil="${FORGE_COST_CEILING:-10}"
  if [ -n "${spend:-}" ] && awk "BEGIN{exit !($spend > $ceil)}" 2>/dev/null; then
    emit ask "forge cost: today's spend \$$spend exceeds the \$$ceil ceiling (FORGE_COST_CEILING). Continue, or switch to Haiku (/model), scope the task, or /clear.${notes:+ $notes}"
    exit 0
  fi
fi

[ -n "$notes" ] && emit context "$notes"

exit 0
