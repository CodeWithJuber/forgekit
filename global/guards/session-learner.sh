#!/usr/bin/env bash
# Opt-in end-of-session learner (Stop hook). Distills durable lessons from a
# session and appends them to ~/.claude/skills/learned/. OFF by default.
#
# Enable:  export ENABLE_SESSION_LEARNING=1   (in ~/.zshrc)
# Cost:    one Haiku call per QUALIFYING session (long ones only), on a trimmed
#          transcript. Runs in the background so it never delays session exit.
# Tunables (env): SESSION_LEARN_MIN (default 25 user msgs), SESSION_LEARN_MODEL
#          (default haiku), SESSION_LEARN_MAXBYTES (default 60000).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/_guardlib.sh"

# Gate 1: opt-in only.
[ "${ENABLE_SESSION_LEARNING:-0}" = "1" ] || exit 0
# Gate 2: need the claude CLI.
command -v claude >/dev/null 2>&1 || exit 0

MIN="${SESSION_LEARN_MIN:-25}"
MODEL="${SESSION_LEARN_MODEL:-haiku}"
MAXBYTES="${SESSION_LEARN_MAXBYTES:-60000}"
OUTDIR="$HOME/.claude/skills/learned"
LOG="$OUTDIR/.learn.log"

stdin_data="$(cat)"
tp="$(printf '%s' "$stdin_data" | grep -o '"transcript_path":"[^"]*"' | head -1 | cut -d'"' -f4)"
cwd="$(printf '%s' "$stdin_data" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$tp" ] && [ -f "$tp" ] || exit 0

# Gate 3: long sessions only.
msgs="$(grep -c '"type":"user"' "$tp" 2>/dev/null || echo 0)"
[ "$msgs" -ge "$MIN" ] 2>/dev/null || exit 0

mkdir -p "$OUTDIR"
# Gate 4: process each transcript once (dedupe on path+size).
sig="$(printf '%s:%s' "$tp" "$(wc -c <"$tp" 2>/dev/null)")"
marker="$OUTDIR/.processed"
touch "$marker"
grep -qxF "$sig" "$marker" 2>/dev/null && exit 0
echo "$sig" >> "$marker"

proj="$(basename "${cwd:-$PWD}")"

# Run detached so session exit is never delayed.
(
  # Re-entrancy lock held for the whole model call — never two learners at once.
  forge_lock "session-learner" || exit 0
  transcript="$(tail -c "$MAXBYTES" "$tp")"
  prompt="You are reviewing the tail of a Claude Code session transcript.
Extract AT MOST 3 durable, reusable lessons that would help future sessions in
this project: project gotchas, error->fix patterns, or workflow rules. Ignore
one-off typos, trivia, and anything session-specific. NEVER include secrets,
tokens, keys, or PII. If nothing durable, output exactly: NONE
Format each lesson as one markdown bullet starting with '- '.

TRANSCRIPT:
$transcript"

  out="$(printf '%s' "$prompt" | timeout 90 claude -p --model "$MODEL" 2>>"$LOG")"
  out="$(printf '%s' "$out" | sed '/^[[:space:]]*$/d')"
  if [ -n "$out" ] && ! printf '%s' "$out" | grep -qix 'none'; then
    {
      echo
      echo "## $(date '+%Y-%m-%d %H:%M') — $proj"
      printf '%s\n' "$out"
    } >> "$OUTDIR/lessons-$(date +%Y-%m).md"
  fi
) >/dev/null 2>>"$LOG" &

exit 0
