#!/usr/bin/env bash
# Consolidate the learned lessons the opt-in session-learner appends to
# ~/.claude/skills/learned: merge duplicates, and drop a lesson ONLY when the forge
# ledger refutes it (its matching claim is dormant, retracted or pruned to the attic).
# Deterministic, no model call — src/learn_consolidate.js does the work. Run weekly.
#
#   learn-consolidate.sh [--dir <learned dir>] [--repo <project root>]... [--dry-run] [--json]
#
# `--repo` names a project whose .forge/ledger supplies the evidence (default: the current
# directory, when it has a ledger). A lesson with no matching ledger claim is always kept.
#
# `--llm` (explicit opt-in, first argument) runs the old Haiku rewrite instead. It prunes
# by the model's own judgment, which the research this project follows rejects for
# memory (prune by ground truth, not by the model's say-so), so it is never the default.
set -uo pipefail

# Resolve symlinks (the script is usually linked onto PATH) to find the package root.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  link="$(readlink "$SELF")"
  case "$link" in
    /*) SELF="$link" ;;
    *) SELF="$(dirname "$SELF")/$link" ;;
  esac
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

if [ "${1:-}" != "--llm" ]; then
  command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; exit 1; }
  exec node "$ROOT/src/learn_consolidate.js" "$@"
fi
shift

echo "! --llm: consolidating by model judgment (not ledger evidence); originals are archived first"
DIR="$HOME/.claude/skills/learned"
command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH"; exit 1; }

# Gather current consolidated file (if any) + all monthly lesson files.
inputs=$(ls "$DIR"/CONSOLIDATED.md "$DIR"/lessons-*.md 2>/dev/null)
[ -z "$inputs" ] && { echo "nothing to consolidate in $DIR"; exit 0; }
all="$(cat "$DIR"/CONSOLIDATED.md "$DIR"/lessons-*.md 2>/dev/null)"
[ -n "${all//[[:space:]]/}" ] || { echo "no lesson content"; exit 0; }

# Archive originals before rewriting.
mkdir -p "$DIR/archive"
ts="$(date +%Y%m%d-%H%M%S)"
for f in $inputs; do cp "$f" "$DIR/archive/$(basename "$f").$ts.bak"; done

# Contradiction is deliberately NOT a model decision even here: only ledger evidence
# (the default path) may refute a lesson.
prompt="You are consolidating a developer's accumulated learned lessons from AI
coding sessions. MERGE duplicates and near-duplicates into one rule. DROP anything
trivial, one-off, or session-specific. KEEP only durable, reusable
rules (project gotchas, error->fix patterns, workflow rules). Group under
'## <project>' headers (use '## General' for cross-project). Each rule = one
markdown bullet. Do NOT invent anything — only compress what is given. NEVER
include secrets/tokens/PII. Output only the markdown, no preamble.

LESSONS:
$all"

# Uses your logged-in session (slower startup, but authed). Weekly/cron task.
out="$(printf '%s' "$prompt" | timeout 180 claude -p --model haiku 2>/dev/null)"
out="$(printf '%s' "$out" | sed '/^[[:space:]]*$/d')"

# Guard: never overwrite/delete on an error or empty/too-short response.
if printf '%s' "$out" | grep -qiE 'not logged in|/login|error|usage:'; then
  echo "! claude returned an error (not logged in / empty) — originals kept, nothing changed"; exit 1
fi
if [ "$(printf '%s' "$out" | wc -c)" -lt 20 ]; then
  echo "! response too short to be valid — originals kept"; exit 1
fi

if [ -n "$out" ]; then
  { echo "# Learned — consolidated $(date +%Y-%m-%d)"; echo; printf '%s\n' "$out"; } > "$DIR/CONSOLIDATED.md"
  rm -f "$DIR"/lessons-*.md
  echo "✓ consolidated -> $DIR/CONSOLIDATED.md (originals archived in $DIR/archive/)"
  echo "  lines: $(wc -l < "$DIR/CONSOLIDATED.md")"
else
  echo "! Haiku produced no output — originals kept, nothing changed"
fi
