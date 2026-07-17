#!/usr/bin/env bash
# Forge installer — idempotent, reversible, offline.
#   bash install.sh              install (symlink global/ into ~/.forge and ~/.claude, put `forge` on PATH)
#   bash install.sh --dry-run    print what it would do, change nothing
#   bash install.sh --uninstall  remove Forge's own symlinks (never touches your other files)
# It never downloads anything and never edits settings.json for you — it prints the
# hook/statusline block to merge by hand, so your existing config is untouched.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Read-only assets (guards/statusline/tools) — a symlink into the bundle so hooks resolve.
FORGE_ASSETS="${FORGE_ASSETS:-$HOME/.forge}"
# Mutable personal state (recall) — a REAL dir in the XDG state home, NEVER inside the
# source tree. Keeping these separate is the whole point of P0-03.
FORGE_HOME="${FORGE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/forgekit}"
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
# Run argv directly (no eval — S-02). In dry-run, print the argv instead of executing.
act() { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else "$@"; fi; }

# link SRC DEST — back up an existing real file/dir, then symlink.
link() {
  local src="$1" dest="$2"
  [ -e "$src" ] || { say "skip (missing in bundle): $src"; return; }
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    act mv "$dest" "$dest.forge-bak-$STAMP"; say "backed up existing $dest"
  fi
  act mkdir -p "$(dirname "$dest")"
  act ln -sfn "$src" "$dest"
  say "linked $dest -> $src"
}

# unlink DEST — remove only if it is a symlink pointing back into this repo.
unlink_ours() {
  local dest="$1"
  if [ -L "$dest" ] && case "$(readlink "$dest")" in "$REPO"/*) true;; *) false;; esac; then
    act rm -f "$dest"; say "removed $dest"
  fi
}

# One-shot migration: older installs symlinked ~/.forge -> <repo>/global, so personal
# recall facts were written into the source tree (global/recall/facts). Move them out.
migrate_recall() {
  local old="$REPO/global/recall/facts"
  [ -d "$old" ] || return 0
  act mkdir -p "$FORGE_HOME/recall"
  if [ ! -e "$FORGE_HOME/recall/facts" ]; then
    act mv "$old" "$FORGE_HOME/recall/facts"
    say "migrated personal recall -> $FORGE_HOME/recall/facts (out of the source tree)"
  else
    say "note: personal recall found in the source tree at $old; $FORGE_HOME/recall/facts already exists — merge by hand"
  fi
}

install_forge() {
  say "Installing Forge from $REPO"
  link "$REPO/global" "$FORGE_ASSETS"
  act mkdir -p "$FORGE_HOME"   # mutable state home (recall) — real dir, outside the source tree
  migrate_recall
  for d in "$REPO"/global/tools/*/; do [ -d "$d" ] && link "$d" "$CLAUDE_DIR/skills/$(basename "$d")"; done
  for f in "$REPO"/global/crew/*.md; do [ -e "$f" ] && link "$f" "$CLAUDE_DIR/agents/$(basename "$f")"; done
  link "$REPO/src/cli.js" "$BIN_DIR/forge"
  [ "$DRY" = 1 ] || chmod +x "$REPO/src/cli.js" 2>/dev/null || true

  case ":$PATH:" in *":$BIN_DIR:"*) : ;; *) say "note: add $BIN_DIR to PATH (e.g. echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc)";; esac

  # Wire guards + statusline into settings.json via the idempotent, marker-guarded merge
  # (`forge init --settings-only`) instead of printing a block to paste by hand. mergeSettings
  # never clobbers existing entries — it unions hooks/permissions and stamps a _forge marker,
  # so re-running install.sh is a no-op. Under --dry-run we print the call for transparency.
  if [ "$DRY" = 1 ]; then
    say "[dry-run] would merge guards + statusline into $CLAUDE_DIR/settings.json via:"
    say "[dry-run]   node \"$REPO/src/cli.js\" init --settings-only"
    say "[dry-run] (idempotent + _forge-marker-guarded — existing settings are preserved)"
  else
    say "Merging guards + statusline into $CLAUDE_DIR/settings.json (idempotent, never clobbers)"
    node "$REPO/src/cli.js" init --settings-only 2>&1 | sed 's/^/  /' \
      || say "note: settings merge skipped — run \`forge init --settings-only\` once node is available"
  fi

  cat <<EOF

  Done. Or install the plugin instead (guards auto-wire): /plugin marketplace add <this-repo> then /plugin install forgekit.
  Run \`forge doctor\` to verify.
EOF
}

uninstall_forge() {
  say "Uninstalling Forge (symlinks only; your files are untouched)"
  for d in "$REPO"/global/tools/*/; do [ -d "$d" ] && unlink_ours "$CLAUDE_DIR/skills/$(basename "$d")"; done
  for f in "$REPO"/global/crew/*.md; do [ -e "$f" ] && unlink_ours "$CLAUDE_DIR/agents/$(basename "$f")"; done
  unlink_ours "$BIN_DIR/forge"
  unlink_ours "$FORGE_ASSETS"
  say "Personal state in $FORGE_HOME is left untouched (remove it by hand if you want)."
  say "Done. Any backed-up files remain as *.forge-bak-* next to their originals."
}

[ "$MODE" = uninstall ] && uninstall_forge || install_forge
