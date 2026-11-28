### Added

- **Team generations, `forge harness council generation status|propose|release <class>`.** This
  implements the recursive part of He et al., *Recursive Collective Intelligence*
  (arXiv 2611.32606): a team improves its next generation from its own verified work.
  - **The playbook.** A generation is a team playbook for one task class, distilled only from
    the class's verified `forward` runs. It keeps the roles that forwarded a fact, trims each
    budget to 1.25 × the most that role used (never above its parent's), and orders the hub by
    facts per token.
  - **Structure only.** A playbook holds no model-written prose, and it is deterministic.
  - **The release gate.** A candidate is released only on a fresh confirmation suite, and only
    if its paired gain clears 1.645·SE. With an independent pool, that gain is in the
    equal-budget margin.
  - **Health gates**, anchored at the parent: tokens at most 1.10 ×, no significant accuracy
    drop, no wrong packages.
  - **Flat rounds and the lineage.** A flat round keeps the parent. Each team is judged once,
    and the lineage records every round.
- **Delegations that follow a playbook.** A `forward` delegation can follow a playbook with
  `"playbook": "<hash>"|"current"`. The delegation record stores the playbook hash and each
  worker's budget.
