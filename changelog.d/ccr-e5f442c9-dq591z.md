### Added

- **Equal-budget ladder, `forge team ladder`** (He et al., *Recursive Collective Intelligence*,
  arXiv 2611.32606). It grades a team of agents against independent agents that spend the same
  completion tokens: beat one agent, then a compute-matched majority vote, then compute-matched
  pass@n. Each level is a one-sided paired t-test at α 0.025, clustered by question. A pool
  smaller than the budget leaves a level indeterminate, never claimed.
- **Shape trials judged on the ladder.** Give every frozen task a `pool` of independent run
  receipts, and a team shape is kept only when it beats the verified best-of-n its tokens would
  buy. A `group:` arm adds the delegation's worker usage to the lead's run. Trials without pools
  keep the earlier rule.
- **Information-aware teams.**
  - `forge team` deals evidence into disjoint per-role slices, and briefs every specialist to
    forward facts with sources, not opinions, to the lead hub.
  - The plan reports who holds a private fact.
  - A new `forward` delegation shape gives each worker a private `facts` slice and returns one
    deduplicated packet.
  - Shapes that hand every worker the same evidence pack now say so in an `information`
    advisory.

### Fixed

- Shape trials no longer keep a team that only beats a single baseline run. A team that solves
  what one agent fails, but no more than a best-of-n at the same tokens, is now reverted.
