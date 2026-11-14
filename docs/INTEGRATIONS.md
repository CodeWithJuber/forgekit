# Integrations — what each tool actually gets

Choose your coding hosts with `forge init --tools kimi,codex`. Each host receives its supported project instructions, MCP entries or hooks.
"Supported" hides four different things, so this page lists them separately for every tool:

1. **Config emission** — forge writes the tool's native rules file (or relies on one the tool
   reads natively, such as `AGENTS.md`).
2. **MCP registration** — forge writes an MCP server entry for its own server (`forge-cortex`)
   where the tool can find it.
3. **Automatic hook execution** — forge code runs by itself at lifecycle points (session start,
   each prompt, before or after a tool call, when the agent stops), without the model choosing to
   call it.
4. **Enforcement** — some of that code can *block* an action, not just advise.

The matrix covers emitted files and adapter behavior. The native checks below identify specific client versions and the actions observed in them.

| Label | Meaning |
|---|---|
| **tested (emission)** | a `node:test` test asserts the file forge writes and its content. The tool itself is not launched, so whether it loads the file rests on its documentation. |
| **tested (execution)** | a test runs the code that executes on that path — for hooks, the guard script fed a synthetic hook payload — though not inside the real host. |
| **declared** | forge writes the file, or relies on documented tool behaviour, and no test exercises it (not execution-tested). |
| **not supported** | forge does nothing for this property on this tool. |

## The matrix

| Tool | Config emission | MCP registration | Automatic hooks | Enforcement (blocking) |
|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` importing `@AGENTS.md`, plus forge's block in `AGENTS.md` — tested (emission); `advisorModel` in `.claude/settings.json` once `forge advisor set` names an advisor (the one key forge owns there) — tested (emission) | `.mcp.json` — tested (emission) | plugin `hooks/hooks.json` or `forge init`-merged `~/.claude/settings.json`: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop — tested (execution) for the guard scripts; manifests tested for wiring; project-level `.claude/settings.json` after `forge hooks on`, for machines with no user-level install (it stands down where one exists) — tested (emission and execution) | yes — see [Claude Code enforcement](#claude-code-enforcement) — tested (execution) |
| **Codex** | root `AGENTS.md` (32 KiB cap checked by `forge sync`) — tested (emission) | `.codex/config.toml` `[mcp_servers.forge-cortex]` — tested (emission); the Codex plugin manifest also points to the packaged MCP config (`forge` on PATH) | `.codex/hooks.json` after `forge hooks on`, or the plugin’s `hooks/codex.json` invoking bundled Node code. Both cover SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop. Native 0.169.0 project prompt hook delivered source evidence. Packaged command tested (execution) | yes with trusted local hooks — deny before a tool (Codex has no "ask", so an ask blocks and says so); `apply_patch` is checked file by file — tested (execution) for the adapter |
| **Cursor** | root `AGENTS.md`; warns when a legacy `.cursorrules` would shadow it — tested (emission) | `.cursor/mcp.json` — tested (emission) | `.cursor/hooks.json` after `forge hooks on`: sessionStart, beforeSubmitPrompt, beforeShellExecution, preToolUse, postToolUse, postToolUseFailure, stop — tested (emission); adapter tested (execution). Project hooks also run in Cursor cloud agents, which do not fire sessionStart — declared | yes after `forge hooks on` — deny and ask on shell commands, deny on other tools — tested (execution) for the adapter |
| **Gemini CLI** | `AGENTS.md` added to `.gemini/settings.json` `context.fileName` — tested (emission) | `.gemini/settings.json` `mcpServers` — tested (emission) | `.gemini/settings.json` `hooks` after `forge hooks on`: SessionStart, BeforeAgent, BeforeTool, AfterTool, AfterAgent — tested (emission); adapter tested (execution) | yes after `forge hooks on` — deny before a tool (no "ask": an ask blocks and says so) — tested (execution) for the adapter |
| **Aider** | `.aider.conf.yml` with `read: AGENTS.md` — tested (emission) | not supported | not supported | not supported in the agent |
| **GitHub Copilot** | root `AGENTS.md`, read by the coding agent — tested (emission) | `.vscode/mcp.json` — tested (emission) | `.github/hooks/forge.json` after `forge hooks on`: sessionStart, userPromptSubmitted, preToolUse, postToolUse, postToolUseFailure, agentStop, for the CLI and the cloud agent (which reads it from the default branch) — tested (emission); adapter tested (execution) | yes after `forge hooks on` — deny and ask before a tool (the cloud agent treats ask as deny) — tested (execution) for the adapter |
| **Windsurf / Devin** | root `AGENTS.md`, with a warning past the tool's size caps — tested (emission) | not supported (the tool's MCP config is global-only) | Devin (the CLI and the desktop app that was Windsurf) reads Claude Code's `.claude/settings.json`, so `forge hooks on` covers it with no file of its own — declared; the adapter's Devin rules are tested (execution). The older Cascade hook format (`.windsurf/hooks.json`) is not written | yes after `forge hooks on` — deny before a tool (no "ask") — tested (execution) for the adapter |
| **Zed** | root `AGENTS.md`; warns about earlier-precedence files that shadow it — tested (emission) | `.zed/settings.json` `context_servers` — tested (emission) | not supported | not supported in the agent |
| **Continue** | `.continue/rules/00-forge.md` — tested (emission) | `.continue/mcpServers/forge-cortex.yaml` — tested (emission) | not supported | not supported in the agent |
| **OpenClaw** | the execution folder's `AGENTS.md` as project context — tested (emission) | `.openclaw/mcp.json` fragment, **not auto-registered**: one `openclaw mcp add` command applies it — tested (emission and command); or install the package as a Codex bundle — declared | not supported (forge installs nothing into OpenClaw's hook system) | not supported in the agent |
| **Kimi Code** | Shared root `AGENTS.md` | Trusted workspace `.kimi-code/mcp.json` | Per-user ForgeKit plugin runs SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure and Stop. A real Kimi 2.6.2 prompt delivered indexed source evidence. | PreToolUse can deny; Stop and UserPromptSubmit can block. Kimi observes post-tool events asynchronously. |
| **Roo Code** | no rules file | `.roo/mcp.json` — tested (emission) | not supported | not supported |
| **VS Code** | no rules file | `.vscode/mcp.json` — tested (emission) | not supported | not supported |

Use `--tools` to choose the hosts that a repository needs. ForgeKit records that choice for
later `forge sync` runs. Project configuration tests cover the emitted files. The native
acceptance checks below describe which clients actually received context in a model request.

### Connect another coding host

In any host with local stdio MCP support, add a server named `forge-cortex` with command
`forge` and the single argument `cortex-mcp`. Start the server in the project directory,
or set its `FORGE_ROOT` environment variable to the absolute project path. An MCP client
can then list and call the tools. For a host that reads project instructions, use the
shared `AGENTS.md` or export the instructions with `forge prompts show master --profile engineering`.
Automatic context on every prompt requires a lifecycle callback that can deliver context
in that host. For projects using other hosts, the CLI also supports explicit retrieval
with `forge evidence "your task"`.

### Supervise a coding run

In a trusted checkout, run `forge harness init --hosts kimi,codex --supervised`. In Kimi, follow the printed plugin install command and run `/reload`. In local Codex, review the generated commands in `/hooks`. Configure a model route before starting a run. `forge harness drift --hosts kimi,codex` checks the project files. To verify activation in the client, submit a normal coding prompt and inspect the resulting tool call or hook trace. [Model setup and first verified run](HARNESS.md)

| Client | Evidence from the acceptance run |
| --- | --- |
| Kimi Code 2.6.2 | An ordinary prompt reached `forge_harness_run`. The run read the fixture, returned a signed test receipt and exposed matching status. The hook denied a subsequent direct native write. [Kimi run](https://github.com/CodeWithJuber/forgekit/actions/runs/43589328450/job/132430513107) |
| Codex CLI 0.169.0 | The first request contained the retrieved row, its locator and the routing instruction. The hook denied a direct shell write inside a writable sandbox. [Codex run](https://github.com/CodeWithJuber/forgekit/actions/runs/43589328444/job/132430512728) |
| Other stdio MCP clients | Register `forge cortex-mcp` in the project and invoke `forge_harness_run` and `forge_harness_status`. Automatic routing depends on the host's lifecycle callbacks. Actions outside those callbacks use the host's own permissions. |

For business systems, choose the source independently of the coding host. A scoped Jira project, Confluence space, GitLab project or local document folder can be synced once and queried by another configured client in the same workspace. Use a live record read when the current version matters. [Cloud and self-hosted source setup, local queries and refresh rules](AGENT-EVIDENCE.md)

### Claude Code enforcement

On Claude Code the guards run automatically, and five can stop or pause an action:

| Guard | Event | What it can do | Default |
|---|---|---|---|
| `protect-paths` | PreToolUse (writes, shell, reads) | deny a tool call on secrets, credential stores and destructive commands; fails closed when it cannot reach a verdict | on |
| `cost-budget` | PreToolUse | on every 100th tool call, checks `forge budget`: past the alert threshold it nudges with context; over budget it asks (soft, the default); with `--hard` it denies the call — an opt-in circuit breaker. Falls back to the historic `FORGE_COST_CEILING` check when `forge` is not on PATH | on |
| `dep-gate` | PreToolUse (shell, edits) | deny an install command or manifest edit that adds a package its own registry lacks or OSV lists as malicious; ask on a high risk score, or when Go, Maven or NuGet lacks the name (a private proxy is normal there); fails open when a registry cannot be reached | on (`FORGE_DEPGATE=0` disables) |
| completion gate | Stop | block "done" once per session when code changed without test evidence or a doc/state record | on (`FORGE_STOPGATE=0` disables) |
| substrate gate | UserPromptSubmit / pre-edit | block a vacuous task or an edit into a very large dependent set | off unless `FORGE_ENFORCE=1` |

`doom-loop`, `secret-redact`, `format-on-edit`, `lean-guard` and the session learner are advisory:
they warn, redact output after the fact or record, and never block. Guards are defence in depth, not
a sandbox: a sufficiently creative shell command can bypass a regex guard. Tests run each guard with
synthetic payloads (`test/guards.test.js`, `test/protect_paths.test.js`, `test/stop_gate.test.js`,
`test/depgate.test.js`, `test/depgate_generic.test.js`,
`test/hook_launcher.test.js`), and `test/hook_manifests.test.js` checks that the plugin manifest and
the settings template wire the same guards.

### Every agent with a hook system

`forge hooks on` writes project-level hook files, each holding one command per event:
`forge hooks run <host> <event>`. That command (`src/hosts.js`) translates the agent's payload
into the shape the guards read, runs the same guard chain Claude Code runs (`hooks/hooks.json`
is the single list), and answers in the agent's dialect. What is tested, and how:

- **tested (emission)** — `test/hosts.test.js` asserts each file's exact shape, that a
  person's own hooks and settings survive byte for byte, that a second run changes nothing, and
  that turning hooks off removes only forge's entries.
- **tested (execution), the adapter** — the same file feeds each agent's documented payload
  (tool names, field names, a JSON-text argument, a whole patch) through the adapter and checks
  the reply in that agent's dialect, including two end-to-end runs through the real guards.
- **Native client delivery** — the Codex workflow launches a pinned client. Isolated native
  Kimi and Claude sessions also exercised prompt delivery. The other adapter tests exercise
  host payloads and responses in ForgeKit.

After an Edit, Write or MultiEdit, ForgeKit checks the current workspace file for credential
patterns and merge-conflict markers. For JSON it parses the document. For explicit CommonJS
and ES modules (`.cjs`, `.mjs`) Node checks syntax without evaluating the file. The check
skips protected paths, symlinks, binary data and files larger than 128 KiB. The response
names tests found by filename convention as suggestions. A syntax success does not count as
a passing project suite. The existing Stop gate evaluates verification and session evidence.
Edits made entirely inside a shell command can bypass this post-edit callback.

The prompt hook runs evidence retrieval directly in Claude Code, local Codex, Gemini CLI and Kimi Code.
Cursor and Copilot command hooks use the first subsequent tool result that accepts context.
A tool-free turn on those hosts receives no injected evidence. The deferred query is redacted,
user-private and scoped to the workspace and session. The excerpt is retrieved at delivery.
Claude Code, Cursor and Copilot expose dedicated failure events. Codex and Gemini use tool
results with a recognizable failure signal. Adapter tests use synthetic payloads and a real
indexed document. Setup and cache details are in [Agent evidence](AGENT-EVIDENCE.md).

A manual native-host check on 14 November 2026 used Claude Code 2.1.325 with the ForgeKit
plugin, an empty test workspace and a separately indexed synthetic handbook. An ordinary
implementation request caused UserPromptSubmit to include the matching handbook text and
line locator in the first outgoing model request. In a second run the generic task had no
matching excerpt. A Bash tool emitted a synthetic importer error and exited 1. Claude's
PostToolUseFailure hook supplied the handbook excerpt in the next model request.
A third run wrote malformed JSON with the real Write tool. The next request contained the
post-edit parser result and the explicit test-execution status. A local mock received the requests.
The Codex CLI installed and enabled the bundle in an isolated configuration. In a separate
test on a hosted Ubuntu runner, a trusted project hook on Codex CLI 0.169.0 delivered a random
CSV value, the external filename and the row range in the first request to a loopback Responses
endpoint. The test ran with a read-only Codex sandbox and a fresh home directory. See the
[native Codex acceptance run](https://github.com/CodeWithJuber/forgekit/actions/runs/43584740300/job/132416709361).

For Kimi Code, run `forge init --tools kimi` from the repository to configure its project MCP server, then start Kimi in that directory and trust the workspace. Install the ForgeKit directory as a native user plugin with `/plugins install /absolute/path/to/forgekit`, then `/reload`. The directory must contain `kimi.plugin.json` and its packaged code. Kimi also accepts a GitHub URL pinned to a revision containing this manifest. The plugin is installed once per user. `forge hooks on --hosts kimi` displays the local install command and records this repo's selection. `forge hooks status` reads the Kimi install record. `forge hooks off` opts this repo out. To disable the plugin for all projects use `/plugins disable forgekit` followed by `/reload`. [Kimi plugins](https://moonshotai.github.io/kimi-code/en/customization/plugins) · [Hook events](https://moonshotai.github.io/kimi-code/en/customization/hooks) · [Workspace MCP](https://moonshotai.github.io/kimi-code/en/customization/mcp)

On 14 November 2026 an isolated Kimi Code 2.6.2 CLI loaded the packaged plugin, processed an ordinary user prompt and sent the matching synthetic handbook CSV row, its source path and row locator to a local OpenAI-compatible model fixture in the first request. Kimi runs the plugin command in the managed plugin directory and sends the workspace path in the hook payload. The adapter uses that workspace for retrieval. Kimi accepts prompt context in the `message` field. Outputs from post-tool event hooks do not inject evidence into the current turn. In the same test, the trusted workspace MCP client completed initialization and requested the ForgeKit tool list. Its asynchronous startup is independent of the prompt hook. A separately launched Kimi review worker received its task evidence in a temporary workspace. Its model request included the brief and advertised zero tools.

Local Codex requires hook trust. Review the plugin or project commands in `/hooks` after
installation or an update. Codex cloud orchestration does not execute these local commands.
A project hook uses the forge CLI on PATH. The Codex plugin hook uses its bundled copy and
requires Node on PATH. Cursor cloud agents need a writable environment and do not fire
sessionStart. Copilot cloud reads hooks from the default branch. See the vendor references
for [Codex](https://learn.chatgpt.com/docs/hooks), [Cursor](https://cursor.com/docs/hooks)
and [Copilot](https://docs.github.com/en/copilot/reference/hooks-reference).

An agent without a confirmation step turns a guard's ask into a block. The project commands use
a POSIX shell or the Codex and Copilot PowerShell entries. A missing forge CLI skips a project
hook unless bootstrap was enabled on a host with a supported startup event.

### Any tool that commits through git

`forge harden` installs a git pre-commit hook (gitleaks when present, then `forge precommit`). It
runs at commit time whatever agent or person made the change: with `FORGE_COMMIT_GATE=block` it
refuses a commit whose staged code carries no doc or state change, and a detected secret blocks in
every mode. It is tested in `test/commit_gate.test.js` and `test/harden.test.js`. This Git-level check also works for hosts without lifecycle hooks.

## Models and providers

Model availability and prices change faster than releases, so each needs a date and a source.

- **The tiered router** (`forge route`) maps a task to a tier and the tier to a model through the
  native provider adapters in `src/providers.js`: `anthropic` (Messages API), `openrouter` (the same
  Anthropic model ids as `anthropic/<id>`), `litellm` (tier aliases on a gateway you run), and
  `openai` and `gemini` (their OpenAI-compatible chat-completions endpoints, each with its own
  tier-to-model map). Tier prices come from `src/model_tiers.json`, verified 2026-11-03; `forge models`
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
