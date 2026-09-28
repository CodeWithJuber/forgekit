# Example: adversarial doctor

> Guardrail claims without self-test are hollow. This example runs
> `forge doctor --adversarial`, which attacks Forge's own hooks with real
> payloads and reports the score — a blocked attack is good news.

## The pain

Every agent framework ships guardrails and asks you to trust them. Almost
nobody attacks their own guards: can a tool call smuggle a secret-file write
past the hook via `sed -i` or a heredoc redirect? What happens when the hook
receives truncated JSON — does the guard fail closed or wave it through? And
what if the permission layer itself is bypassed with
`--dangerously-skip-permissions`, making every hook advisory?

## Run it

```bash
# from the repo root (node src/cli.js is the CLI entry; or use an installed `forge`)
forge() { node "$PWD/src/cli.js" "$@"; }

# fire the full attack suite at the real guard binaries
forge doctor --adversarial
```

Expected on a healthy install: every rerouting attack **blocked** (exit 2),
malformed JSON **denied** fail-closed, the two benign controls **allowed** —
and three honest `!` warnings: empty stdin, `{}`, and a string-shaped
`tool_input` are currently allowed. Those are not attacker-reachable through
the real hook protocol (Claude Code always sends well-formed hook JSON), but a
pipeline that swallowed stdin would silently disable the guard — so they are
reported, not hidden.

To see a `fail`, simulate the permissions-bypass hole:

```bash
demo_home="$(mktemp -d)"
mkdir -p "$demo_home/.claude"
echo '{"permissions":{"defaultMode":"bypassPermissions"}}' > "$demo_home/.claude/settings.json"
HOME="$demo_home" forge doctor --adversarial   # adv: settings-bypass → ✗, exit 1
```

## What to look at

- No mocks: each probe pipes real hook JSON into the real `protect-paths.mjs`
  binary and reads its exit code. The verdict you see is the verdict an
  agent's tool call would get.
- `warn` vs `fail` is deliberate: `fail` means attacker-reachable bypass,
  `warn` means a robustness gap worth knowing about.
- Machine-readable: `forge doctor --adversarial --json` for CI.

## Cleanup

Nothing is written anywhere — the probes only read the guard binaries and
fire payloads at subprocesses. Delete `$demo_home` if you ran the bypass
simulation.

## Files

- `demo.sh` — the steps above as an executable script
- `demo.gif` — screen recording of the real output:
  [`mintlify/images/adversarial-doctor.gif`](../../mintlify/images/adversarial-doctor.gif)
  (rendered by `scripts/make-doctor-gif.py` from captured real CLI output)
