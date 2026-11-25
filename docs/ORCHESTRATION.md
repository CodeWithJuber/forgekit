# Agent orchestration

A lead coordinating multiple agents can use the shipped orchestration rule pack and a model authorization policy. `forge sync` writes enabled instructions to the host rule files. `forge route` ranks eligible provider deployments from verified outcomes. The global and project configuration can govern whether the profile’s top deployment is eligible. A project setting takes precedence.

## Why: one session, measured

A lead agent ran 7 coding sub-agents in parallel against one shared end-to-end (e2e) test
environment. In about 4.5 hours the session used about 857M tokens. About 98% of them were
cache re-reads, not new work.

What caused it:

- **Polling.** Agents waiting on a shared lock checked the logs about every 10 minutes, and
  each check re-read a 250–300k-token context. One agent ran 506 turns and wrote about 5k
  output tokens.
- **Too many agents for one resource.** Seven agents shared one e2e environment, so most of
  them queued, and queuing agents re-read their context.
- **The most expensive model for routine work.** Hand-picking the top tier for routine tasks
  cost about 140M tokens.
- **A heavy lead.** The lead's long context was re-read on every completion notification.

What fixed it: no polling (background runs plus completion notifications); parallelism capped
to what the shared resources can serve; the heavy e2e suite moved to CI on a self-hosted
runner, with only fast checks run locally; a fresh, small-context sub-agent per task; models
chosen explicitly for these historical runs. Current routing uses a provider-scoped workload comparison.

Quality gates stayed. A double-charge race in payment code was caught only because the lead
reviewed the money diff. That is why the pack keeps a risk-review rule, and why the routing
policy puts risky work on a stronger tier instead of a cheaper one.

## The rules

Source: [`source/orchestration.json`](../source/orchestration.json). Each emitted rule ends with
its id, for example `` `[orch.no-polling]` ``, so you know which id to switch.

| Id | Default | Rule | Why |
| --- | --- | --- | --- |
| `orch.no-polling` | on | Start long commands in the background and wait for the completion signal. No sleep or poll loops; read results with `tail`/`grep`. | Every poll re-reads the agent's whole context. |
| `orch.parallel-cap` | on (N = 2) | Run at most N agents in parallel, and never more than the scarcest shared resource (test env, ports, DB, CI runners) can serve. | Extra agents only wait, and waiting costs context re-reads. |
| `orch.ci-heavy-checks` | on | Full e2e and integration suites run in CI. Locally, only fast checks (typecheck, lint, unit tests of touched code) before pushing. | A heavy local suite serialises every agent behind it. |
| `orch.fresh-subagents` | on | One small task per fresh sub-agent; hand back a concise report (what changed, checks, open items), not a transcript. | A small context is cheap to re-read; a short report keeps the lead small too. |
| `orch.route-models` | on | Pick each agent's model with `forge route "<task>" --json`; never the top tier by default. | The top tier on routine work was ~140M tokens in one session. |
| `orch.risk-review` | on | Money, auth, secrets, migrations or security changes ship with tests in the same change and a lead review of the diff. UI-only tests may follow later. | The double-charge race was caught only by a lead's review. |
| `orch.isolated-env` | on | If local e2e is unavoidable, serialise it behind a lock or give each agent its own ports and database. | Shared state turns into flaky failures that look like real bugs. |
| `orch.lean-lead` | on | As lead, keep replies to notifications short; do not re-read large files or logs. | The lead's context is re-read on every notification. |

The rule text is generic: no tool or model names. Tool-specific wiring stays in the emitters.

### Where the rules land

The pack is part of the one canonical source, so it reaches every target the same way the other
rules do:

| Tool | How it gets the rules |
| --- | --- |
| Codex, Cursor, Copilot, Windsurf/Devin, Zed, OpenClaw | read `AGENTS.md` natively |
| **Kimi Code** | reads `AGENTS.md` natively (see below) |
| Claude Code | `CLAUDE.md` imports `@AGENTS.md` |
| Gemini CLI | `.gemini/settings.json` lists `AGENTS.md` in `context.fileName` |
| Aider | `.aider.conf.yml` has `read: AGENTS.md` |
| Continue | `.continue/rules/00-forge.md` carries the same text |

**Kimi Code.** Kimi reads project rules from the shared `AGENTS.md`. Select `kimi` during ForgeKit setup for trusted workspace MCP configuration in `.kimi-code/mcp.json`. The per-user plugin supplies automatic prompt hooks and exposes ForgeKit's skills. See [host setup](INTEGRATIONS.md) and [Kimi agent configuration](https://moonshotai.github.io/kimi-code/en/customization/agents).

## Turning rules on and off

```bash
forge orchestration                         # list rules, their state and where it came from
forge orchestration off orch.parallel-cap   # this repo only
forge orchestration on orch.parallel-cap
forge orchestration off all --global        # every repo on this machine
forge orchestration off pack                # the whole pack, this repo
forge orchestration set parallelCap 3
forge sync                                  # re-emit: switched-off rules leave AGENTS.md
```

Settings live in two files with the same shape:

- **project:** `.forge/forge.config.json` (the repo's existing config file)
- **global:** `forge.config.json` in Forgekit's per-user state directory: `$FORGE_HOME`, else
  `$XDG_STATE_HOME/forgekit`, else `~/.local/state/forgekit` (the same place as `recall`)

Precedence is key by key: pack defaults, then global, then project. `forge orchestration list`
shows which layer decided each value.

```json
{
  "orchestration": {
    "enabled": true,
    "rules": { "orch.no-polling": true, "orch.lean-lead": false },
    "parallelCap": 2
  },
  "route": { "topTier": "explicit" }
}
```

Notes:

- A **global** setting changes what `forge sync` writes on your machine. In a shared repo,
  set rules per project so the committed `AGENTS.md` is the same for everyone.
- The `minimal` profile leaves the pack out unless a config sets `orchestration.enabled: true`.
- `disableSections: ["orchestration"]` drops the pack like any other section.

## Model selection and worker scheduling

`forge models --refresh --json` inspects current provider listings. To compare measured deployments, run `forge route "Review the change" --provider NAME --workload review --json`. The result identifies the exact deployment where comparable evidence supports one. Missing outcomes leave the workload unrated. Earlier versions exposed unattended tier floors, keyword risk categories and model votes. Stored prompt-scoring settings are readable under `legacy` in `forge orchestration list --json`. Explicit review categories belong to the operator. Current model recommendations use measured outcomes.

A team brief declares dependencies and an operator-selected worker limit. Ready tasks can proceed independently. The scheduler uses verified prior durations to prioritize a critical path where available. The CLI and harness preserve each worker's evidence and permissions. [Team workflow](AGENT-EVIDENCE.md#when-to-use-multiple-agents)

The historical session measurement above describes that session's work. New speed or cost claims need a frozen paired evaluation and the operator's workload. [Evaluation protocol](../reports/cost-eval.md)
