# Examples

## Per-repo rule override

[`rules.override.json`](./rules.override.json) shows a project adding its own rules on top of
Forge's shared source. Copy it to `.forge/rules.json` in your repo, then run `forge sync` —
the extra rules are appended to every tool's config (AGENTS.md, CLAUDE.md, Cursor, Gemini, …).

## Common flows

```bash
forge init                       # emit every tool's config from one source
forge remember "db port" "..."   # add a durable project fact (inlined into AGENTS.md)
forge scan ./SKILL.md            # vet a third-party skill/MCP before installing it
forge verify                     # tests + hallucinated-symbol check + provenance stamp
forge cost                       # real per-day spend across your AI tools
forge doctor                     # health check
```
