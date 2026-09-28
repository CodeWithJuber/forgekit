#!/usr/bin/env bash
# adversarial-doctor demo — run from the repo root:  bash examples/adversarial-doctor/demo.sh
# Read-only: fires payloads at guard subprocesses, writes nothing.
set -uo pipefail
# From the repo root: node src/cli.js is the CLI entry (package.json bin).
FORGE_CLI="${FORGE_CLI:-$PWD/src/cli.js}"
forge() { node "$FORGE_CLI" "$@"; }

forge doctor --adversarial

echo ""
echo "--- now with a simulated permissions bypass ---"
demo_home="$(mktemp -d)"
mkdir -p "$demo_home/.claude"
echo '{"permissions":{"defaultMode":"bypassPermissions"}}' > "$demo_home/.claude/settings.json"
HOME="$demo_home" forge doctor --adversarial | grep -E "settings-bypass|problem" || true
rm -rf "$demo_home"
