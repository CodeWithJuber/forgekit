# Development prompt profiles

ForgeKit ships the workflows from the supplied *Think Before You Code* guide as one master prompt, nine role briefs and sixteen situation-specific prompts. Every card includes the evidence the agent should return. These instructions guide the agent. Verification receipts and host controls establish which checks actually ran.

## Select a profile

Run these commands in the working tree where you want the profile. The choice lives under your private ForgeKit state directory and applies to that worktree and its subdirectories. Other users and linked worktrees make their own selection. Without a selection, the existing development workflow runs.

```sh
forge prompts list
forge prompts use engineering
forge prompts status
forge prompts show debugger
forge prompts show verification --json
forge prompts use off
```

The optional `quran` profile adds the supplied author's ethical framing to the same engineering guidance. The master card names fourteen concepts and distinguishes verse references from the author's conceptual applications. A code claim requires a file, experiment or test result. No translation or theological interpretation is required to use the engineering profile.

```sh
forge prompts use quran
forge prompts show master --profile quran
```

Previewing a card with `show` is read-only. Its plain text can be pasted into an agent's instruction settings or supplied as a worker brief. To create a separate file for an instruction-only host, choose a new path and run, for example, `forge prompts show master --profile engineering > forge-engineering-prompt.md`. Attach or reference that file from the host's project instructions. Existing team instructions continue to apply.

Supported session-start hooks add the selected master text. The normal prompt or failure-evidence path delivers a bounded reminder and up to two relevant situation prompts on recognized signals. Every profile is re-read from private state at delivery time. A host's compaction and hook capabilities determine when context is available again. The CLI and `forge_develop` MCP path also return profile guidance. The explicit specialist executor includes the matching role's instructions and expected evidence in worker input.

## Available situations

| Situation | Prompt ID | Evidence to inspect |
| --- | --- | --- |
| Claimed success | `verification` | Actual commands, counts and test changes |
| Resuming after compaction | `context-loss` | Standing rules, rejected options and current files |
| Cost overrun | `cost` | Estimate, observed usage and repeat calls |
| Destructive changes | `destructive-actions` | Resolved target, authorization and recoverable state |
| Untrusted tools or retrieved instructions | `injection` | Access, output destination and source identity |
| Unknown API or dependency | `invented-symbols` | Real declaration or versioned upstream documentation |
| Slow reviews | `review-burden` | Ordered risk areas, test evidence and open questions |
| Large codebase | `repo-scale` | Callers, contract, tests and deployment layout |
| Credential access | `secrets` | Scoped access and redacted audit |
| Changes to the agent | `evals` | Baseline and candidate results on the same tasks |
| Parallel workers | `multi-agent` | Independent work, budget, owner and verification |
| Configuration mismatch | `config-drift` | Effective working directory, versions and configuration |
| Old evidence | `freshness` | Capture time and matching code state |
| Unexplained decisions | `accountability` | Owner, alternatives, decision and outcome |
| Repo convention drift | `conventions` | Applicable instructions and mechanical checks |
| Learning from a task | `learning` | Raw observations, repeated patterns and evaluated guidance |

Use `forge prompts list` for the nine role IDs. For example, `forge prompts show researcher` gives a versioned-source and license checklist, and `forge prompts show reviewer` gives an independent verification brief. The roles are reusable briefs. Selecting a profile alone starts no worker.

## Verify test changes

`forge verify --base <ref> --json` compares the changed test surface with a known Git revision. The default comparison is HEAD. For committed work on a feature branch, choose the known pre-change commit or merge base. The report includes `testIntegrity`, the underlying suite outcomes and the signed verifier event. A recognized Node test summary contributes observed pass, fail, skip, cancellation and todo counts. Other runner formats leave those counts unavailable. A green suite with evidence of potentially weakened coverage yields `SUSPECT` and a nonzero exit. A current authenticated suspect receipt also triggers the existing one-time stop-hook review, even if the change touched a test. Use the file and reason to inspect or restore the missing coverage. An incomplete comparison is recorded separately. Detection covers recognizable test patterns and cannot determine semantic equivalence for arbitrary code.

The guide's spending estimates, speedup targets, external incident numbers, full tool-access audits and cross-host proof of compaction survival are outside the claims of these prompt cards. Evaluate agent outcomes with representative tasks in the host and operating environment you use.

## Use one agent, skill or hook

Use the catalog in the installed package to find an ID. Each entry includes its source. A hook lists the normalized event and tool or session matchers it accepts. A bound skill includes its JSON input schema. A brief can be read by a nontechnical planner or handed to any agent that accepts text.

```sh
forge agents list
forge agents run planner --task "Plan a two-week trial and name a measurable success condition"
forge skills list
forge skills show forge-impact --json
forge skills run forge-impact --input target.json --json
forge skills run forge-ledger --json
forge hooks show protect-paths --json
forge hooks invoke protect-paths --input event.json --json
```

For the impact command, put `{"target":"src/ledger.js"}` in `target.json`. The ledger binding reads stats and the verify binding runs project verification. Other playbooks produce their instructions as a handoff. Select an execution route explicitly when you want a worker.

```sh
forge agents run reviewer --task "Check the evidence for this change" --runner forge
forge agents run reviewer --task "Inspect affected APIs" --host codex --host-billing
forge agents install independent-reviewer --host claude
forge agents uninstall independent-reviewer --host claude
forge skills install forge-ledger --host codex
forge skills uninstall forge-ledger --host codex
forge hooks enable protect-paths --host claude
forge hooks disable protect-paths --host claude
```

The Forge runner uses the project's supervised reviewer profile. Select a configured route with `--route <id>`. The `codex` and `kimi` native runners receive the brief in a temporary directory and charge the selected host account. Include review evidence in the task text. Use the Forge runner when a reviewer needs the project read tools. Configuration and authentication are required to execute with that host. Installing a skill copies its bundled references and scripts. Choose `claude`, `codex`, `copilot`, `cursor`, `gemini`, `opencode` or `portable` for a project directory. Installation and removal check the recorded tree digest so edits and user-owned directories survive. Client-side discovery depends on the host version. The portable directory is `.agents/skills`.

A standalone hook receives a normalized envelope. For example, use `{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"README.md"}}` as `event.json`. Add `--input -` to read JSON from stdin. Invoking a named hook runs just that component. Use `forge hooks run <host> <event>` for the installed host's full guard chain.

In Claude Code, a packaged crew agent installs in the project's `.claude/agents/` directory. Portable roles such as `planner` produce a brief on demand. Enabling one hook registers it in `.claude/settings.local.json` on this machine. Removal checks ownership before editing the registration.

## Plan and research without an AI account

Run `forge demo workshop` from any directory. Add `--json` for the full machine-readable receipt. It requires Node.js, Git and Python 3. The example uses anonymous synthetic RSVP and capacity tables. A researcher counts demand, a planner checks available seats, and one coordinator owns the acceptance decision. Two scoped handoffs are prepared. The result is computed by local CLI commands without starting model workers.

For your own planning brief, give `forge team "<question>" --brief streams.json --handoff generic --json` each stream's concrete paths, acceptance check and optional prerequisite IDs. Name one owner to merge the findings. The `planner` and `researcher` roles work for non-code materials. A scoped worker receives its assigned references and bounded file excerpts. The lead can relay additional citations. Adding `--review` to a team command selects a single independent reviewer. [Worker breakdown and scheduling](DEVELOPMENT-GATES.md#decide-when-to-split-a-task)

In the example, morning has 12 RSVPs for 14 seats. Afternoon exceeds capacity by one. The printed result includes both alternatives, the acceptance condition, original row ranges, the Git revision and the reusable claim ID. Reuse only after confirming the source hashes still match. The example tests a changed source and an edited report as well as the successful reuse case. This fixture demonstrates the workflow. To measure outcomes on real participants and work, follow the consented 100-pair pilot. [Workshop walkthrough](../examples/workshop-planner/README.md) · [Paired pilot](../reports/cost-eval.md#run-the-paired-pilot-locally)
