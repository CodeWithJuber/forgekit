#!/usr/bin/env bash
# cost-governance demo — run from the repo root:  bash examples/cost-governance/demo.sh
# Idempotent: works in a fresh scratch dir every time.
set -uo pipefail
# From the repo root: node src/cli.js is the CLI entry (package.json bin).
FORGE_CLI="${FORGE_CLI:-$PWD/src/cli.js}"
forge() { node "$FORGE_CLI" "$@"; }
demo_dir="$(mktemp -d)"
cd "$demo_dir" || exit 1
echo "demo dir: $demo_dir"

forge budget set --daily 10 --per-task 2 --alert-at 0.8 --hard
echo "---"
forge budget status
echo "---"
forge budget check --session-id demo || true
echo "---"
echo "state lives in: $demo_dir/.forge/  (delete the dir to clean up)"
