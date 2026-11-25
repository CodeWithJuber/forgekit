#!/usr/bin/env bash
set -u
guard_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 2
if command -v node >/dev/null 2>&1 && [ -f "$guard_dir/pre-edit-impact.mjs" ]; then
  exec node "$guard_dir/pre-edit-impact.mjs" "$@"
fi
echo "ForgeKit cannot reach the required edit impact check." >&2
exit 2
