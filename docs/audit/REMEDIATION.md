# Audit remediation record

A concise record of the honesty / wording audit and what was addressed in this change.
Status legend: **Done** (shipped here) · **Deferred** (tracked, out of scope for this pass).

## Wording & terminology (this change — Done)

| #    | Item                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                               | Status |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| S-01 | Skill scanner printed a certification-style "ok to install" verdict, and a HIGH-severity finding read as safe | `src/skillgate.js` now returns `verdict` (honest: "No critical signature detected — this is NOT a safety certification…"), a `high` flag, and a `safe` boolean that is false when critical **or** high findings exist. External scanner stays opt-in with no new network calls. Tests added in `test/skillgate.test.js`. | Done   |
| T-01 | `P(defect)` label implies a measured probability                                                              | `src/consensus.js` comments/JSDoc reframe the `p` key as a **defect risk score (heuristic)**; docs (`docs/GUIDE.md`) qualify every mention. Internal key `p` kept (read by `src/cli.js` + metrics + tests).                                                                                                              | Done   |
| T-02 | `residual` label implies a proof-grade bound                                                                  | Reframed as the **remaining unchecked-weight bound** in `src/consensus.js` comments and `docs/GUIDE.md`. Internal key `residual` kept for the same readers.                                                                                                                                                              | Done   |
| T-03 | Preflight "probability that the task is sufficiently specified"                                               | `src/preflight.js` JSDoc/comments now call it a **specification completeness heuristic score** — explicitly not a probability. Numeric value unchanged.                                                                                                                                                                  | Done   |
| D-01 | "proof-carrying memory" overclaims a formal proof                                                             | README, `mintlify/introduction.mdx`, and `mintlify/concepts/proof-carrying-memory.mdx` reframe it as **evidence-referenced, content-addressed memory** (the "proof" is an evidence trail, not a machine-checked proof; no theorem prover in the loop). Term kept as a named concept.                                     | Done   |
| D-02 | "zero-config" overclaims zero-touch setup                                                                     | README status block, ROADMAP, `docs/GUIDE.md`, and `mintlify/guides/zero-config-onboarding.mdx` reworded to **guided / low-configuration onboarding**. Page slug kept to avoid breaking links.                                                                                                                           | Done   |
| D-03 | Benchmark numbers not always scoped                                                                           | README numbers now carry sample size/scope in-sentence (blast-radius recall n=6 on one JS repo; 118 ms median on this repo, warm; the 62.1% figure remains attributed to the white paper's prototype, not this repo).                                                                                                    | Done   |
| D-04 | Claude-first maturity not stated prominently                                                                  | README status block and `mintlify/introduction.mdx` state Claude Code is the deepest-tested integration; other tools have had less real-world exercise.                                                                                                                                                                  | Done   |
| D-05 | Formal-proof vs empirical claims blurred; heuristic impact not flagged                                        | Impact/blast-radius labelled **[Heuristic]** (regex-approximate, conservative, not a sound call graph) in README; formal statements kept separate from measured ones.                                                                                                                                                    | Done   |
| D-06 | Qur'anic framing could read as technical authority                                                            | `_mizan_` in `docs/GUIDE.md` and `src/consensus.js` now explicitly labelled a **philosophical/ethical framing**, not a technical guarantee.                                                                                                                                                                              | Done   |
| D-07 | Some integrations silently assume shell tooling                                                               | README status block notes several paths need **Bash, Git, and (a few) `jq`**.                                                                                                                                                                                                                                            | Done   |
| D-08 | Feature status labels inconsistent                                                                            | Introduced **Implemented / Heuristic / Formally-modelled / Experimental / Planned** labels where feature descriptions were touched (README "What you get").                                                                                                                                                              | Done   |

## Note on CLI display strings (handoff)

The rendered labels `P(defect):`, `residual:`, and the scanner's `ok to install` line are
printed in `src/cli.js`, which is owned by a parallel workstream and was **not** edited here.
The honest source-of-truth values now exist on the returned objects (`skillgate.scan().verdict`
/ `.safe`; consensus `p` / `residual` documented as heuristic). Wiring `src/cli.js` to render
`r.verdict` and relabel `P(defect)` → "defect risk score (heuristic)" / `residual` →
"remaining unchecked weight" is a one-line follow-up for that workstream.

## Deferred (tracked, not in this pass)

- **External multi-language benchmark** — impact/recall numbers remain n=6 on one JavaScript
  repo; a cross-language, multi-repo benchmark is deferred.
- **Multi-OS runtime certification** — behaviour is exercised on Linux/macOS shells; a
  formal multi-OS (incl. Windows) certification matrix is deferred.
- **Monorepo package split** — splitting the single package into separately versioned
  packages is deferred.
