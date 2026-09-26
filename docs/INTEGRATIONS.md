# Integrations — what each tool actually gets

Forgekit emits configuration for ten coding tools, plus MCP configuration for Roo Code and VS Code.
"Supported" hides four different things, so this page lists them separately for every tool:

1. **Config emission** — forge writes the tool's native rules file (or relies on one the tool
   reads natively, such as `AGENTS.md`).
2. **MCP registration** — forge writes an MCP server entry for its own server (`forge-cortex`)
   where the tool can find it.
3. **Automatic hook execution** — forge code runs by itself at lifecycle points (session start,
   each prompt, before or after a tool call, when the agent stops), without the model choosing to
   call it.
4. **Enforcement** — some of that code can *block* an action, not just advise.

Each cell says how the claim is backed (as of 1.4.3, commit `d2abfa6`; checked 2026-09-26 against
`src/emit/*.js`, `src/sync.js`, `src/init.js`, `hooks/hooks.json` and the tests):

| Label | Meaning |
|---|---|
| **tested (emission)** | a `node:test` test asserts the file forge writes and its content. The tool itself is not launched, so whether it loads the file rests on its documentation. |
| **tested (execution)** | a test runs the code that executes on that path — for hooks, the guard script fed a synthetic hook payload — though not inside the real host. |
| **declared** | forge writes the file, or relies on documented tool behaviour, and no test exercises it (not execution-tested). |
| **not supported** | forge does nothing for this property on this tool. |

## The matrix

| Tool | Config emission | MCP registration | Automatic hooks | Enforcement (blocking) |
|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` importing `@AGENTS.md`, plus forge's block in `AGENTS.md` — tested (emission) | `.mcp.json` — tested (emission) | plugin `hooks/hooks.json` or `forge init`-merged `~/.claude/settings.json`: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop — tested (execution) for the guard scripts; manifests tested for wiring | yes — see [Claude Code enforcement](#claude-code-enforcement) — tested (execution) |
| **Codex** | root `AGENTS.md` (32 KiB cap checked by `forge sync`) — tested (emission) | `.codex/config.toml` `[mcp_servers.forge-cortex]` — tested (emission); the package's Codex bundle (`.codex-plugin/`) — declared | not supported | not supported in the agent (see [Any tool that commits through git](#any-tool-that-commits-through-git)) |
| **Cursor** | root `AGENTS.md`; warns when a legacy `.cursorrules` would shadow it — tested (emission) | `.cursor/mcp.json` — tested (emission) | not supported | not supported in the agent |
| **Gemini CLI** | `AGENTS.md` added to `.gemini/settings.json` `context.fileName` — tested (emission) | `.gemini/settings.json` `mcpServers` — tested (emission) | not supported | not supported in the agent |
| **Aider** | `.aider.conf.yml` with `read: AGENTS.md` — tested (emission) | not supported | not supported | not supported in the agent |
| **GitHub Copilot** | root `AGENTS.md`, read by the coding agent — tested (emission) | `.vscode/mcp.json` — tested (emission) | not supported | not supported in the agent |
| **Windsurf / Devin** | root `AGENTS.md`, with a warning past the tool's size caps — tested (emission) | not supported (the tool's MCP config is global-only) | not supported | not supported in the agent |
| **Zed** | root `AGENTS.md`; warns about earlier-precedence files that shadow it — tested (emission) | `.zed/settings.json` `context_servers` — tested (emission) | not supported | not supported in the agent |
| **Continue** | `.continue/rules/00-forge.md` — tested (emission) | `.continue/mcpServers/forge-cortex.yaml` — tested (emission) | not supported | not supported in the agent |
| **OpenClaw** | the execution folder's `AGENTS.md` as project context — tested (emission) | `.openclaw/mcp.json` fragment, **not auto-registered**: one `openclaw mcp add` command applies it — tested (emission and command); or install the package as a Codex bundle — declared | not supported (forge installs nothing into OpenClaw's hook system) | not supported in the agent |
| **Roo Code** | no rules file | `.roo/mcp.json` — tested (emission) | not supported | not supported |
| **VS Code** | no rules file | `.vscode/mcp.json` — tested (emission) | not supported | not supported |

`forge init` emits only for the tools a repository already uses (Claude Code plus any tool with a
sign on disk) unless `--tools` says otherwise, and records the choice for later `forge sync` runs.
Every target above is covered by the emission tests in `test/sync.test.js`, `test/mcp.test.js`,
`test/openclaw.test.js` and `test/init_tools.test.js`. None of the ten host tools is launched in CI,
so "the tool actually loads this file" is documentation-backed everywhere, including Claude Code.

### Claude Code enforcement

On Claude Code the guards run automatically, and four can stop or pause an action:

| Guard | Event | What it can do | Default |
|---|---|---|---|
| `protect-paths` | PreToolUse (writes, shell, reads) | deny a tool call on secrets, credential stores and destructive commands; fails closed when it cannot reach a verdict | on |
| `cost-budget` | PreToolUse | pause for the user (`permissionDecision: "ask"`) once the day's spend passes `FORGE_COST_CEILING` (default $10); it asks, and never blocks by itself | on |
| completion gate | Stop | block "done" once per session when code changed without test evidence or a doc/state record | on (`FORGE_STOPGATE=0` disables) |
| substrate gate | UserPromptSubmit / pre-edit | block a vacuous task or an edit into a very large dependent set | off unless `FORGE_ENFORCE=1` |

`doom-loop`, `secret-redact`, `format-on-edit`, `lean-guard` and the session learner are advisory:
they warn, redact output after the fact or record, and never block. Guards are defence in depth, not
a sandbox: a sufficiently creative shell command can bypass a regex guard. Tests run each guard with
synthetic payloads (`test/guards.test.js`, `test/protect_paths.test.js`, `test/stop_gate.test.js`,
`test/hook_launcher.test.js`), and `test/hook_manifests.test.js` checks that the plugin manifest and
the settings template wire the same guards.

### Any tool that commits through git

`forge harden` installs a git pre-commit hook (gitleaks when present, then `forge precommit`). It
runs at commit time whatever agent or person made the change: with `FORGE_COMMIT_GATE=block` it
refuses a commit whose staged code carries no doc or state change, and a detected secret blocks in
every mode. It is tested in `test/commit_gate.test.js` and `test/harden.test.js`. This is the only
enforcement forge offers outside Claude Code.

## Models and providers

Model availability and prices change faster than releases, so each needs a date and a source.

- **The tiered router** (`forge route`) maps a task to a tier and the tier to a model through the
  native provider adapters in `src/providers.js`: `anthropic` (Messages API), `openrouter` (the same
  Anthropic model ids as `anthropic/<id>`), `litellm` (tier aliases on a gateway you run), and
  `openai` and `gemini` (their OpenAI-compatible chat-completions endpoints, each with its own
  tier-to-model map). Tier prices come from `src/model_tiers.json`, verified 2026-09-22; `forge models`
  prints where each resolved id and price came from.
- **The universal router** (`forge route universal`) reads a separate registry, `data/models.json`:
  14 models from seven organisations. Only the seven Anthropic entries ship a provider id (for the
  `anthropic` provider); the other seven — DeepSeek, Google, Z-AI, OpenAI (two), Moonshot and
  MiniMax — are recommended by id but **cannot be applied** until you add a provider id for them in
  `.forge/models.json`. Registry presence is not operational availability, and a recommendation
  for a model you cannot call should be read as advice about the model, not a runnable route.
  Registry prices, where present, carry their source and the date checked (2026-09-22); the other
  models' costs come from the February 2026 benchmark runs behind the shipped prior. See
  [UNIVERSAL_ROUTING.md](UNIVERSAL_ROUTING.md).
