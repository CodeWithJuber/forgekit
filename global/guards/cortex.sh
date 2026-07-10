#!/usr/bin/env bash
# Forge Cortex hook shim — pipes the hook JSON (stdin) to the fail-safe node entrypoint.
# Advisory memory ONLY: it never blocks or fails a tool call. Mode is $1
# (capture | prompt | stop | session-start). Any error is swallowed; always exits 0.
# Resolve the real tree through the ~/.forge → <repo>/global symlink (pwd -P), so the
# entry exists in BOTH install modes. The old "$HOME/.forge/src/..." path pointed at
# global/src/ — nonexistent — and silently no-opped every hook in symlink installs.
DIR="$(cd "$(dirname "$0")" && pwd -P)"
entry="$DIR/../../src/cortex_hook_main.js"
# `stop` may distill lessons (an opt-in model call) — run it detached so session exit is
# never delayed. Other modes are fast and (session-start) must return stdout synchronously.
if [ "$1" = "stop" ]; then
  (node "$entry" stop >/dev/null 2>&1 &)
else
  node "$entry" "$1" 2>/dev/null || true
fi
exit 0
