# The Claude & Claude Code Development Stack: A Complete End-to-End Landscape (July 2026)

## TL;DR
- The Claude Code ecosystem has consolidated around five composable primitives — **Skills (SKILL.md), Hooks, Plugins, MCP servers, and Subagents/Agent Teams** — all now distributable through an official Anthropic plugin marketplace and community registries; the SKILL.md format became an open cross-agent standard in December 2025 and works across Claude Code, Cursor, Codex, and Gemini CLI.
- For a full software lifecycle, the current "default" stack looks like: **Superpowers** (TDD + subagent methodology, ~137k stars) or **anthropics/skills** for skills; **PostToolUse/PreToolUse hooks** for lint/format/security enforcement; **Playwright MCP + Context7 + GitHub MCP + filesystem/memory** as core MCP servers; **CLAUDE.md + Auto Memory (+ Mem0/claude-mem)** for context; **ccusage + /usage** for cost; and **sandboxing + Gitleaks/Semgrep + /security-review** for security.
- The biggest 2026 shifts: Claude Code shipped OS-level **sandboxing** ("sandboxing safely reduces permission prompts by 84%," per Anthropic's engineering post), **Agent Teams** for multi-agent parallelism, the **official MCP Registry** (registry.modelcontextprotocol.io) went to preview, plugins reached the official marketplace, and a wave of **supply-chain security incidents** (CVE-2025-59536/59356, CVE-2026-21852, Mitiga's ~/.claude.json attack) made MCP/plugin vetting a first-class concern.

## Key Findings

**The extension model is now layered and official.** Anthropic has formalized a decision hierarchy: **CLAUDE.md/rules** for always-on context, **Skills** for model-invoked procedures/knowledge, **Hooks** for deterministic enforcement, **Subagents/Agent Teams** for delegation, **MCP servers** for external tools, and **Plugins** as the distribution unit that bundles all of the above. Custom slash commands have merged into skills — `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy`.

**Community curation is enormous and fast-moving.** The canonical curated index is **hesreallyhim/awesome-claude-code** (~47.8k stars, hand-curated). **obra/superpowers** is the dominant methodology framework (Claude Bazaar's plugin listing, updated April 7 2026, cites "67.2K installs, 137.0K GitHub stars"; secondary sources range 137K–180K, and some blogs quote inflated figures up to 215K — treat the higher numbers with caution). **anthropics/skills** (~158k stars) is the official skills repo. Star counts move weekly; treat all figures as point-in-time.

**Security is the defining risk story of 2026.** Multiple disclosed CVEs, a March 2026 source-code leak (512k lines of TypeScript via npm), and Snyk's February 2026 "ToxicSkills" study (36.82% / 1,467 of 3,984 audited skills had at least one security flaw; 13.4% / 534 carried a critical issue; 76 confirmed malicious payloads) mean supply-chain vetting of skills, plugins, and MCP servers is now mandatory, not optional.

## Details — Stage by Stage

### 1. Agent Skills (SKILL.md)
A skill is a folder containing a required `SKILL.md` (YAML frontmatter: `name`, `description`, optional `allowed-tools`, `context: fork`, `agent:`) plus optional `scripts/`, `references/`, `assets/`. Skills use **progressive disclosure**: only the ~100-token name+description loads at session start; the full body (<5k tokens) loads only when Claude's LLM judges it relevant (no embeddings/classifiers — pure LLM routing). The format was open-sourced as a standard (agentskills.io) in December 2025 and adopted by OpenAI Codex, Cursor, and Gemini CLI.

**Scopes:** Project skills (`.claude/skills/`, committed to git), User skills (`~/.claude/skills/`), Plugin skills, and Managed (org-wide via managed settings).

**Official Anthropic skills** (in `anthropics/skills`, ~17 top-level directories): document skills **pdf, docx, xlsx, pptx**; **frontend-design** (277k+ installs, anti-"AI slop"); **skill-creator** (meta-skill, `/plugin install skill-creator@anthropic-agent-skills`); **mcp-builder**; **canvas-design**; **artifacts-builder**; plus webapp-testing. Install via `npx skills add anthropics/skills --skill <name>` or the `anthropic-agent-skills` marketplace.

**Community skill collections:** **obra/superpowers** (14 SKILL.md files enforcing brainstorm→plan→TDD→subagent-dev→review); **Antigravity Awesome Skills** (1,234+ cross-agent skills, ~22k stars, `npx antigravity-awesome-skills --claude`); **K-Dense-AI/claude-skills-mcp**. **Discovery hubs:** SkillsMP (indexes 2M+ skills), skills.sh/officialskills.sh, claudemarketplaces.com (300k+ monthly visitors), mcpmarket.com.

### 2. Hooks
Hooks are deterministic event handlers in `.claude/settings.json` (team) or `settings.local.json` (personal). The event set has grown from 6 (June 2025) to ~17–21 by 2026, including: **SessionStart, SessionEnd, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop, SubagentStart, SubagentStop, PreCompact, Notification**, plus newer TeammateIdle/TaskCreated/TaskCompleted for Agent Teams. Handler types: **command** (shell), **http** (POST to endpoint, added Feb 2026), **prompt** (single-turn LLM eval), and **agent** (subagent verifier).

**Key mechanics:** Exit code 2 in PreToolUse blocks a tool (stderr fed back to Claude); exit 2 in Stop forces Claude to keep working (guard against loops with `stop_hook_active`). PreToolUse returns `allow/deny/ask/defer` (precedence deny>defer>ask>allow), can rewrite tool input via `updatedInput`, and `updatedToolOutput` (v2.1.121+) can redact secrets from any tool's output.

**Common uses:** PostToolUse auto-format (prettier/eslint on Write|Edit); PreToolUse block `rm -rf`/`DROP TABLE`/`.env` reads (the reliable way to block .env — permission rules and .claudeignore can be bypassed); Stop-hook `npm test` gate; SessionStart context injection (git branch); Notification/TTS. **Community collections:** disler/claude-code-hooks-mastery, FlorianBruniaux/claude-code-ultimate-guide, luongnv89/claude-howto.

### 3. Plugins
A plugin is a directory with `.claude-plugin/plugin.json` plus components: `skills/`, `agents/`, `hooks/`, `.mcp.json`, LSP servers, and monitors. Install via `/plugin marketplace add owner/repo` then `/plugin install name@marketplace`. Plugins solve "tribal knowledge" (Anthropic's May 2026 term) — they're versioned, namespaced, and git-distributable.

**Official marketplace:** **anthropics/claude-plugins-official** (`/plugins` internal Anthropic, `/external_plugins` partners). Reference plugins in `anthropics/claude-code/plugins`: **pr-review-toolkit** (5 parallel Sonnet review agents), **plugin-dev** (8-phase create-plugin workflow), **ralph-loop** (autonomous iteration via Stop hook), agent-sdk-dev. Partner plugins: Shopify AI Toolkit, AWS Agent Toolkit, Airtable, Mercado Pago, Convex, CrowdStrike, HashiCorp, Vercel. Superpowers was accepted into the official Anthropic marketplace on January 15, 2026.

**Community marketplaces:** Superpowers marketplace (`obra/superpowers-marketplace`), and directories like claudemarketplaces.com (2,500+ marketplaces, 12,500+ servers indexed), claudepluginhub.com, aitmpl.com (340 plugins + 1,367 skills, CCPI package manager). Thoughtworks Technology Radar endorsed the git-based marketplace model for killing "version drift."

### 4. MCP Servers
MCP (open-standard, Anthropic, late 2024) is now the de-facto tool plug for AI agents. The **official MCP Registry** (registry.modelcontextprotocol.io) launched in preview Sept 8, 2025 as the single source of truth feeding sub-registries; per Anthropic's Dec 9, 2025 announcement (donating MCP to the Agentic AI Foundation), "There are now more than 10,000 active public MCP servers... 97M+ monthly SDK downloads across Python and TypeScript." PulseMCP tracks ~20k mid-2026, though registry data is heavily inflated by CI-republished duplicates — SafeDep found ~64.7M raw entries mapping to only ~1,691 unique packages. The MCP 2026-07-28 spec (RC May 2026) adds a stateless core, MCP Apps (server-rendered UI, launched Jan 26 2026 with Figma/Slack/Canva/Asana partners), and Tasks.

**Most-used servers by category (mid-2026 GitHub star counts, verified from live GitHub pages):**
- **Browser/testing:** microsoft/playwright-mcp (~34k, official Microsoft; use `@playwright/mcp`, not deprecated `@modelcontextprotocol/server-playwright`); Chrome DevTools MCP; Browserbase/Stagehand.
- **Reference/core:** modelcontextprotocol/servers monorepo (~86–87k stars, official) — filesystem, memory (knowledge graph), sequential-thinking, fetch.
- **Docs:** upstash/context7 (~58k, vendor) — version-specific library docs via "use context7."
- **GitHub/Git:** github/github-mcp-server (~31k, official GitHub).
- **Database:** supabase-community/supabase-mcp (~2.7k, official Supabase, hosted at mcp.supabase.com with OAuth; the most-used database MCP by traffic); Postgres MCP; plus MongoDB/Redis servers.
- **Search/web:** Exa (most-used agent search server 2026); Firecrawl; Tavily.
- **Cloud:** AWS MCP Server (GA 2026, part of Agent Toolkit for AWS, IAM SigV4 auth via mcp-proxy-for-aws); Cloudflare; Vercel.
- **Design:** Figma MCP; design-context-bridge.
- **Comms/PM:** Slack, Atlassian (Jira/Confluence, deprecating SSE June 30 2026), Linear, Sentry, Notion — many moved to remote HTTP endpoints in 2026.
- **Memory:** @modelcontextprotocol/server-memory; Mem0.

**Awesome lists:** punkpeye/awesome-mcp-servers (~90k, main community list), wong2/awesome-mcp-servers, tolkonepiu/best-of-mcp-servers (ranked weekly). **Wiring into Claude Code:** `claude mcp add <name> <cmd>`, `.mcp.json` (project), or `~/.claude.json`; MCP tool permission format is `mcp__server__tool`. Best practice: don't run more than ~6 at once; scope credentials to read-only.

### 5. Custom Rules / Memory / Context Engineering
**CLAUDE.md** files (project root, `~/.claude/`, enterprise/managed, nested per-directory) load at every session start. Best practices: keep under 200 lines (adherence drops beyond); use path-scoped rules to load instructions only for matching files; project-root CLAUDE.md survives `/compact` (re-read from disk); `@path` imports organize but don't save tokens (all load at launch). CLAUDE.md is context, not enforcement — for hard blocks use a PreToolUse hook.

**Auto Memory** (v2.1.59+): Claude writes its own notes to `~/.claude/projects/<project>/memory/`, loading the first 200 lines of MEMORY.md at startup. Hard limits in source: 200-line index cap and 5-files-per-turn retrieval, with silent truncation (the "memory cliff"). Four memory types: user, feedback, project, reference (info derivable via grep/git should NOT be saved).

**External memory backends:** **Mem0** (~58k stars, hosted MCP + lifecycle hooks; Mem0's own research page, updated May 2026, reports its token-efficient algorithm "hits 92.5 on LoCoMo, 94.4 on LongMemEval... averaging under 7,000 tokens per retrieval call"); **claude-mem** (continuous capture, SQLite + FTS5/vector, Haiku summaries); **Hindsight** (94.6% LongMemEval, MIT, self-hostable); **supermemory** (cross-machine sync). Anthropic's **memory tool** (API, client-side file ops, pairs with context editing + compaction, ZDR-eligible). Context-engineering principle: optimize signal-to-noise per token; retrieve just-in-time; use prompt caching (cache reads ≈10% of input price).

### 6. Subagents / Agent Orchestration
**Subagents** run in isolated context windows and return only their final message (context preservation + parallelization + per-agent least privilege). Built-ins: **Explore** and **Plan** (read-only, skip CLAUDE.md/git for lean context), **general-purpose** (inherits model + full tools), plus helpers statusline-setup (Sonnet) and claude-code-guide (Haiku). Custom agents defined in `.claude/agents/` with tool scoping and per-agent `model:` (e.g. `model: haiku` for cheap subtasks).

**Agent Teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, v2.1.32+): one "team lead" coordinates teammates via a shared task list; teammates run in their own contexts and can message each other directly (unlike subagents that only report to the parent). **Orchestration patterns:** parallel fan-out for independent tasks (60–80% wall-clock savings), sequential chains for dependent work, orchestrator-classifies-then-routes to Haiku/Sonnet/Opus by complexity, panel review for quality. Community orchestrators: Agent Teams, Gas Town, Multiclaude; git worktrees isolate parallel agents. The **Ralph Wiggum loop** (Geoffrey Huntley, July 2025) runs an agent in a loop until a condition is met — now supported natively via `/loop`, `/goal` (v2.1.139+), and `/batch`, plus the ralph-loop plugin. Superpowers' **subagent-driven-development** skill (94.8k installs) dispatches a fresh subagent per task with two-stage review (spec compliance, then code quality).

### 7. Cost Management
**Built-in:** `/usage` (aka `/cost`, `/stats`) shows session cost + plan limits; `/context` visualizes the context window as a colored grid. Per Claude Code's cost docs, "the average cost is around $13 per developer per active day and $150–250 per developer per month, with costs remaining below $30 per active day for 90% of users" (Business Insider notes the per-day figure doubled from $6 on April 15, 2026). Plan caps: Pro ~44k tokens/5-hr window, Max5 ~88k, Max20 ~220k, plus weekly caps.

**Community trackers** (all parse local JSONL logs — nothing leaves your machine): **ccusage** (~16.5k stars, `npx ccusage`, daily/monthly/session/5-hr-block reports, now multi-tool for Codex/OpenCode/Gemini/Copilot etc.); **Claude-Code-Usage-Monitor** (`pip install claude-monitor`, `cmonitor`, live burn-rate + prediction); **ccflare**; **ccstatusline** (status-line); Clusage (VS Code extension).

**Reduction techniques:** model tiering (Haiku for simple, Sonnet default, Opus for hard reasoning; `/model` to switch); `/compact` with custom instructions; clearing context between tasks; deferred MCP tool loading (only tool names enter context until used); prompt caching. **LLM gateways** for routing/failover/spend control: **LiteLLM** (open-source, self-hosted, OpenAI-compatible, supports Claude Code prompt-cache routing, zero markup); **Portkey** (enterprise observability, semantic caching, guardrails, ~8k stars); **OpenRouter** (300+ models, 5.5% credit fee, simplest); plus newer Anthropic-protocol-native gateways (Lynkr) and Vercel AI Gateway. Point Claude Code at a gateway via `ANTHROPIC_BASE_URL`. Enterprise cost tracking via OpenTelemetry export.

### 8. UI/UX Development
The core problem is **"AI slop"** — the generic Inter/Roboto font + purple-gradient-on-white + card-grid look. Anthropic's official **frontend-design skill** (`anthropics/skills`) is the flagship answer: it forces an aesthetic commitment (purpose/tone/constraints/differentiation) before any code, explicitly bans overused fonts (Inter, Roboto, Arial, system fonts, Space Grotesk), ranks accessibility highest (4.5:1 contrast, focus rings, ARIA, keyboard nav), and supports persistent design systems (`--design-system --persist` → design-system/MASTER.md + per-page overrides). It supports stacks: html-tailwind, react, nextjs, vue, svelte, shadcn, swiftui, react-native, flutter, jetpack-compose. Its instructions read like a creative director's brief ("Spend your boldness in one place… before leaving the house, take a look in the mirror and remove one accessory").

**Workflow tools:** **Figma MCP** / design-context-bridge (read actual components, colors, type scale — not screenshots); **shadcn/ui** + Builder.io; **v0** for design-to-code; Design.md/design-system markdown pattern (explicit hex, exact fonts, pixel spacing, negative rules). Platform stacks: frontend-design skill + Shopify AI Toolkit (Liquid/GraphQL validation, shipped April 9 2026) or WordPress.com MCP. Community: design-anti-slop skill, Patrick Ellis's Design Review Workflow (awesome-claude-code). Reddit reports "Super-IC" designers outputting 3-person-team volume; AI adoption among UX researchers hit 80% in 2025 (Loop11).

### 9. Testing
**Playwright MCP** (`npx @playwright/mcp@latest`, `claude mcp add playwright`) gives Claude live browser control so it generates tests from the real DOM/accessibility tree, not guessed selectors. **Playwright's three official agents** (planner→generator→healer, `npx playwright init-agents --loop=claude`) are just editable Claude Code subagents that explore the app, write specs (Markdown), generate tests aligned 1:1 with specs, and auto-repair failing tests. Best practice: **MCP for exploration/self-QA, CLI for repeated CI runs** (mixing them breaks caching); ground agents with an `app.context.md` + JSDoc + skills; run generated specs 3–5× in CI before trusting (treat CI as truth, local as draft); replace brittle selectors with getByRole/getByTestId.

**Patterns:** self-QA (Claude opens localhost, verifies its own changes); 4-agent pipeline (Exploration→Test Case→Automation→Maintenance with file-based handoffs + human checkpoint); TDD via Superpowers' RED-GREEN-REFACTOR skill (deletes code written before tests); coverage enforcement via Stop hooks (`npm test || exit 2`); GitHub Actions QA via anthropics/claude-code-action with Playwright MCP and scoped browser-only tools. **A caution flag:** the Playwright healer auto-applying fixes can silently hide real bugs when a test breaks due to a genuine behavior change.

### 10. Security
**Native controls:** default read-only permissions; allow/ask/deny rules (`permissions.deny: ["Read(./secrets/**)", "Bash(curl:*)", "WebFetch"]`); **sandboxing** (`/sandbox`, open-sourced by Anthropic) with filesystem + network isolation (macOS Seatbelt built-in; Linux/WSL2 needs bubblewrap + socat) — Anthropic's engineering post states "sandboxing safely reduces permission prompts by 84%"; write access confined to working dir; command-injection detection; trust verification for new codebases/MCP servers; isolated context for web fetch; **Claude Code on the web** runs each session in an isolated cloud VM with credentials outside the sandbox. Enterprise: managed settings (override all scopes), SAML/OIDC SSO, OpenTelemetry audit, MCP allowlists.

**The 2026 threat landscape is serious.** Disclosed issues: **CVE-2025-59536** (RCE via malicious hooks in project settings), **CVE-2025-59356** (hooks-based RCE), **CVE-2026-21852** (API-key harvesting via env override) — all Check Point; Oasis Security's "Claudy Day" (invisible prompt injection → exfiltration via Files API on a default claude.ai session); Mitiga's npm-post-install attack rewriting `~/.claude.json` to steal OAuth tokens (Anthropic ruled out-of-scope); "Sandworm_Mode" npm typosquatting of MCP servers; the March 31 2026 source leak. OWASP published a **Top 10 for Agentic Applications (2026)** ranking Agent Goal Hijacking (ASI01) #1. **Prompt injection is the top risk** — model-level detection alone is insufficient; sandboxing + network allowlists + infra-layer input filtering are needed.

**In-loop security tooling (SAST/SCA/secrets):** **Semgrep** (SAST, MCP + CLI, community rules catch 80–90% of GitHub Advanced Security findings on typical web apps); **Gitleaks** (~19k stars, secret scanning via pre-commit hook — the standard fix for agents committing credentials); **TruffleHog** (~18k stars, 700+ verified secret types); **Trivy** (dependency/IaC/container); **Snyk MCP**; **Aikido MCP**; **Endor Labs**; **42Crunch** (API security); OSV/dependency-audit hooks. Claude Code's own **`/security-review`** command and **Anthropic's Claude Code Security Review GitHub Action** analyze PR diffs. Curated hub: **efij/awesome-claude-code-security**. Per Snyk's ToxicSkills blog (Feb 2026), "13.4% of all skills, or 534 in total, all contain at least one critical-level security issue... 36.82% (1,467 skills) have at least one security flaw" — making vetting skills like dependencies mandatory; read SKILL.md + scripts before install, and there's a free AI-skill security scanner for SKILL.md/MCP configs. Governance-layer tools: MCP governance proxies (policy + human approval + hash-chain audit), credential-isolation proxies (TrueFoundry AI Gateway), per-server least-privilege credentials.

## Recommendations

**Stage 0 — Baseline setup (all teams, day 1):**
1. Add a lean CLAUDE.md (<200 lines) with build commands, conventions, "always/never" rules; enable Auto Memory.
2. Install core hooks: PostToolUse auto-format (prettier/eslint), PreToolUse blocks for `rm -rf`/`.env`/secrets, and a Gitleaks pre-commit hook.
3. Enable `/sandbox` (defense-in-depth) and set explicit permission allow/ask/deny rules.
4. Install ccusage (`npx ccusage`) and check `/usage` + `/context` regularly.

**Stage 1 — Add capability (week 1–2):**
5. Install 3–5 MCP servers max, scoped read-only: Context7 (docs), GitHub MCP, Playwright MCP, filesystem/memory, plus one database server. Pin versions; don't `npx -y latest` in production.
6. Install the official frontend-design skill for any UI work; add Figma MCP if you have designs.
7. Adopt a methodology framework — **Superpowers** for teams wanting enforced TDD/planning/subagent-driven dev; otherwise anthropics/skills + pr-review-toolkit.

**Stage 2 — Scale to a team (month 1+):**
8. Package your conventions into a **plugin** and host an internal git marketplace (kills version drift; new hires get the stack day one).
9. Route Claude Code through an **LLM gateway** (LiteLLM self-hosted for control, Portkey for enterprise observability) for spend caps, failover, and per-user attribution; export OpenTelemetry for FinOps.
10. Adopt Agent Teams / subagent fan-out for parallel work; use git worktrees for isolation; route subagents to Haiku/Sonnet by complexity.
11. Stand up an in-loop security pipeline: Semgrep + Gitleaks + Trivy + `/security-review` in CI (SARIF to GitHub Security tab), plus mandatory review of any third-party skill/plugin/MCP source before install.

**Thresholds that change the plan:** If per-developer cost exceeds ~$30/active-day consistently → tighten model tiering and context hygiene before adding capability. If you connect MCP servers touching production data/credentials → mandate sandboxing + network allowlists + a governance proxy. If skills/plugins come from outside your org → treat every one as an untrusted dependency (ToxicSkills: roughly 1 in 7 audited skills had a critical flaw). If memory/MEMORY.md exceeds 200 lines → move to Mem0/claude-mem/Hindsight.

## Caveats
- **Star counts and version numbers are point-in-time (mid-2026) and move weekly** — verify current figures before relying on them. Aggregator sites systematically lag GitHub's live numbers; Superpowers in particular is quoted anywhere from ~137K (Claude Bazaar, April 2026) to 215K+ across sources depending on scrape date, so the higher figures should be treated skeptically.
- **Registry server totals are inflated** by CI-republished duplicates (SafeDep: ~64.7M raw entries → ~1,691 unique packages); "20k servers" ≠ 20k distinct useful tools. Anthropic's own count is ">10,000 active public MCP servers" (Dec 2025).
- **Some 2026 model/product names in sources are unverifiable or speculative** (e.g., "Opus 4.8," "Claude Fable 5," "GPT-5.5" appear in vendor blog posts) and should not be treated as confirmed; I've avoided leaning on them.
- **Security findings evolve fast** — CVEs get patched and new attack chains appear; the specific incidents cited are illustrative of a class of risk, not a current-status list. Anthropic's "out of scope" ruling on the Mitiga npm attack means that particular chain may remain live.
- **Marketing vs. reality:** many "best tools" lists are SEO/affiliate content; I prioritized official Anthropic docs, primary GitHub repos, and named security research. Vendor benchmark claims (memory accuracy %, token-savings %) are self-reported.
- Multi-agent orchestration, Agent Teams, and sandboxing on Linux remain **experimental/beta** with real failure modes (context drift at 10+ agents, infinite Stop-hook loops, cold-start timeouts).
--- metadata ---
{
  "filename": "pasted-text-2026-07-05T16-38-56.txt",
  "content_type": "text/plain",
  "size_bytes": 24228
}