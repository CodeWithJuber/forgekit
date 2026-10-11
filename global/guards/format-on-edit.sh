#!/usr/bin/env bash
# PostToolUse hook: auto-format the file Claude just edited, if a formatter is available.
# Non-blocking: never fails the turn. Keeps diffs clean without Claude spending tokens on it.
#
# Config attestation (P0 fix, 2026-10-11): biome discovers its config from the process
# CWD — and the old hook only checked CWD for config existence — so a file edited
# outside the hook's CWD was silently rewritten with defaults or the CWD project's
# config. The old hook also ran `ruff format` / `ruff check --fix` with no config check
# at all: a file with no config anywhere above it was rewritten under ruff's defaults.
# This hook now resolves the config by walking UP from the EDITED FILE's directory,
# passes it explicitly (ruff --config / biome --config-path), logs the resolved path
# on every invocation (auditable evidence), and SKIPS with a logged reason when no
# config exists — never runs --write/--fix on silent defaults.
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

# The hook's audit trail: guards emit advisories on stderr, so the chosen config (or
# the skip reason) is visible in the transcript and capture-able from hook logs.
forge_log() { printf 'forge format-on-edit: %s\n' "$*" >&2; }

# find_config <dir> <name...> — walk up from <dir>, printing the NEAREST matching
# config file (absolute path), or nothing. We anchor discovery to the edited file's
# directory instead of the ambient CWD, then pass the result explicitly so the
# formatter cannot fall back to CWD discovery or silent defaults.
find_config() {
  local dir="$1" name cand
  shift
  dir="$(cd "$dir" 2>/dev/null && pwd)" || return 0
  while true; do
    for name in "$@"; do
      cand="$dir/$name"
      if [ -f "$cand" ]; then
        printf '%s\n' "$cand"
        return 0
      fi
    done
    [ "$dir" = "/" ] && return 0
    dir="$(dirname "$dir")"
  done
}

# Nearest project config for the edited file — never CWD, never defaults.
ruff_config()  { find_config "$(dirname "$fpath")" pyproject.toml ruff.toml .ruff.toml; }
biome_config() { find_config "$(dirname "$fpath")" biome.json biome.jsonc; }

# A project that formats with Biome must never be rewritten by a global prettier: the two
# disagree (line width, object wrapping), so every edit churned the whole file. Biome owns
# the files it is configured for; everything else (markdown included) is left alone.
case "$fpath" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.html|*.yaml|*.yml)
    bconf="$(biome_config)"
    if [ -n "${bconf:-}" ]; then
      # Biome owns the files it is configured for.
      forge_log "biome config: $bconf"
      case "$fpath" in
        *.md|*.html|*.yaml|*.yml) ;;
        *)
          # SECURITY (P1 fix, 2026-10-11): never execute the edited project's
          # own binary — node_modules/.bin is untrusted code (a malicious or
          # compromised repo could ship a weaponized "biome"). Use the trusted
          # biome from PATH and pass the discovered config explicitly; the
          # config file is data, the binary must be trusted. This matches
          # src/stack.js's own rule (runProblem refuses node_modules/.bin).
          # If no trusted biome exists, skip with a logged reason — silently
          # skipping a format is always safer than executing a stranger's binary.
          if have biome; then
            run biome format --write --config-path "$bconf" "$fpath"
          else
            forge_log "biome config: $bconf — no trusted biome on PATH, skipping (refusing project-local binary)"
          fi
          ;;
      esac
    elif have npx && [ -f "package.json" ]; then run npx --no-install prettier --write "$fpath"; fi
    ;;
  *.py)
    if have ruff; then
      rconf="$(ruff_config)"
      if [ -n "${rconf:-}" ]; then
        forge_log "ruff config: $rconf"
        run ruff format --config "$rconf" "$fpath"
        run ruff check --fix --config "$rconf" "$fpath"
      else
        forge_log "no ruff config found walking up from $(dirname "$fpath") — skipped (never --write/--fix on defaults)"
      fi
    elif have black; then run black -q "$fpath"; fi
    ;;
  *.go)   have gofmt   && run gofmt -w "$fpath" ;;
  *.rs)   have rustfmt && run rustfmt "$fpath" ;;
  *.sh)   have shfmt   && run shfmt -w "$fpath" ;;
esac

exit 0
