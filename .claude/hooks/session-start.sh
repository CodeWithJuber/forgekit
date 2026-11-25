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

# Refresh dependencies only when the inputs to npm ci have changed.
fingerprint=$(node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json", ".npmrc"]) hash.update(readFileSync(file));
  console.log(hash.update(JSON.stringify([process.version, process.platform, process.arch, process.argv[1]])).digest("hex"));
' "$(npm --version)")
marker=node_modules/.forge-install-fingerprint
if [[ -x node_modules/.bin/biome && -x node_modules/.bin/tsc && -f "$marker" ]] && [[ $(cat "$marker") == "$fingerprint" ]]; then
  exit 0
fi
npm ci --no-audit --no-fund
printf '%s\n' "$fingerprint" > "$marker"
