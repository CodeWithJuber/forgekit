#!/usr/bin/env bash
# PreToolUse hook: block edits to secret/credential files and obviously destructive Bash.
# Exit 2 = block the tool call and feed the reason back to Claude (works across versions).
set -euo pipefail

input="$(cat)"

# Extract fields without requiring jq (fallback to grep).
if command -v jq >/dev/null 2>&1; then
  tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
  fpath="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
else
  tool="$(printf '%s' "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  fpath="$(printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  cmd="$(printf '%s' "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
fi

deny() {
  # Structured decision for current Claude Code; exit-2 + stderr as the version-agnostic fallback.
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  fi
  echo "BLOCKED by protect-paths guard: $1" >&2
  exit 2
}

# Protect secret/credential files from writes.
case "$fpath" in
  *.env|*/.env|*.env.*|*/.env.*) deny "refusing to modify env file ($fpath). Edit it yourself if intended." ;;
  *.pem|*/id_rsa|*/id_ed25519|*.key) deny "refusing to modify credential/key file ($fpath)." ;;
  */secrets/*|*/.ssh/*) deny "refusing to modify path under secrets/ or .ssh/ ($fpath)." ;;
esac

# Guard clearly destructive shell commands.
if [ -n "${cmd:-}" ]; then
  case "$cmd" in
    *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf --no-preserve-root"*) deny "destructive rm detected." ;;
    *"git push --force"*|*"git push -f"*) deny "force-push blocked. Ask the user first." ;;
    *"DROP TABLE"*|*"DROP DATABASE"*|*"TRUNCATE "*) deny "destructive SQL detected. Confirm with the user." ;;
  esac
  # Close the Bash secret-READ bypass (P0-04): the Read tool denies .env/keys, but a shell
  # `cat .env` / `git show HEAD:.env` sidesteps that. Match a reader command anchored to a
  # real command boundary (start, or after ; | &) so prose inside a quoted arg (a commit
  # message mentioning ".env") isn't a false positive, AND require a protected path token.
  # Best-effort defence in depth — a content scan like `rg TOKEN .` with no named path can't
  # be caught here; that's what secret-redact.sh is for.
  #
  # SCOPE: this is a POSIX-ERE regex guard, not a sandbox. Regex cannot parse shell, so
  # interpreter-driven access/writes — `python -c 'open(".env","w")…'`, `node -e …`, `perl -e`
  # — are DELIBERATELY out of scope here. This layer sits behind the permission system and
  # secret-redact.sh; treat every match/miss as best-effort hardening, never a boundary.
  #
  # Git subcommands that can print file/history content (RA-05, HI-07): show, log, diff,
  # stash (show -p), cat-file, archive, grep, blame, show-index, bundle. Subcommand may be
  # followed by a space or end the command string.
  # HI-07 (best-effort hardening): tolerate an optional `env `/`command ` or `VAR=val `
  # prefix and an optional absolute/relative path before `git` (e.g. `/usr/bin/git`), then
  # skip git's own global options (`-C <dir>`, `--no-pager`, `-c k=v`, `--git-dir=…`,
  # `--work-tree=…`) between `git` and the subcommand. A wrapper we don't model can still slip.
  gitpfx='([[:alnum:]_]+=[^[:space:]]+[[:space:]]+|(env|command)[[:space:]]+)*([^[:space:]]*/)?git[[:space:]]+'
  gitopt='(-C[[:space:]]+[^[:space:]]+[[:space:]]+|--no-pager[[:space:]]+|-c[[:space:]]+[^[:space:]]+[[:space:]]+|--git-dir=[^[:space:]]+[[:space:]]+|--work-tree=[^[:space:]]+[[:space:]]+)*'
  gitsub='(show|log|diff|stash|cat-file|archive|grep|blame|show-index|bundle)([[:space:]]|$)'
  reader="(^|[;&|])[[:space:]]*((cat|less|more|head|tail|nl|xxd|od|strings|base64|rg|grep|ag)[[:space:]]|${gitpfx}${gitopt}${gitsub})"
  # \b anchors the extensions so `.key` matches a real key file but NOT `Object.keys`,
  # and `.env` matches `.env`/`.env.prod` but NOT `.environment`.
  secret='(\.env(\.[A-Za-z0-9_-]+)?\b|id_rsa\b|id_ed25519\b|\.pem\b|\.key\b|/secrets/|/\.ssh/)'
  if printf '%s' "$cmd" | grep -qE "$reader" && printf '%s' "$cmd" | grep -qE "$secret"; then
    deny "reading a protected secret path via Bash is blocked. Read it yourself if intended."
  fi
  # Close the Bash secret-WRITE bypass (HI-06): the Edit/Write guard covers tool writes, but a
  # shell `echo x > .env`, `printf … >> .env`, `tee .env`, `sed -i … .env`, `cp/mv/install X
  # .env`, `dd of=.env`, or a truncation (`> .env`, `: > .env`) mutates a protected file past
  # it. Detect a protected-path token appearing (a) as a redirection target (`>`/`>>` then the
  # path) or (b) as an argument to a known mutating command. Interpreter writes are out of
  # scope (see SCOPE note above). Each alternative embeds "$secret", so a bare `echo hi >
  # out.txt` (no protected token) is never blocked.
  w_redir=">>?[[:space:]]*[\"']?[^[:space:]<>|;&]*${secret}"
  w_cmd="(^|[;&|])[[:space:]]*(${gitpfx})?(tee([[:space:]]+-a)?|cp|mv|install)[[:space:]]+[^;&|]*${secret}"
  w_sed="(^|[;&|])[[:space:]]*sed[[:space:]]+[^;&|]*-i[^;&|]*${secret}"
  w_dd="(^|[;&|])[[:space:]]*dd[[:space:]]+([^;&|]*[[:space:]])?of=[^[:space:]]*${secret}"
  if printf '%s' "$cmd" | grep -qE "${w_redir}|${w_cmd}|${w_sed}|${w_dd}"; then
    deny "writing to a protected secret path via Bash is blocked. Edit it yourself if intended."
  fi
  # Pipe-to-shell (e.g. curl … | sh). Boundary-aware so legit `… | shellcheck` is not caught.
  if [[ "$cmd" =~ \|[[:space:]]*(sh|bash|zsh)([[:space:]]|$) ]]; then
    deny "piping content to a shell is blocked."
  fi
fi

exit 0
