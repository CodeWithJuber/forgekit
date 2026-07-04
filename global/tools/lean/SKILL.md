---
name: lean
description: Forge's minimalism discipline. Use for any "add X" / "build Y" / refactor / bug-fix — before writing code, to choose the smallest change that actually solves the problem. Reuse over rewrite, delete over add, boring over clever.
---

# lean — the smallest change that works

The best code is the code you never write; the second best already exists in this
repo. `lean` is a reflex applied AFTER you understand the problem, never instead of
understanding it.

## The Lean Path (stop at the first step that holds)
1. **Need?** Does this need to exist at all? Speculative "for later" → skip it and
   say so in one line. (YAGNI)
2. **Here already?** A util, component, type, or pattern that already lives in this
   repo → reuse or extend it. Look before you write.
3. **Platform / stdlib?** The language stdlib, a native platform feature, or an
   already-installed dependency covers it → use it. Never add a dependency for what
   a few lines do.
4. **One small change.** The smallest diff that fits the file's style. Fewest files.
   Boring over clever — clever is what someone decodes at 3am.
5. **Root, not symptom.** A report names a symptom. Fix it once in the shared
   function all callers route through — not in each caller.

## Rules
- No unrequested abstraction: no interface with one implementation, no factory for
  one product, no config for a value that never changes.
- Deletion over addition. The shortest working diff wins — once you understand what
  the change must touch. The smallest change in the wrong place is a second bug.
- Mark a deliberate shortcut with a comment naming its ceiling and upgrade path,
  e.g. `// lean: O(n^2) scan, index it if the list grows`.

## Never lean about (build the full thing)
Understanding the problem · input validation at trust boundaries · error handling
that prevents data loss · security · accessibility basics · anything explicitly
requested. Non-trivial logic (a branch, loop, parser, money/security path) ships
with ONE runnable check — the smallest thing that fails if the logic breaks.

## Output
Code first, then at most: "did X; skipped Y; add Y when Z." If the explanation is
longer than the code, delete the explanation.
