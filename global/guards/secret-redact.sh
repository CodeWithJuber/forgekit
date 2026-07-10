#!/usr/bin/env bash
# PostToolUse guard — redact secrets from a tool's output BEFORE it enters context,
# using the `updatedToolOutput` hook primitive. Detection/redaction logic lives in
# src/secrets.js (format grammars + entropy scoring — ONE source of truth), imported
# via node so this script can never disagree with the JS refusal sites. Degrades to a
# narrower sed pass over known credential formats only if node or the module is
# unreachable. Defensive + advisory: only emits a rewrite when something changed.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat)"
out="$(printf '%s' "$INPUT" | jq -r '.tool_response // .tool_output // empty' 2>/dev/null)"
[ -n "$out" ] || exit 0

# ~/.forge is a symlink to <repo>/global, so pwd -P lands inside the real tree in
# both install modes (install.sh symlink and CLAUDE_PLUGIN_ROOT plugin checkout).
DIR="$(cd "$(dirname "$0")" && pwd -P)"
SECRETS_JS="$DIR/../../src/secrets.js"

red=""
if command -v node >/dev/null 2>&1 && [ -f "$SECRETS_JS" ]; then
  red="$(printf '%s' "$out" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", async () => {
      const { redactSecrets } = await import(process.argv[1]);
      process.stdout.write(redactSecrets(raw));
    });' "$SECRETS_JS" 2>/dev/null)" || red=""
fi
if [ -z "$red" ]; then
  red="$(printf '%s' "$out" | sed -E 's/(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[A-Za-z0-9._-]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/[REDACTED]/g')"
fi

if [ "$red" != "$out" ]; then
  jq -n --arg o "$red" '{hookSpecificOutput:{hookEventName:"PostToolUse",updatedToolOutput:$o}}'
fi
exit 0
