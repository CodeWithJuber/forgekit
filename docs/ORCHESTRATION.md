# Agent orchestration

When one lead agent runs several coding sub-agents, most of the cost is not new work. It is
each agent re-reading its own context while it waits. Forgekit ships two things for this:

1. **An orchestration rule pack**: eight short rules with stable ids. `forge sync` writes them
   into `AGENTS.md`, and from there into every tool Forgekit configures.
2. **A routing policy for unattended agents**: `forge route --mode unattended` adds floors and
   gates on top of the normal model-tier recommendation.

Both are on/off per person (user-level config) and per repo (project config), and the repo wins.

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
picked with `forge route`, with Jev and a risk floor; the top tier only on explicit opt-in.

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

**Kimi Code.** Kimi Code CLI reads `AGENTS.md` without any extra file. Its documentation lists
the system-prompt variable `${KIMI_AGENTS_MD}` as the "merged `AGENTS.md` content from project
root to working directory (including `.kimi/AGENTS.md`)"
([kimi-cli docs, customization/agents.md](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/agents.md),
checked 2026-10). So Forgekit adds `kimi` as a target that relies on `AGENTS.md`. It writes no
`.kimi/AGENTS.md` copy, because Kimi would merge it in a second time. It also writes no Kimi MCP
config and no hooks, because a repo-local path for those was not verified.

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
  "route": { "mode": "unattended", "topTier": "explicit" }
}
```

Notes:

- A **global** setting changes what `forge sync` writes on your machine. In a shared repo,
  set rules per project so the committed `AGENTS.md` is the same for everyone.
- The `minimal` profile leaves the pack out unless a config sets `orchestration.enabled: true`.
- `disableSections: ["orchestration"]` drops the pack like any other section.

## Routing for unattended agents

`forge route` picks the cheapest capable tier. By default it is **conservative**: a model's
vote for a higher tier is never applied (whitepaper §5.1), because a person watching the run
can retry cheaply on a stronger tier after a check fails. An agent nobody watches has no cheap
retry loop. A weak first attempt burns a whole run. So `--mode unattended` (or
`route.mode: "unattended"` in config) adds four steps:

1. **Vote raise.** If the optional proposer (Jev) votes `premium` with probability at or above
   `raiseConfidence` (default 0.9), the tier is raised to the premium tier. A `mid` or higher
   vote at or above `midConfidence` (default 0.5) raises it to at least mid. A vote with no
   probability (the text proposer) never raises.
2. **Writes-code floor.** A task that writes code starts at mid. Pass `--read-only` for
   exploration, which may stay on the cheapest tier.
3. **Risk floor.** A task that names money/payments, auth/identity, secrets/keys, data
   migrations or security is never below the premium tier. Keywords match whole words and
   phrases; the default lists are in `source/orchestration.json`.
4. **Top-tier gate** (`route.topTier`). `explicit` (default): the top tier only with
   `--allow-top` **and** Forgekit's own deterministic score at its top cutoff. `never`: never.
   `auto`: whenever the deterministic score reaches it. A vote or a floor never reaches the top
   tier; they stop one below it.

Conservative mode stays exactly as it was: none of the four steps runs, and existing output is
unchanged. A `route.mode` set in config applies wherever Forgekit routes, so `forge substrate`
and the `substrate_check` MCP tool report the same tier as `forge route`; `--mode` overrides it
for one call.

```bash
forge route "add a refund endpoint" --mode unattended --json
forge route "map the auth module" --mode unattended --read-only
forge route "<task>" --mode unattended --allow-top
forge orchestration set route.mode unattended          # make it the default for this repo
forge orchestration set route.topTier never --global
```

### Reading the result

`--json` gives a lead agent what it needs to pick a model in its own tool:

- `key`: the generic tier key: `haiku`, `sonnet`, `opus` or `fable` (cheap → top). Map it to
  your tool's model names; the rules never name vendor model ids.
- `policy.mode`, `policy.base` (the tier before the policy), `policy.steps` (each step that
  moved the tier, with `from`, `to` and a reason), `policy.risk` (matched categories and
  keywords), `policy.writesCode`, and `policy.topTier` (`gate`, `allowTop`, `allowed`).
- `provenance.path` is `llm-raised` when a vote raised the tier, as well as the existing
  values (`deterministic`, `llm-agreed`, `llm-lowered`, `llm-raise-deferred`, `llm-overruled`).

### Settings

| Key | Default | Values |
| --- | --- | --- |
| `route.mode` | `conservative` | `conservative`, `unattended` |
| `route.topTier` | `explicit` | `never`, `explicit`, `auto` |
| `route.raiseConfidence` | 0.9 | 0–1 |
| `route.midConfidence` | 0.5 | 0–1 |
| `route.writesCodeFloor` | on | on, off |
| `route.riskFloor` | on | on, off |
| `route.riskCategories` | money, auth, secrets, migrations, security | edit in the config file: a named category replaces its keyword list, `false` or `[]` turns it off, a new name adds a category |

### Jev stays optional

Without `FORGE_LLM=1` and `TYPESAFE_API_KEY`, there is no vote, and everything above runs on
the deterministic score: the floors and the gate still apply. Jev never receives a task that
looks like it holds a secret (the existing `hasSecret` redaction check). `forge route` meters
each decision as it always has: one line in `.forge/metrics.jsonl` with the tier and a short
task hash, never the task text. An unattended decision also records `mode` and the names of
the policy steps that moved it.

## Limits

- The rules are instructions. An agent can ignore them. Only Claude Code has hooks that
  enforce anything, and none of these rules is a hook.
- The risk floor is a keyword match. It can miss a risky task worded differently, and it can
  flag a harmless one ("session" in a UI task). Add or remove keywords per repo.
- The evidence above is one session. It shows where the tokens went in that session; it is not
  a benchmark of these rules.
