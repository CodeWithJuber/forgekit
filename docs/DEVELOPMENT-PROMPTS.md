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
