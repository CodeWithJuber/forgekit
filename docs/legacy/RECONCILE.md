# Audit of your live ~/.claude + how this bundle fits

> ⚠️ **Archived — pre-Forge.** Kept for history; **not maintained**. It describes an older
> hand-rolled `~/.claude` setup, not today's `forge` CLI. For the current workflow start at
> **[ONBOARDING.md](../../ONBOARDING.md)** → **[docs/GUIDE.md](../GUIDE.md)**. Any credentials or
> open action items below are historical and superseded — do not act on them.

Read from your actual machine on 2026-07-04. Honest feedback, then what changed.

## 🔴 Fix now

**1. Exposed GitHub token.** `~/.claude/settings.json` → `mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN` holds a `github_pat_…` in plaintext (file is mode 600, but any process running as you can read it, and it's one accidental screenshot/commit from leaking). Action: revoke it at github.com/settings/tokens, issue a new fine-scoped one, and reference it as `"${GITHUB_PAT}"` from your shell env instead of pasting the literal. Do the same review for the `hostlelo_ops_ed25519` path baked into an allow-rule.

**2. You're paying max rate for everything.** `"model": "opus[1m]"` + `"effortLevel": "high"` = the most expensive setup that exists, on every turn, in every project. You explicitly want low cost. Recommendation: default `"model": "sonnet"`, keep `effortLevel` at `"high"` only if you feel the quality drop, and switch to Opus per-session (`/model`) for genuinely hard work. Opus's 1M window also means huge prefixes → bigger cache-write bills. This one change is your biggest cost lever.

## 🟡 Worth cleaning

**3. `permissions.allow` has become a junk drawer.** It's collected ~20 one-off literal commands — specific `rsync`/`ssh` deploy strings, `perl` em-dash substitutions, a single-file `eslint` invocation, `Read(//Users/.../.gemini/...)`, `Skill(loop)`. These don't generalize and they bloat the file. Keep the useful *patterns* (`Bash(git:*)`, `Bash(npm:*)`, etc.) and delete the literal one-shots. Your broad `Bash(curl:*)` allow is also risky given you separately deny `curl | sh` — fine, but know it's wide.

**4. UI pain is partly self-inflicted by taste-skill sprawl.** You have ~13 design/taste skills in `~/.claude/skills/` (design-taste-frontend + a v1, high-end-visual-design, minimalist-ui, industrial-brutalist-ui, stitch-design-taste, gpt-taste, brandkit, image-to-code, imagegen-frontend-web/mobile, full-output-enforcement, redesign-existing-projects) **plus** the `ui-ux-pro-max` and `taste-skill` plugins. When several can trigger, output gets muddy and inconsistent — which reads as "UI is unreliable." The new `ui-workflow` skill enforces **one direction per project + a screenshot verify loop**. Recommendation: pick your 1–2 favorites, archive the rest out of `skills/` so they stop competing.

**5. Plugin load is heavy.** ~30 plugins enabled. Every enabled plugin's tools sit in the system-prompt layer, so more plugins = bigger prefix = higher cache-write cost and slower cold turns. You likely don't use all of: `firecrawl`, `postman`, `data-engineering`, `atomic-agents`, `microsoft-docs`, `greptile`, `playground`, `sentry`, `gitlab` (you use GitHub). Disable what you don't actively use; re-enable on demand.

**6. Disk cruft.** `~/.claude/debug/` (~500 files), `security/` (~582), `session-env/` (~525), `todos/` (~448) have accumulated. Not a performance problem for Claude, but safe to prune old entries if you want the space back. Leave `plugins/`, `rules/`, `skills/`, `settings.json`, `CLAUDE.md` alone.

## 🟢 What's good (keep it)
Your `rules/` system (quality.md, security.md, common/python/typescript), memory stack (`remember` + `episodic-memory` + `.ai/AGENTS.md`), and LSP plugins (`serena`, `typescript-lsp`) are solid. **That's why this bundle does NOT ship a memory system or overwrite your CLAUDE.md/settings.json** — you already have better.

## What this bundle adds (additive, no clobber)
Run `bash install.sh`. It copies only new items and backs up any name clash:

- **Skills** — `tech-selector` (verify current best tool from Context7 + web + GitHub health, not training data), `ui-workflow` (one-direction + shadcn MCP + screenshot verify), `code-modernization` (incremental legacy migration, from claude.com/solutions/code-modernization), plus `cost-guard` and `explore-plan-code`.
- **Agents** — `scout` (cheap haiku search), `verifier` (diff review), `frontend-verifier` (screenshots UI at desktop+mobile, checks a11y).
- **Rule** — `rules/tech-currency.md` (matches your existing rules format).
- **Hooks + statusline** — `protect-paths` (blocks secret-file writes + destructive cmds), `format-on-edit` (auto-format, no tokens), and a status line with cost + prompt-cache `⚡%` indicator. These need the one-time settings.json merge the installer prints.

## Recommended settings.json edits (apply by hand)
```jsonc
{
  "model": "sonnet",                    // was "opus[1m]" — switch to opus per-session for hard work
  "mcpServers": {
    "github": { "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PAT}" } }  // was a literal token
  },
  // prune permissions.allow to patterns; drop the one-off rsync/ssh/perl/eslint literals
  "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh" },
  "hooks": {
    "Stop": [ /* keep your existing continuous-learning hook */ ],
    "PreToolUse":  [ { "matcher": "Edit|Write|MultiEdit|Bash", "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/protect-paths.sh" } ] } ],
    "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit",      "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/format-on-edit.sh" } ] } ]
  }
}
```

## Cross-project use (your many repos)
These global skills/agents/rules apply everywhere automatically. For a specific
repo, drop a short `CLAUDE.md` at its root naming its stack + commands (use the
`hostlelo-project-layer/` in this bundle as the template). The generic layer
covers homebazaar, my-next-app, royalfront, openhost, ultahost-clone, etc.
