#!/usr/bin/env bash
# Clean-install / uninstall smoke test — the evidence-tier proof that `install.sh` and
# `forge init` actually wire (and unwire) global config correctly, end to end, on a REAL
# filesystem. Everything runs inside throwaway temp HOMEs created here and torn down on
# exit, so the real ~/.claude / ~/.forge are never touched. Portable to macOS's bash 3.2
# (no associative arrays, no ${var,,}) and clean under `shellcheck --severity=error`.
#
# What it proves:
#   1. `bash install.sh` (driven with HOME=<tmp>) creates resolvable asset symlinks, merges
#      the exec-form hooks (command:"bash" + args + the _forge marker) into settings.json,
#      and leaves the guard scripts present + executable.
#   2. `forge init --settings-only` (FORGE_SETTINGS_PATH into the temp HOME) exits 0 and is
#      idempotent — a second run leaves the file byte-for-byte unchanged.
#   3. The uninstall path removes the Forge hooks AND the symlinks, exit 0.
#   4. A corrupt settings.json makes `forge init --settings-only` exit non-zero (RA-04).
#   5. Installing under a path WITH A SPACE and then executing an installed guard proves the
#      ME-23 exec form + RA-12 quoting survive spaces (the concrete RA-12/ME-23 regression).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"

# --- tiny assert harness ------------------------------------------------------
PASS=0
fail() { printf '  FAIL: %s\n' "$*" >&2; exit 1; }
ok()   { PASS=$((PASS + 1)); printf '  ok: %s\n' "$*"; }
phase() { printf '\n== %s ==\n' "$*"; }

# All work lives under one temp root we clean up unconditionally.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/forge-smoke.XXXXXX")"
cleanup() { chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
phase "1. clean install into an isolated HOME"
H1="$WORK/home1"
mkdir -p "$H1"
# Drive install.sh entirely through HOME: it derives ~/.forge, ~/.claude, ~/.local/bin and
# XDG state from $HOME, so a temp HOME isolates every path it writes.
HOME="$H1" bash "$REPO/install.sh" >"$WORK/install1.log" 2>&1 \
  || { cat "$WORK/install1.log" >&2; fail "install.sh exited non-zero"; }
ok "install.sh exit 0"

SETTINGS="$H1/.claude/settings.json"
[ -f "$SETTINGS" ] || fail "settings.json was not created at $SETTINGS"
ok "settings.json created"

# Asset symlink must exist AND resolve (-e follows the link).
[ -L "$H1/.forge" ] || fail "\$HOME/.forge is not a symlink"
[ -e "$H1/.forge" ] || fail "\$HOME/.forge symlink does not resolve"
ok "\$HOME/.forge symlink resolves"

# `forge` on PATH is a resolvable symlink.
if [ ! -L "$H1/.local/bin/forge" ] || [ ! -e "$H1/.local/bin/forge" ]; then
  fail "\$HOME/.local/bin/forge symlink missing or dangling"
fi
ok "forge launcher symlink resolves"

# Guard scripts present + executable (via the ~/.forge asset link).
for g in protect-paths.sh cost-budget.sh doom-loop.sh cortex.sh; do
  [ -x "$H1/.forge/guards/$g" ] || fail "guard not present/executable: $g"
done
ok "guard scripts present + executable"

# Exec form (ME-23): command:"bash", an args array, and the _forge marker must all be present.
grep -q '"command": "bash"' "$SETTINGS" || fail "settings.json has no exec-form command:\"bash\""
grep -q '"args"'            "$SETTINGS" || fail "settings.json hooks have no args array"
grep -q '"_forge"'          "$SETTINGS" || fail "settings.json missing the _forge marker"
# A hook must actually point at a guard script (proves args carry the real path).
grep -q 'guards/protect-paths.sh' "$SETTINGS" || fail "settings.json hooks don't reference the guards"
ok "settings.json carries exec-form Forge hooks (command/args/_forge)"

# ---------------------------------------------------------------------------
phase "2. forge init --settings-only is idempotent"
IDEM="$WORK/idem-settings.json"
FORGE_SETTINGS_PATH="$IDEM" HOME="$H1" "$NODE" "$REPO/src/cli.js" init --settings-only \
  >"$WORK/idem1.log" 2>&1 || { cat "$WORK/idem1.log" >&2; fail "first --settings-only exited non-zero"; }
[ -f "$IDEM" ] || fail "--settings-only did not write $IDEM"
cp "$IDEM" "$WORK/idem-after1.json"
ok "first --settings-only merge exit 0"

FORGE_SETTINGS_PATH="$IDEM" HOME="$H1" "$NODE" "$REPO/src/cli.js" init --settings-only \
  >"$WORK/idem2.log" 2>&1 || { cat "$WORK/idem2.log" >&2; fail "second --settings-only exited non-zero"; }
cmp -s "$WORK/idem-after1.json" "$IDEM" || fail "second --settings-only changed the file (not idempotent)"
ok "second --settings-only is byte-for-byte identical (idempotent)"

# ---------------------------------------------------------------------------
phase "3. corrupt settings.json fails init --settings-only (RA-04)"
CORRUPT="$WORK/corrupt-settings.json"
printf '{ this is not valid json ' >"$CORRUPT"
set +e
FORGE_SETTINGS_PATH="$CORRUPT" HOME="$H1" "$NODE" "$REPO/src/cli.js" init --settings-only \
  >"$WORK/corrupt.log" 2>&1
code=$?
set -e
[ "$code" -ne 0 ] || fail "init --settings-only returned 0 on a corrupt settings file"
ok "corrupt settings.json makes init exit non-zero ($code)"

# ---------------------------------------------------------------------------
phase "4. uninstall removes hooks + symlinks"
HOME="$H1" bash "$REPO/install.sh" --uninstall >"$WORK/uninstall.log" 2>&1 \
  || { cat "$WORK/uninstall.log" >&2; fail "install.sh --uninstall exited non-zero"; }
ok "install.sh --uninstall exit 0"
! grep -q '"_forge"' "$SETTINGS" || fail "_forge marker still present after uninstall"
! grep -q 'guards/protect-paths.sh' "$SETTINGS" || fail "guard hooks still present after uninstall"
ok "Forge hooks removed from settings.json"
[ ! -e "$H1/.forge" ]           || fail "\$HOME/.forge symlink survived uninstall"
[ ! -e "$H1/.local/bin/forge" ] || fail "forge launcher survived uninstall"
ok "asset symlinks removed"

# ---------------------------------------------------------------------------
phase "5. install under a path WITH A SPACE, then run a guard (RA-12 / ME-23)"
SPACE_HOME="$WORK/dir with space/home"
mkdir -p "$SPACE_HOME"
HOME="$SPACE_HOME" bash "$REPO/install.sh" >"$WORK/install-space.log" 2>&1 \
  || { cat "$WORK/install-space.log" >&2; fail "install.sh under a spaced path exited non-zero"; }
ok "install.sh succeeds under a path containing a space"

GUARD="$SPACE_HOME/.forge/guards/protect-paths.sh"
[ -x "$GUARD" ] || fail "guard not executable under spaced path: $GUARD"

# Feed a benign PreToolUse payload (a Read of a harmless file) into the installed guard, whose
# absolute path contains a space. Exit 0 proves the exec form + quoting handle the space.
BENIGN="$WORK/benign-hook.json"
printf '%s' '{"tool_name":"Read","tool_input":{"file_path":"/tmp/harmless.txt"}}' >"$BENIGN"
set +e
bash "$GUARD" <"$BENIGN" >"$WORK/guard.log" 2>&1
gcode=$?
set -e
[ "$gcode" -eq 0 ] || { cat "$WORK/guard.log" >&2; fail "guard under spaced path exited $gcode (expected 0)"; }
ok "installed guard runs from a spaced path and allows a benign call"

printf '\nAll %s smoke assertions passed.\n' "$PASS"
