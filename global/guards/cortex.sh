#!/usr/bin/env bash
# Forge Cortex hook shim — pipes the hook JSON (stdin) to the fail-safe node entrypoint.
# Advisory memory ONLY: it never blocks or fails a tool call. Mode is $1
# (capture | prompt | stop | session-start). Any error is swallowed; always exits 0.
root="${CLAUDE_PLUGIN_ROOT:-$HOME/.forge}"
node "$root/src/cortex_hook_main.js" "$1" 2>/dev/null || true
exit 0
