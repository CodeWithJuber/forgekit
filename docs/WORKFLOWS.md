# Native delivery workflows

ForgeKit runs a task through separate planning, coding, review and testing stages
using its existing supervised harness. Supply a task, size and acceptance criteria.
Every stage receives a fresh harness session and bounded excerpts of earlier reports.
Model routes, policy, per-run budgets and project spending ceilings still apply.

## Routes

- Small: `solo → summary`.
- Medium and large: `requirement → design → implement → review → test →
  knowledge → summary`.
- Requirement approval is mandatory before design. Final summary approval is
  mandatory before the workflow is marked delivered.
- Knowledge may report that no reusable lesson was found and record a skip reason.
- Review is a fresh, read-only run. Its rework decision stops progression.

Only `solo` and `implement` receive writable tools. The other stages are read-only
even if the selected policy profile permits writes. Each stage has its own P1
harness budget; the shared project spending ceilings apply across all stages.

## Setup

Use a Git worktree with Node 20+ and the Python installation described in the
[harness guide](HARNESS.md#start-with-your-coding-hosts). Initialize the harness
if this checkout does not already have one:

```sh
forge harness init --hosts generic
forge harness routes
```

Choose the hosts you actually use, configure a tool-capable model route, start
that server and review its trust fingerprint. Run `forge harness trust` after
editing the control files. See [route setup](HARNESS.md#select-and-verify-a-model-route).

Choose how code will be checked before starting:

- The default verifier reads a signed, passing `forge verify` receipt for the
  current checkout. Run `forge verify` yourself after changes. If a coding stage
  has already failed verification, refresh the receipt and explicitly retry
  that stage.
- For checks during each coding/test stage, bind an existing, reviewed
  [pinned container verifier](HARNESS.md#a-first-verifiable-run) with
  `forge harness verifier set container.json`. Its image must already contain
  the dependencies needed by its command.

## Run and approve

```sh
forge workflow create "Fix the retry bug" --size medium --accept "Retry tests pass"
forge workflow status WORKFLOW_ID
forge workflow run WORKFLOW_ID
forge workflow approve WORKFLOW_ID --stage requirement --digest REPORT_DIGEST
forge workflow run WORKFLOW_ID
forge workflow approve WORKFLOW_ID --stage summary --digest SUMMARY_DIGEST
```

Replace `WORKFLOW_ID` with the UUID returned by `create`. At an approval gate,
read the pending stage's latest `attempts` entry, inspect its `artifact` JSON
and verification evidence, then supply its `digest`. This is the report's
canonical JSON digest, not the hash of its pretty-printed file.

`create` records work without calling a model. Size defaults to `medium`.
Repeat `--accept` for additional criteria (1–16 are required).
All commands return JSON; `--json` is also accepted.

| Status | Meaning |
| --- | --- |
| `ready` | Ready for `run`, including after a requirement approval or retry. |
| `running` | A writer owns the workflow, or a process left an unfinished checkpoint. |
| `approval_pending` | Inspect and approve the requirement or final summary. |
| `blocked` | Inspect `reason` and the stage attempt before resuming or retrying. |
| `done` | The operator accepted the final summary for the verified checkout. |

`run` proceeds sequentially until a gate or blocker. Repeating it does not rerun
completed or blocked work. `run` and `resume` exit with status 1 when blocked;
an approval gate is a normal stop with status 0. `status` only reads state.

## Reports and verification

The stage returns a JSON object, without Markdown fences or extra fields:

```json
{
  "summary": "Review findings",
  "details": "The retry condition needs an explicit upper bound.",
  "evidence": ["src/retry.js: inspect the loop condition"],
  "blockers": ["The implementation has no retry limit."],
  "decision": "rework"
}
```

Reports are limited to 14,000 UTF-8 bytes. The summary allows 1,000 characters,
details 6,000, evidence up to eight entries of 800 characters, and blockers up to
eight entries of 500 characters. Nonempty strings are required; evidence and
blocker arrays may be empty. Secret-shaped text is refused.

Use `proceed` for an unblocked stage, `rework` for findings needing correction,
or `skip` only for knowledge, with the reason in `details`. Any blocker stops
progression regardless of the decision. Knowledge reports remain artifacts
for the operator to review and incorporate into project documentation.

| Evidence scope | What it establishes |
| --- | --- |
| `workflow-report` | The requirement, design, review, knowledge or summary report has the required structure. Its factual claims remain unverified. |
| `project-suites` | Solo, implementation or test has an authenticated passing suite receipt for the checked code. |
| `isolated-command` | The configured isolated verifier passed for its captured checkout. |
| `file-assertions` | An operator-supplied, run-bound assertion contract passed through the harness API. Shared workflow CLI verification uses receipts or the configured container. |

Coding/test evidence records the checkout at verification time. Recovered results
cannot bind that evidence to later edits. Retrying only summary cannot substitute
for rechecking changed code. No model-provided test command is executed.

Human acceptance of the final summary is separate from both structural report
validation and project verification. CLI output distinguishes these outcomes.

## Recovery and rework

```sh
forge workflow status WORKFLOW_ID
forge harness show STAGE_RUN_ID
forge harness replay STAGE_RUN_ID
forge workflow resume WORKFLOW_ID
```

`resume` keeps the original stage run ID, request and consumed budget. It can
continue after a cancelled run or granted tool approval. Use
`forge harness approvals list` and `forge harness approvals grant APPROVAL_ID`
for a tool approval; this is separate from approving a workflow report.
Direct `harness resume` also retains a saved workflow stage's tool restrictions.

After a process crash, `forge harness recover STAGE_RUN_ID` inspects its saved
checkpoint. An uncertain provider/tool/verifier effect is not replayed. Reconcile
it before retrying. If the workflow saved an ID before the harness created its
first checkpoint, `workflow resume` starts that exact request with the same ID.

For review findings, a failed verifier, changed code, or revised requirements:

```sh
forge workflow retry WORKFLOW_ID --from implement --reason "Address the review findings"
forge workflow run WORKFLOW_ID
```

Retry starts a new attempt and resets the selected stage and all downstream
stages. Earlier attempts, reports and approval records remain in history;
bounded excerpts of earlier failures and review findings accompany rework, and
downstream approvals must be obtained again. Use `solo` for a small workflow,
or `requirement` when the requirements need another approval. Each stage permits
at most three attempts. A retry of a downstream stage retains earlier approved
requirements; changing the task or acceptance criteria requires a new workflow.

## Private state and implementation

Status includes the workflow directory, report paths, run IDs, usage and evidence.
State lives under ForgeKit's per-user state directory in
`workflows/<worktree-hash>/<workflow-id>/`. `FORGE_HOME`, when set, must be outside
the checkout. A single writer lease protects each workflow; different worktrees
have separate namespaces. Report digests and checkout fingerprints bind approvals.
Private-state validation detects inconsistent records; filesystem access to the
operator's private directory remains a trusted boundary.

The coordinator in `src/workflow.js` calls `runProjectHarness`. Contracts and
report verification live in `src/workflow_contract.js`; persistence reuses the
harness lease in `src/workflow_store.js`. The CLI adapter is
`src/cli/workflow.js`. The implementation uses Node built-ins and adds no runtime
dependencies. Workflows do not commit, publish or deploy changes.

Run the deterministic contract and real CLI/runtime fixtures from the ForgeKit
source checkout:

```sh
node --test --import ./test/_setup.js test/workflow.test.js test/workflow_runtime.test.js
```

The runtime fixture uses a localhost model server and real signed project-suite
receipts. It covers process recovery, tool approvals, read-only enforcement and
both report approval gates. It does not require a live Ollama model.

## Attribution

The staged delivery model is inspired by
[Tencent/LoopForge](https://github.com/Tencent/LoopForge), particularly its
[Portable DevFlow workflow](https://github.com/Tencent/LoopForge/tree/dd56585276d8ecb6e0d6865f55e255194d75f85a/local/skills/devflow):
size-based routes, separate implementation/review/testing roles, explicit
requirement confirmation, resumable state, evidence artifacts and knowledge
capture. The reviewed upstream revision is
[`dd56585`](https://github.com/Tencent/LoopForge/commit/dd56585276d8ecb6e0d6865f55e255194d75f85a).

LoopForge is copyright (C) 2026 Tencent and licensed under
[MIT](https://github.com/Tencent/LoopForge/blob/dd56585276d8ecb6e0d6865f55e255194d75f85a/LICENSE). Its attribution also
credits [obra/superpowers](https://github.com/obra/superpowers), copyright (c) 2025
Jesse Vincent. This feature is an independent ForgeKit implementation on ForgeKit's
harness; it does not bundle LoopForge's code or imply Tencent endorsement.
