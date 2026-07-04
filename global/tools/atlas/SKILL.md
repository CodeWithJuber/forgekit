---
name: atlas
description: Forge's code-graph. Use to find where a symbol is defined (where-is-X), to discover reusable code before writing new, and to check a symbol actually exists before calling it (anti-hallucination). Backed by `forge atlas`.
---

# atlas — the code-graph

A precomputed, portable symbol index at `.forge/atlas.json`. Any tool reads it via
`forge atlas` or plain `jq` — no MCP required to consume.

## Use it
- `forge atlas build` — (re)build the index for this repo. Cheap; run once, and
  again after large changes.
- `forge atlas query <term>` — where is `<term>` defined? Returns file:line + kind.
  Prefer this over grep-and-read-files (far fewer tokens).
- `forge atlas has <symbol>` — is this symbol defined anywhere? Use before calling
  an unfamiliar function/class: "not found" is a strong hallucinated-API signal.

## When
- Reuse-first: before writing a helper, `forge atlas query` for an existing one.
- Verification: after generating code that calls project symbols, spot-check the
  unfamiliar ones with `forge atlas has`.

## Honest boundary
v1 indexes symbol *definitions* + membership, not a full call graph ("what calls
Z"). It flags likely-missing symbols; it does not certify correctness. The call
graph is the documented upgrade (LSP / serena-backed export).
