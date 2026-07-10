---
name: sync-docs
description: After ANY code change, sweep the diff for documentation that just went stale. Use when finishing an edit, before a commit/PR, or when the completion gate blocks — it turns "did I forget a doc?" into a mechanical checklist. Backed by `forge docs sync`.
---

# sync-docs — make every artifact true again

A code change isn't done while prose still describes the old behavior. The sweep is
mechanical: diff → identifiers (paths, definitions, called symbols — added AND removed)
→ every doc artifact is scanned and answers one of three ways.

## Do
1. Run the sweep:

   ```bash
   forge docs sync            # human report; --json for tooling; --base <ref> to widen
   ```

2. Read the verdicts:
   - **STALE** — the doc mentions a changed identifier (each hit cited `file:line`).
     Open it, update the mention to match reality — or say explicitly why it's fine.
   - **UPDATED** — the doc already moved with this diff. Nothing owed.
   - **VERIFIED-UNAFFECTED** — zero mentions; the reason is recorded. Checked, not assumed.
3. Re-run until STALE is empty (or every remaining hit is justified out loud).
4. CHANGELOG is exempt by design (append-only history) — add a NEW entry for
   user-facing changes instead of editing old ones.

## Rules
- Never mark a doc unaffected by assumption — that's exactly what the sweep verifies.
- Big diff? Delegate this whole loop to the `doc-sync` agent to keep your context clean.
