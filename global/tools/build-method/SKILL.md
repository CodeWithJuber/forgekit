---
name: build-method
description: Build protocol for AI agents, apps and user interfaces — write the contract first, give each agent a narrow role and a clear definition of done, keep state outside the chat, gate destructive tools, design for ease and plain language, size modules to the real load, test the smallest cases and adversarial inputs, then ship and monitor. Use when designing or building an agent, a multi-agent workflow, a feature, a UI, or a system architecture.
---

# Build method

Six steps from idea to shipped. Small tasks need only the steps that apply; say which ones
you skipped and why.

## 1. Contract first

Write the agreement before the code: acceptance criteria, types, schemas, API contracts and
what "done" means. Agents and people both drift when the terms live only in a conversation.

- `forge preflight "<task>"` lists what the task names that the repository does not define.
- `forge spec lock` freezes a spec so drift shows up in review.
- Record consequential choices with `forge decide`.

## 2. Ease for the user

- Remove friction: every extra click, field or modal is a cost the user pays.
- Reveal gradually: simple defaults first, advanced controls only when needed.
- Speak the user's language: no internal jargon or raw stack traces in the interface, and
  every error message names the next step.
- Make the structure visible: clear hierarchy, readable contrast, obvious primary action,
  helpful empty states.
- No dark patterns: never hide cancellation, add surprise fees or collect data the user did
  not mean to give.

## 3. Architecture in proportion

- Size each module to the real load. Too thin breaks; too heavy slows everything. Ten users
  do not need a mesh of services.
- Keep components decoupled behind small interfaces, so one can change without the others.
- Plan for bad days from the start: rate limits, caching, fallbacks when a provider is down,
  backups and graceful degradation.
- Check before adding a dependency: `forge vet <ecosystem:name>`, and look for one already in
  the repository (`forge reuse query "<what>"`).

## 4. Agents with narrow mandates

| Concern | Rule |
| --- | --- |
| Role | One narrow purpose and an explicit definition of done per agent. |
| Cross-checking | Planner, builder and an independent reviewer instead of one large prompt. |
| Memory | Persist state in files or structured records, not in chat history. |
| Destructive tools | Deleting, dropping tables, payments and production changes wait for a human approval. |
| Grounding | Cite the file or source behind every claim; answer "insufficient context" instead of guessing. |
| Self-correction | Feed lint, compiler and test output back so the agent fixes its own work. |
| Monitoring | Heartbeats and timeouts for every running agent; notice when one goes missing. |
| Sub-agents | Gather and report, do not change state early. Verify a sub-agent's report with a deterministic check before acting on it. |
| Plain code first | Do clear, mechanical steps (a known form field, a pager, a cookie banner, a file rename) with plain code or a tool. Call the model only where the state is ambiguous, and give it a pruned view: the few candidates that matter, not the whole page or log. |
| Choosing | List the options, strike the ones that break a hard limit (harm, the contract, the evidence), then rank what is left by benefit, certainty and cost. |
| Confirming | After each action, check that the state changed. A no-op means choose another action; never repeat a dead one. |

ForgeKit supplies the gates: the harness runs supervised tasks with approvals and budgets
(`forge harness`), and `forge prompts show <role>` prints portable role briefs.

### Grounding and memory

Wrong answers and lost state are two sides of one flaw: fluent text taken for fact, and
everything poured into a context window that decays.

- **Abstain without evidence.** Every factual claim names its source (a file and line, a tool
  output). With no source, the answer is "missing context: <what>", and the orchestrator
  fetches it instead of the model guessing.
- **Hard truths outrank noisy input.** Types, schemas, API specs and business rules decide;
  chat text, scraped pages and partial logs are read against them, never the other way round.
- **Pass pointers, not retellings.** Sub-agents hand on `file#L42-L58` or a commit hash, so the
  next agent checks the original rather than a summary of a summary.
- **Keep state outside the chat.** A compact index stays in context; the full record lives in
  files and is looked up when needed (`forge brain`, `forge ledger query`, `forge handoff`).
- **Supersede, do not append.** When a decision changes, replace the active value and archive
  the old one with the reason (`forge decide`), so two versions never compete.
- **Check before saving.** A fact enters long-term memory only after a second, deterministic
  check finds it in the real output. In ForgeKit's ledger only tests, CI or a person raise a
  claim's confidence, so a guess cannot harden into a rule.
- **Re-pin the goal.** Put the goal and the locked constraints at the start and again at the
  end of a long context, where attention holds best.

## 5. Test under pressure

- Code that looks right means nothing until it is exercised: unit, integration, load, and
  evaluations for model output.
- Weigh the smallest cases: empty, zero, null, boundaries, off-by-one, time zones, leap
  days, Unicode and right-to-left text.
- Attack it before someone else does: prompt injection, SQL injection, XSS, runaway billing
  loops, oversized inputs.
- Let CI be the filter that removes flaky and bloated code before merge.
- `forge verify` binds the verdict to the exact tree; `forge uicheck` checks contrast and
  layout for UI work.

## 6. Ship and watch

Once it is tested, ship it; endless polishing stalls delivery. Then watch the logs and
metrics, and iterate from what they show. Record what you learned with `forge remember`.
