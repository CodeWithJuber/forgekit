# Memory storage and recovery

## Learning from corrections

A captured recovery starts with a command’s nonzero exit code. A later success of the identical command completes it. Cortex records the intervening target files. A file that received multiple edits supplies a second observable source. Commands whose text needed secret redaction are ineligible. A different successful command, wording in a prompt, or edits alone cannot establish a correction. The result reports the distinct signals and their sources. An explicitly recorded human correction can also propose a lesson.

The first supported episode produces a private proposal. Session captures and pending lessons are isolated by checkout under `cortex-session-events-v2` and `cortex-corrections-v2` in the operating system user’s ForgeKit state directory. Neither is included in cloud workspace exports, shared memory, generated host instructions or MCP lookup. The handoff command can still carry recorded assumption markers. Historical checkout session logs remain readable for assumptions and cannot establish new corrections.

Inspect the proposed wording, locations and episode count, then confirm the lesson you want to share.

```sh
forge cortex review --json
forge cortex confirm LESSON_ID
forge cortex why path/to/file
```

An independent second recovery on the same file and command can publish the original observation. The operator can publish sooner by confirming the proposal. If an opt-in distiller changes its meaning, the revised wording stays private until operator confirmation. This also applies if the original observation was published while the distiller ran. A reviewed replacement retains the prior claim as its parent and starts with its own approval receipt. ForgeKit reports the episode and independent confirmations separately. Showing a lesson to an agent adds no confirmation.

A recovery receipt binds the target file to the host’s failed and successful tool action IDs. If either ID is unavailable, one session can support at most one recovery for that file and command. Replaying a receipt on a different day adds no evidence. When a host supplies neither action IDs nor session identity, repeating the anonymous trace has the same limitation. A session’s temporary private event log is cleared at Stop. Stale captures follow the existing session pruning window.

A v2 correction imported from a teammate, or recorded before authenticated receipts were available, starts as a candidate in this checkout. Inspect the exact wording and trigger with `forge ledger show FULL_CLAIM_HASH`, then run `forge cortex confirm FULL_CLAIM_HASH` to approve it here. Each receipt binds the checkout, claim content, lesson ID, outcome, source and date using the installation’s private evidence key. Copying a receipt to another checkout or revision gives it no voting weight there. Two independently observed local recoveries can also corroborate the same original proposal.

For newly published lessons, the number of distinct confirming receipts must exceed opposing receipts for the lesson to be active. A tie with at least one contradiction places it in quarantine. A successful Git revert counts against a lesson only when the reported Git commit reverses the matching file blobs and the checkout observed the reverted version in a correction episode. Cortex resolves OS aliases for the checkout and rejects linked targets inside it. It compares exact file bytes and can also match an LF Git blob to a CRLF worktree when Git identifies the file as text and its built-in conversion applies. Custom filters, identifier expansion and working-tree encodings receive only the raw byte comparison. Files larger than 1 MiB and unobserved versions have no automatic reversal attribution. A retracted lesson stays retired. Historical lesson claims retain their version’s original scoring and lifecycle.

## Evidence for the decay default

A time-ordered evaluation compared the 45-day half-life with no decay on 1,276 public ForgeKit CI outcomes. The default helped on long-lived checks. On short pull requests the paired interval included zero. The evaluation keeps the current setting and gives the sparse-history, retention and authority limits. [Results and reproduction](../reports/ledger-decay-holdout.md)

## Organization access on one installation

ForgeKit stores the harness memory database under the operating system user's private state directory. The checkout’s canonical path identifies its repository scope. An operator can authorize individual checkouts to read or publish to a named organization on the same installation. Organization names are case-insensitive.

In the checkout that owns a verified claim, run the following commands.

```sh
forge harness memory org-grant platform write
forge harness memory org-grants
forge harness memory share CLAIM_ID organization --organization platform
```

In a second checkout, grant read access and select the organization for the query.

```sh
forge harness memory org-grant platform read
forge harness memory recall "deployment window" --organization platform
forge harness memory history SHARED_ITEM_ID --organization platform
forge harness memory org-revoke platform
```

A write grant includes read access. Changing a grant to `read` immediately removes permission to publish. Revocation takes effect on the next database transaction, including for callers with an existing store handle. Read permission requires both a current grant and an explicitly selected organization. Recall first searches the checkout's eligible facts. When these have no matches, it searches the selected shared scopes.

The publisher chooses each active L3 item to share. Publication copies the verified assertion and its evidence reference. The source checkout retains the underlying receipt. If the source evidence is contradicted, previously shared copies are flagged for review. Personal and team memory have separate namespaces. The MCP tool registry exposes no organization grant or share operation. Cloud workspace exports contain that workspace's records and exclude organization grants and shared copies. A user with full shell access to private state already controls the local account. These grants implement local checkout sharing. Cross-device identity and directory federation require a separate authority.

## Upgrading older lessons and recall files

Portable repository facts and Cortex lessons use the content-addressed ledger at `.forge/ledger`. Personal recall uses the ledger inside the user's private recall directory. `MEMORY.md` and `AGENTS.brain.md` are derived indexes. Source files from early versions may still contain lessons or facts missing from the ledger.

```sh
forge ledger migrate --json
forge ledger migrate --personal --json
```

The first command captures `.forge/lessons/*.md` and `.forge/brain/facts/*.md`. The second captures `facts/*.md` in the private recall store. Historical `episodes.jsonl` files remain available for inspection. New Cortex captures and provisional observations live in private checkout-scoped user state. `forge ledger import` invokes the same migration. The former `FORGE_LEDGER_ONLY` setting has no effect on live reads or writes.

Each result includes the snapshot ID, source file count, imported lesson, fact and outcome counts, number of previously tracked entries retained, and verification result. A SHA-256 digest covers the paths and exact source bytes, including line endings. Backups and migration receipts reside outside the checkout under `ledger-migrations-v1` in private user state. Treat this directory as part of a device backup.

An existing ledger fact or lesson with the same logical name takes precedence. When several files in one snapshot introduce the same logical name, the first in sorted source order is imported. Later files count as retained and can be restored from the private snapshot. Archived and retracted claims retain their disposition. For a new historical lesson the importer carries its episode references, expands confirmation counts at the last confirmation day and contradiction counts at the creation day, and records a historical retirement. Earlier file formats retained aggregate counts instead of per-event dates. Repeating a completed migration adds no evidence. An interrupted import can fill in missing records from its original bytes. Concurrent migration commands serialize on the selected scope. If an interrupted process leaves a lock, the command reports its path. Check that the recorded process has exited before removing that specific lock.

The importer rejects malformed lessons, credential-shaped content, linked source files, oversize records and unsafe paths. Its input limits are 1 MiB per file, 32 MiB of source bytes per snapshot, 10,000 files and 10,000 historical outcomes. Correct the reported source and retry. Changing eligible source bytes produces a new snapshot ID. The original files remain available for inspection.

## Restoring original files

Run from the checkout that made the backup. Personal backups are accessible across checkouts under the same private installation.

```sh
forge ledger restore-legacy ../restored-forgekit
forge ledger restore-legacy ../earlier-copy --snapshot SNAPSHOT_ID
forge ledger restore-legacy ../restored-recall --personal
```

Choose a new destination directory under an existing parent. Restore verifies the manifest before writing, then checks each output digest against the saved source. The restored tree preserves the original paths and bytes. It contains historical files as of the selected migration. Recent ledger-only activity is available through the ledger's export and synchronization commands.

## Ranking ledger queries

The CLI, MCP, dashboard search and similar-task lookup rank live claims with `empirical-midranks-v2`. `forge ledger query "payments" --json` reports the ranking version and similarity backend. Inputs are query similarity, overlap with recorded scope names, recency of a confirmation or mint, and the ledger's evidence-based validity. ForgeKit uses one similarity backend per query.

For each input that varies across the candidates, its percentile equals the number of lower values plus half the number of equal values, divided by the candidate count. ForgeKit averages these percentiles and multiplies by the larger of text similarity and scope overlap. When all inputs tie, the measured match alone sets the score. Exact ties use the content address. Four sorts cost O(n log n) after measuring the candidates. The score is specific to the query's candidate set. `retrieve` accepts `ranking: "eq3-v1"` for reproducing older numerical results.

Harness recall ranks its local FTS5 and evidence graph candidates separately. It averages tie-aware percentiles for BM25 relevance, the number of connected lexical matches, recorded verification level, timestamp, and the posterior success rate of completed uses. For `p` passed checks in `n` completed uses, the estimated rate is `(p+1)/(n+2)`, the posterior mean under a uniform beta prior. `observedOutcomes` reports the actual passed and failed counts. Earlier SQLite files can reconstruct these counts from the same recorded use edges and receipts.
