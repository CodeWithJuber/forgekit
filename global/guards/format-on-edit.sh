#!/usr/bin/env bash
# PostToolUse hook: auto-format the file Claude just edited, if a formatter is available.
# Non-blocking: never fails the turn. Keeps diffs clean without Claude spending tokens on it.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/_guardlib.sh"

INPUT="$(cat)"
# A real JSON parser (jq, else node): the old grep fallback cut the value at the first
# escaped quote, and mangled Windows paths (backslashes arrive doubled inside JSON).
fpath="$(forge_field file_path)"

[ -n "${fpath:-}" ] && [ -f "$fpath" ] || exit 0

have() { command -v "$1" >/dev/null 2>&1; }
run()  { "$@" >/dev/null 2>&1 || true; }

# A project that formats with Biome must never be rewritten by a global prettier: the two
# disagree (line width, object wrapping), so every edit churned the whole file. Biome owns
# the files it is configured for; everything else (markdown included) is left alone.
biome_project() { [ -f "biome.json" ] || [ -f "biome.jsonc" ]; }

case "$fpath" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.html|*.yaml|*.yml)
    if biome_project; then
      case "$fpath" in
        *.md|*.html|*.yaml|*.yml) ;;
        *) if have npx && [ -x "node_modules/.bin/biome" ]; then run npx --no-install biome format --write "$fpath"; fi ;;
      esac
    elif have npx && [ -f "package.json" ]; then run npx --no-install prettier --write "$fpath"; fi
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
