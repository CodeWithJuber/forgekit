#!/usr/bin/env bash
# Custom status line: dir · branch · model · cost · diff · cache-hit% · ctx warning.
# One restrained palette — muted grey for structure, a single ember accent, green/red only
# for the +/- diff — with consistent " · " separators and a subtle (not alarming) 200k
# warning. Surfaces context-cost AND prompt-cache health so you notice when to /clear,
# /compact, or why a turn went uncached (model switch, MCP reconnect, upgrade).
set -uo pipefail

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
  dir="$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')"
  model="$(printf '%s' "$input" | jq -r '.model.display_name // .model.id // "?"')"
  cost="$(printf '%s' "$input" | jq -r '.cost.total_cost_usd // empty')"
  add="$(printf '%s' "$input" | jq -r '.cost.total_lines_added // empty')"
  del="$(printf '%s' "$input" | jq -r '.cost.total_lines_removed // empty')"
  over="$(printf '%s' "$input" | jq -r '.exceeds_200k_tokens // false')"
  cread="$(printf '%s' "$input" | jq -r '.current_usage.cache_read_input_tokens // .cost.cache_read_input_tokens // empty')"
  cwrite="$(printf '%s' "$input" | jq -r '.current_usage.cache_creation_input_tokens // .cost.cache_creation_input_tokens // empty')"
else
  dir="$PWD"
  model="?"
  cost=""
  add=""
  del=""
  over="false"
  cread=""
  cwrite=""
fi

[ -n "${dir:-}" ] || dir="$PWD"
short="${dir/#$HOME/\~}"

# Palette (256-color): muted structure, one ember accent, green/red reserved for the diff.
e=$(printf '\033')
R="${e}[0m"
BOLD="${e}[1m"
DIM="${e}[38;5;245m"
MUTED="${e}[38;5;247m"
EMBER="${e}[38;5;209m"
GREEN="${e}[38;5;114m"
RED="${e}[38;5;174m"
SEP=" ${DIM}·${R} "

# dir
out="${DIM}${short}${R}"

# branch
branch=""
if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch="$(git -C "$dir" branch --show-current 2>/dev/null)"
fi
[ -n "$branch" ] && out="${out}${SEP}${EMBER}⎇ ${branch}${R}"

# model
out="${out}${SEP}${BOLD}${model}${R}"

# session cost
if [ -n "${cost:-}" ] && [ "$cost" != "null" ]; then
  costf="$(printf '%.3f' "$cost" 2>/dev/null || printf '%s' "$cost")"
  out="${out}${SEP}${MUTED}\$${costf}${R}"
fi

# lines added/removed
if [ -n "${add:-}" ] && [ "$add" != "null" ]; then
  out="${out}${SEP}${GREEN}+${add:-0}${R}${DIM}/${R}${RED}-${del:-0}${R}"
fi

# cache hit rate: read / (read + creation). High = cache working; low = prefix busted.
if [ -n "${cread:-}" ] && [ "$cread" != "null" ] && command -v awk >/dev/null 2>&1; then
  p="$(awk -v r="${cread:-0}" -v w="${cwrite:-0}" 'BEGIN{t=r+w; if(t>0) printf "%d", 100*r/t}')"
  if [ -n "$p" ]; then
    if [ "$p" -ge 70 ]; then
      cc="$GREEN"
    elif [ "$p" -ge 30 ]; then
      cc="$EMBER"
    else
      cc="$RED"
    fi
    out="${out}${SEP}${cc}⚡${p}%${R}"
  fi
fi

# context warning — a subtle ember marker, not an alarming red block.
[ "${over:-false}" = "true" ] && out="${out}${SEP}${EMBER}⚠ ctx>200k → /clear${R}"

printf '%s' "$out"
