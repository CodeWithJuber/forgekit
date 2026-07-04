#!/usr/bin/env bash
# ADDITIVE installer. Adds skills, agents, rules, hooks + statusline to ~/.claude
# WITHOUT touching your existing CLAUDE.md, settings.json, memory, or rules you
# already have. Backs up any same-named file it would replace.
#
# It does NOT edit settings.json — hooks/statusline need a one-time manual merge.
# See the snippet this script prints at the end (also in RECONCILE.md).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/global"
DEST="$HOME/.claude"
STAMP="$(date +%Y%m%d-%H%M%S)"
BK="$DEST/.backup-$STAMP"

# Whitelist of additive items (relative to global/). Intentionally excludes
# CLAUDE.md, settings.json, memory/ (you already have those), and the
# memory-keeper skill + memory-load hook (you already run remember/episodic-memory).
ITEMS=(
  "skills/tech-selector"
  "skills/reuse-first"
  "skills/ui-workflow"
  "skills/design-md"
  "skills/dev-radar"
  "skills/code-modernization"
  "skills/cost-guard"
  "skills/explore-plan-code"
  "skills/self-improve"
  "agents/scout.md"
  "agents/verifier.md"
  "agents/frontend-verifier.md"
  "rules/tech-currency.md"
  "rules/stack-notes.md"
  "rules/self-correction.md"
  "hooks/protect-paths.sh"
  "hooks/format-on-edit.sh"
  "hooks/learn-session.sh"
  "statusline.sh"
  "bin/claude-init.sh"
  "bin/learn-consolidate.sh"
  "bin/claude-taste.sh"
)

echo "→ Additive install into $DEST (existing config untouched)"

copy_item() {
  local rel="$1" s="$SRC/$1" d="$DEST/$1"
  [ -e "$s" ] || { echo "  skip (missing in bundle): $rel"; return; }
  if [ -e "$d" ]; then
    mkdir -p "$BK/$(dirname "$rel")"; cp -R "$d" "$BK/$rel"
    echo "  backed up existing $rel"
  fi
  mkdir -p "$(dirname "$d")"
  cp -R "$s" "$d"
  echo "  installed $rel"
}

for i in "${ITEMS[@]}"; do copy_item "$i"; done

chmod +x "$DEST"/hooks/*.sh "$DEST"/statusline.sh 2>/dev/null || true

echo
echo "✓ Added 5 skills, 3 agents, 1 rule, 2 hooks, 1 statusline."
[ -d "$BK" ] && echo "  Backups: $BK"
cat <<'EOF'

── ONE manual step: wire hooks + statusline into ~/.claude/settings.json ──
Merge these keys (you have none of them yet). Keep your existing keys as-is:

  "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh" },
  "hooks": {
    "PreToolUse":  [ { "matcher": "Edit|Write|MultiEdit|Bash",
      "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/protect-paths.sh" } ] } ],
    "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit",
      "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/format-on-edit.sh" } ] } ]
  }

NOTE: you already have a Stop hook (continuous-learning). If you add the block
above, keep that Stop entry inside the same "hooks" object.

See RECONCILE.md for the full audit and recommended settings/CLAUDE.md changes.
EOF
