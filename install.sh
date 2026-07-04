#!/usr/bin/env bash
# Forge installer — idempotent, reversible, offline.
#   bash install.sh              install (symlink global/ into ~/.forge and ~/.claude, put `forge` on PATH)
#   bash install.sh --dry-run    print what it would do, change nothing
#   bash install.sh --uninstall  remove Forge's own symlinks (never touches your other files)
# It never downloads anything and never edits settings.json for you — it prints the
# hook/statusline block to merge by hand, so your existing config is untouched.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORGE_HOME="${FORGE_HOME:-$HOME/.forge}"
CLAUDE_DIR="$HOME/.claude"
BIN_DIR="$HOME/.local/bin"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY=0; MODE=install
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
act() { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else eval "$*"; fi; }

# link SRC DEST — back up an existing real file/dir, then symlink.
link() {
  local src="$1" dest="$2"
  [ -e "$src" ] || { say "skip (missing in bundle): $src"; return; }
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    act "mv \"$dest\" \"$dest.forge-bak-$STAMP\""; say "backed up existing $dest"
  fi
  act "mkdir -p \"$(dirname "$dest")\""
  act "ln -sfn \"$src\" \"$dest\""
  say "linked $dest -> $src"
}

# unlink DEST — remove only if it is a symlink pointing back into this repo.
unlink_ours() {
  local dest="$1"
  if [ -L "$dest" ] && case "$(readlink "$dest")" in "$REPO"/*) true;; *) false;; esac; then
    act "rm -f \"$dest\""; say "removed $dest"
  fi
}

install_forge() {
  say "Installing Forge from $REPO"
  link "$REPO/global" "$FORGE_HOME"
  for d in "$REPO"/global/tools/*/; do [ -d "$d" ] && link "$d" "$CLAUDE_DIR/skills/$(basename "$d")"; done
  for f in "$REPO"/global/crew/*.md; do [ -e "$f" ] && link "$f" "$CLAUDE_DIR/agents/$(basename "$f")"; done
  link "$REPO/src/cli.js" "$BIN_DIR/forge"
  [ "$DRY" = 1 ] || chmod +x "$REPO/src/cli.js" 2>/dev/null || true

  case ":$PATH:" in *":$BIN_DIR:"*) : ;; *) say "note: add $BIN_DIR to PATH (e.g. echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc)";; esac

  cat <<EOF

  Done. Guards + statusline need ONE manual merge into $CLAUDE_DIR/settings.json
  (kept manual so your existing settings are never clobbered):

    "statusLine": { "type": "command", "command": "bash $FORGE_HOME/statusline.sh" },
    "hooks": {
      "PreToolUse":  [ { "matcher": "Edit|Write|MultiEdit|Bash",
        "hooks": [ { "type": "command", "command": "bash $FORGE_HOME/guards/protect-paths.sh" } ] } ],
      "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit",
        "hooks": [ { "type": "command", "command": "bash $FORGE_HOME/guards/format-on-edit.sh" } ] } ]
    }

  Or install the plugin instead (guards auto-wire): /plugin marketplace add <this-repo> then /plugin install forgekit.
  Run \`forge doctor\` to verify.
EOF
}

uninstall_forge() {
  say "Uninstalling Forge (symlinks only; your files are untouched)"
  for d in "$REPO"/global/tools/*/; do [ -d "$d" ] && unlink_ours "$CLAUDE_DIR/skills/$(basename "$d")"; done
  for f in "$REPO"/global/crew/*.md; do [ -e "$f" ] && unlink_ours "$CLAUDE_DIR/agents/$(basename "$f")"; done
  unlink_ours "$BIN_DIR/forge"
  unlink_ours "$FORGE_HOME"
  say "Done. Any backed-up files remain as *.forge-bak-* next to their originals."
}

[ "$MODE" = uninstall ] && uninstall_forge || install_forge
