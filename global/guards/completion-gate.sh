#!/usr/bin/env bash
# Forge completion gate — Stop hook, SYNCHRONOUS on purpose: it is the one Stop-path
# guard allowed to answer (a {"decision":"block"} with the repair checklist) when a
# session changed code but moved no doc/state artifact. cortex.sh runs `stop` detached
# so session exit is never delayed — that path can never block, hence this shim.
# Fail-open: any missing node/module/git swallows to a plain exit 0.
set -uo pipefail

# ~/.forge is a symlink to <repo>/global, so pwd -P lands inside the real tree in both
# install modes (install.sh symlink and CLAUDE_PLUGIN_ROOT plugin checkout).
DIR="$(cd "$(dirname "$0")" && pwd -P)"
ENTRY="$DIR/../../src/cortex_hook_main.js"

if command -v node >/dev/null 2>&1 && [ -f "$ENTRY" ]; then
  node "$ENTRY" stop-gate 2>/dev/null || true
fi
exit 0
