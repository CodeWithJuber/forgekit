#!/usr/bin/env bash
# claude-taste — enable ONE UI taste skill for the CURRENT repo (project-scoped).
# Best practice: one taste direction per project. Global taste skills compete and
# produce inconsistent UI. This copies a taste into ./.claude/skills/ so it applies
# only here. List with no args; enable with a name.
set -uo pipefail

ARCH="$HOME/.claude/skills-archive"
KEPT="$HOME/.claude/skills"

list() {
  echo "Taste skills you can enable per-repo (usage: claude-taste <name>):"
  { for d in "$ARCH"/*/ "$KEPT"/design-taste-frontend/; do
      [ -f "${d}SKILL.md" ] && basename "$d"; done; } 2>/dev/null | sort -u | sed 's/^/  - /'
  echo
  echo "Then set the actual look in DESIGN.md (run: claude-init  or  ask for /design-md)."
}

[ $# -eq 0 ] && { list; exit 0; }

name="$1"
src=""
for cand in "$ARCH/$name" "$KEPT/$name"; do
  [ -f "$cand/SKILL.md" ] && src="$cand" && break
done
[ -z "$src" ] && { echo "No taste skill named '$name'."; echo; list; exit 1; }

dest="./.claude/skills/$name"
if [ -d "$dest" ]; then echo "'$name' already enabled in $(basename "$PWD")."; exit 0; fi
mkdir -p "./.claude/skills"
cp -R "$src" "$dest"
echo "✓ enabled taste '$name' for $(basename "$PWD")  ->  $dest"
echo "  next: define the look in DESIGN.md, then: git add .claude/skills/$name DESIGN.md"
