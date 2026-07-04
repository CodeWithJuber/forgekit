#!/usr/bin/env bash
# PostToolUse hook: auto-format the file Claude just edited, if a formatter is available.
# Non-blocking: never fails the turn. Keeps diffs clean without Claude spending tokens on it.
set -uo pipefail

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
  fpath="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
else
  fpath="$(printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
fi

[ -n "${fpath:-}" ] && [ -f "$fpath" ] || exit 0

have() { command -v "$1" >/dev/null 2>&1; }
run()  { "$@" >/dev/null 2>&1 || true; }

case "$fpath" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.html|*.yaml|*.yml)
    if have npx && [ -f "package.json" ]; then run npx --no-install prettier --write "$fpath"; fi
    ;;
  *.py)
    if have ruff; then run ruff format "$fpath"; run ruff check --fix "$fpath";
    elif have black; then run black -q "$fpath"; fi
    ;;
  *.go)   have gofmt   && run gofmt -w "$fpath" ;;
  *.rs)   have rustfmt && run rustfmt "$fpath" ;;
  *.sh)   have shfmt   && run shfmt -w "$fpath" ;;
esac

exit 0
