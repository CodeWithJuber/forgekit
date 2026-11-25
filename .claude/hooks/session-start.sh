#!/bin/bash
# Web session-start install hook — ensures dev tooling (Biome, tsc) is present so
# tests and linters run in Claude Code on the web. Synchronous + idempotent.
# Only runs in the remote (web) environment; a no-op locally.
set -euo pipefail

# Local sessions already have their environment — nothing to do.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "${CLAUDE_PROJECT_DIR:-.}"

marker=node_modules/.forge-install-fingerprint
npm_version=$(npm --version)
if [[ -f "$marker" && -x node_modules/.bin/biome && -x node_modules/.bin/tsc ]] &&
  node "$hook_dir/install-fingerprint.mjs" check "$npm_version"; then
  exit 0
fi
npm ci --no-audit --no-fund
node "$hook_dir/install-fingerprint.mjs" record "$npm_version"
