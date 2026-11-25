# Choose a workshop time

A workshop coordinator needs a slot that can accommodate every RSVP. Run `forge demo workshop` from any directory. Add `--json` for the evidence receipt, or run `node examples/workshop-planner/demo.mjs` from a checkout. The supplied CSVs contain anonymous, synthetic headcounts and room capacities. One researcher checks demand, one planner checks capacity and the coordinator makes the decision. You can use these steps without an AI account.

From the ForgeKit package or checkout root, run the following with Node, Git and Python 3 on your PATH.

```sh
node examples/workshop-planner/demo.mjs
```

The script makes a temporary project and private state directory. It runs ForgeKit's CLI, checks the resulting numbers independently and cleans up after printing a JSON receipt. Its temporary Git commit and claim IDs serve as locators during the run. Keep your real project's evidence commit if colleagues will need to resolve it later.

| Stage | Public command | Evidence |
| --- | --- | --- |
| Agree on the outcome | `forge agents run planner --task "Choose a workshop slot that fits every RSVP"` | A portable planning brief with its acceptance question |
| Divide research | `forge team "Choose a workshop slot" --brief streams.json --max-workers 2 --handoff generic --json` | Two read-only handoffs, their scopes, their acceptance checks and one named owner |
| Count demand | `forge sources aggregate workshop rsvps.csv sum --column attendees --group-by slot` | Morning 12, afternoon 15, four source rows |
| Check the rooms | `forge sources aggregate workshop rooms.csv sum --column seats --group-by slot` | Each room holds 14, from two source rows |
| Verify and keep the result | `forge reuse mint "Checked workshop seat plan for the frozen RSVP and capacity tables" --file checked-plan.json --ref git:COMMIT --json` | An independently checked worksheet, the exact input file hashes and a resolvable commit |
| Reopen a prior result | `forge reuse query "Checked workshop seat plan for the frozen RSVP and capacity tables" --json`; `forge ledger blame CLAIM_ID --json` | The matching artifact, its evidence type and its commit |

The morning leaves two spare seats. The afternoon is one seat short. The research exercise contains one passing and one rejected option. For a real workshop, record evidence of any additional requirements such as accessibility or venue availability in the acceptance worksheet.

A cached report can still exist after the RSVP file changes. The example fingerprints both source files in the acceptance receipt. A changed source requires new totals. Editing the cached report itself also turns its exact cache hit into a miss. The Git reference establishes which bytes were accepted. The independently checked counts establish whether those bytes answer this question. The example starts zero model workers. A study of production savings needs a consented, independently verified matched workload. [Paired pilot](../../reports/cost-eval.md#run-the-paired-pilot-locally)
