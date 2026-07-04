#!/usr/bin/env bash
# PreToolUse guard — advisory cost signal. NEVER blocks (warn-only, by design:
# blocking would recreate the permission-fatigue we're trying to fix). Counts
# tool calls per session and nudges at high volume; flags obviously broad commands.
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

case "$count" in
  250|500|1000|2000)
    echo "forge cost: $count tool calls this session — if this feels like a loop, /clear or scope the task (runaway loops are the #1 cost incident)." >&2 ;;
esac

case "$cmd" in
  *"find / "*|*"find /"|*"grep -r"*" / "*|*"npm install "*"-g"*|*" | xargs "*)
    echo "forge cost: broad/expensive command — scope it or delegate to the scout crew: ${cmd:0:80}" >&2 ;;
esac

exit 0
