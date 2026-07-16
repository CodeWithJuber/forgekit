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

# Palette — the exact forgekit brand tokens (brand.json.colors.dark) rendered in
# 24-bit truecolor so the ember and warm-taupe greys are on-brand, not the nearest
# off-brand xterm-256 index. Named block; one ember accent, green/red only for the
# diff. Falls back to the closest 256-color indices when the terminal can't do
# truecolor (COLORTERM unset / not 24-bit), so it degrades instead of mis-rendering.
e=$(printf '\033')
R="${e}[0m"
BOLD="${e}[1m"
if [[ "${COLORTERM:-}" == *truecolor* || "${COLORTERM:-}" == *24bit* ]]; then
  DIM="${e}[38;2;125;114;99m"    # faint   #7d7263  warm taupe
  MUTED="${e}[38;2;169;158;144m" # muted   #a99e90
  EMBER="${e}[38;2;242;100;48m"  # brand   #f26430  ember
  GREEN="${e}[38;2;103;232;165m" # ok      #67e8a5
  RED="${e}[38;2;224;96;90m"     # diff-removed (warm red, distinct from ember)
else
  DIM="${e}[38;5;245m"
  MUTED="${e}[38;5;247m"
  EMBER="${e}[38;5;209m"
  GREEN="${e}[38;5;114m"
  RED="${e}[38;5;174m"
fi
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
