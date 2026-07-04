#!/usr/bin/env bash
# Stop guard — the deterministic half of the lean discipline. Nudges when the
# working diff is large ("is all of it needed?"). Advisory only; never blocks the
# stop (exit 0). Tune with FORGE_LEAN_THRESHOLD (default 400 changed lines).
set -uo pipefail

command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

threshold="${FORGE_LEAN_THRESHOLD:-400}"
sum() { awk '{ a += $1 + $2 } END { print a + 0 }'; }
unstaged="$(git diff --numstat 2>/dev/null | sum)"
staged="$(git diff --cached --numstat 2>/dev/null | sum)"
total=$(( unstaged + staged ))

if [ "$total" -ge "$threshold" ]; then
  echo "forge lean: this change touches $total lines (>= $threshold). Is all of it needed? The smallest diff that works wins — invoke the lean tool to trim." >&2
fi

exit 0
