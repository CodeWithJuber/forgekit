# RUN — command sheet (current state)

> ⚠️ **Archived — pre-Forge.** Kept for history; **not maintained**. It describes an older
> hand-rolled `~/.claude` setup, not today's `forge` CLI. For the current workflow start at
> **[ONBOARDING.md](../../ONBOARDING.md)** → **[docs/GUIDE.md](../GUIDE.md)**. Any credentials or
> open action items below are historical and superseded — do not act on them.

Bundle: `~/Downloads/claude-global-config/`. Most of this is **already applied
live** on your machine. This is the accurate final command sheet.

## 0. Applied live (no action needed)
- 9 skills, 3 agents, 3 rules, 3 hooks, statusline, 3 `bin/` commands installed to `~/.claude/`.
- `settings.json`: model `sonnet`; statusLine + Pre/Post/Stop hooks; `permissions.allow` pruned to ~56; **plugins trimmed** (disabled code-simplifier, feature-dev, hookify → 19 enabled).
- **Graphify** installed globally; **Ponytail** installed as a plugin.
- 29 repos scaffolded with `claude-init`; redundant taste skills archived; `royalfront` project-skills thinned 35→17.
- Every settings edit backed up to `~/.claude/settings.backup.*.json`.

## 1. Restart to load it
Settings/hook/skill/plugin changes apply on restart.
```bash
node -e "const s=require(process.env.HOME+'/.claude/settings.json');console.log('model',s.model,'| hooks',Object.keys(s.hooks),'| plugins on',Object.values(s.enabledPlugins).filter(Boolean).length)"
```
In-app: `/hooks`, `/agents`, `/status`, `/plugin list`.

## 2. Still yours to do (needs your credentials/judgment)
```bash
# Rotate the GitHub PAT (still literal in settings.json):
#   github.com/settings/tokens → new fine-scoped token
echo 'export GITHUB_PAT="ghp_new"' >> ~/.zshrc && source ~/.zshrc
#   then edit mcpServers.github.env: "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PAT}"

# my-next-app has a committed .env with WHMCS creds — stop tracking + rotate:
cd ~/my-next-app && git rm --cached .env && echo ".env" >> .gitignore && git commit -m "chore: stop tracking .env"
```

## 3. Turn on session-learning (opt-in, cheap)
```bash
echo 'export ENABLE_SESSION_LEARNING=1' >> ~/.zshrc && source ~/.zshrc   # already present
# tune: SESSION_LEARN_MIN=25  SESSION_LEARN_MODEL=haiku
```

## 4. Everyday commands (on your PATH)
```bash
claude-init                  # in a repo: write AGENTS.md + thin CLAUDE.md (auto-detect stack)
claude-taste                 # list per-repo UI taste skills
claude-taste minimalist-ui   # enable one taste for the current repo
claude-learn-consolidate     # merge/dedupe/prune learned lessons (weekly; ~1-2 min)
```

## 5. Skills / agents (auto-fire, or force with /name)
```
/tech-selector  /reuse-first  /ui-workflow  /design-md  /dev-radar
/code-modernization  /cost-guard  /explore-plan-code  /self-improve
/graphify .        graphify hook install     # code graph (per repo)
/ponytail  /ponytail-review  /ponytail-audit # minimalism enforcer
```
Subagents in a prompt: "use **scout** to map X", "use **verifier** on this diff",
"use **frontend-verifier** on http://localhost:3000".

## 6. Per-repo setup
```bash
cd ~/repo && claude-init          # AGENTS.md + CLAUDE.md
graphify install --project && /graphify .   # optional code graph
claude-taste <name>               # optional per-repo UI taste
git add AGENTS.md CLAUDE.md
```

## 7. Revert
```bash
cp ~/.claude/settings.backup.<stamp>.json ~/.claude/settings.json   # settings
mv ~/.claude/skills-archive/* ~/.claude/skills/                     # restore taste skills
mv ~/royalfront/.claude/skills-archive/* ~/royalfront/.claude/skills/  # restore royalfront skills
cat ~/.claude/allow-pruned-*.json                                  # pruned allow entries
# re-enable a plugin: set true in settings.json enabledPlugins, or: claude plugin enable <name>
```
