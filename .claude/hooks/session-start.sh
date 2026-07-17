#!/bin/bash
# Web session-start install hook — ensures dev tooling (Biome, tsc) is present so
# tests and linters run in Claude Code on the web. Synchronous + idempotent.
# Only runs in the remote (web) environment; a no-op locally.
set -euo pipefail

# Local sessions already have their environment — nothing to do.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# forgekit has ZERO runtime deps; the only install is dev tooling (biome, typescript,
# @types/node). If Biome is already resolvable, the container is warm — skip the install.
if [ -x node_modules/.bin/biome ]; then
  exit 0
fi

# Prefer `npm install` over `npm ci` so a warm-cached container is reused.
npm install --no-audit --no-fund
