---
name: handoff
description: End-of-session checkpoint. Use when finishing, pausing, or switching away from work in a repo — it rewrites the bounded session snapshot (.forge/state.md) the NEXT session is re-injected with, so nothing essential dies with this conversation. Backed by `forge handoff`.
---

# handoff — persist what this session knows

Session memory is volatile; `.forge/state.md` is the committed-brain checkpoint the
SessionStart hook re-injects. Rewritten every time (bounded ≤150 lines), never appended —
the next session reads a snapshot, not an archive.

## When
- Ending or pausing a work session, or before a risky context switch.
- The completion gate blocked with "no doc or state artifact moved" — this satisfies it.

## Do
1. Gather: what got DONE (with why it matters), what comes NEXT, what BIT you
   (gotchas: failed approaches, env quirks, traps), acceptance criteria still open.
2. Run it:

   ```bash
   forge handoff "<done row>" "<done row 2>" \
     --next "<next step>" --gotcha "<trap>" --criteria "<open check>"
   ```

   In-progress git files and recorded assumptions are gathered automatically.
3. Durable, non-obvious choices graduate to the decision log:
   `forge decide "<decision> — <reason>"`.

## Rules
- Specific beats complete: "verify() times out on pyproject repos without pytest" is a
  gotcha; "be careful with tests" is noise.
- Secrets are refused at write — store pointers, never values.
