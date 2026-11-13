#!/usr/bin/env bash
# PreToolUse hook: vet the packages an install command would fetch (dep-gate) — a name that is
# not on its own registry (a hallucinated dependency) or that OSV lists as malicious is blocked.
# Thin launcher: the payload parsing and the whole rule set live in dep-gate.mjs (Node) and
# src/depgate.js, the same split protect-paths.sh uses. The hook launcher (run.mjs) skips this
# file and runs dep-gate.mjs on node directly; this shim remains for direct `bash dep-gate.sh`
# callers.
# Exit 2 = block the tool call and feed the reason back to Claude.
# FAIL OPEN: this guard does network I/O and an install must keep working offline, so anything
# short of a verdict from the Node twin lets the call through.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MJS="$DIR/dep-gate.mjs"

if command -v node >/dev/null 2>&1 && [ -f "$MJS" ]; then
  # stdin (the hook JSON) is inherited; the verdict is propagated verbatim.
  node "$MJS"
  exit "$?"
fi
exit 0
