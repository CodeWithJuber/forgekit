#!/usr/bin/env bash
# Custom status line: dir · git branch · model · session cost · cache hit%.
# Surfaces context-cost AND prompt-cache health so you notice when to /clear,
# /compact, or why a turn went uncached (model switch, MCP reconnect, upgrade).
set -uo pipefail

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
  dir="$(printf '%s' "$input"  | jq -r '.workspace.current_dir // .cwd // empty')"
  model="$(printf '%s' "$input"| jq -r '.model.display_name // .model.id // "?"')"
  cost="$(printf '%s' "$input" | jq -r '.cost.total_cost_usd // empty')"
  add="$(printf '%s' "$input"  | jq -r '.cost.total_lines_added // empty')"
  del="$(printf '%s' "$input"  | jq -r '.cost.total_lines_removed // empty')"
  over="$(printf '%s' "$input" | jq -r '.exceeds_200k_tokens // false')"
  cread="$(printf '%s' "$input"| jq -r '.current_usage.cache_read_input_tokens // .cost.cache_read_input_tokens // empty')"
  cwrite="$(printf '%s' "$input"|jq -r '.current_usage.cache_creation_input_tokens // .cost.cache_creation_input_tokens // empty')"
else
  dir="$PWD"; model="?"; cost=""; add=""; del=""; over="false"; cread=""; cwrite=""
fi

[ -n "${dir:-}" ] || dir="$PWD"
short="${dir/#$HOME/~}"

branch=""
if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch="$(git -C "$dir" branch --show-current 2>/dev/null)"
  [ -n "$branch" ] && branch=" \033[35m⎇ $branch\033[0m"
fi

costp=""
if [ -n "${cost:-}" ] && [ "$cost" != "null" ]; then
  costp="$(printf ' \033[33m$%.3f\033[0m' "$cost" 2>/dev/null || echo " \$$cost")"
fi

diffp=""
if [ -n "${add:-}" ] && [ "$add" != "null" ]; then
  diffp="$(printf ' \033[32m+%s\033[0m/\033[31m-%s\033[0m' "${add:-0}" "${del:-0}")"
fi

# Cache hit rate: read / (read + creation). High = cache working; low = prefix busted.
cachep=""
if [ -n "${cread:-}" ] && [ "$cread" != "null" ] && command -v awk >/dev/null 2>&1; then
  cachep="$(awk -v r="${cread:-0}" -v w="${cwrite:-0}" 'BEGIN{t=r+w; if(t>0){p=100*r/t; c=(p>=70)?32:(p>=30)?33:31; printf " \033[%dm⚡%d%%\033[0m", c, p}}')"
fi

warn=""
[ "${over:-false}" = "true" ] && warn=" \033[41m ctx>200k — /clear \033[0m"

printf "\033[36m%s\033[0m%b \033[90m·\033[0m \033[1m%s\033[0m%b%b%b%b" \
  "$short" "$branch" "$model" "$costp" "$diffp" "$cachep" "$warn"
