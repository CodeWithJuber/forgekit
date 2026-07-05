#!/usr/bin/env bash
# PostToolUse guard — redact secrets from a tool's output BEFORE it enters context,
# using the `updatedToolOutput` hook primitive. Defensive + advisory: only emits a
# rewrite when something matched. (updatedToolOutput min version is not pinned in the
# docs — this degrades to a no-op on tools/versions that ignore it.)
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat)"
out="$(printf '%s' "$INPUT" | jq -r '.tool_response // .tool_output // empty' 2>/dev/null)"
[ -n "$out" ] || exit 0

red="$(printf '%s' "$out" | sed -E 's/(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/[REDACTED]/g')"

if [ "$red" != "$out" ]; then
  jq -n --arg o "$red" '{hookSpecificOutput:{hookEventName:"PostToolUse",updatedToolOutput:$o}}'
fi
exit 0
