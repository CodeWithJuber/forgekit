# Forge — architecture & production plan

> Cross-tool configuration layer for agentic AI coding assistants. One source of
> truth, emitted natively into every tool; a small set of *enforced* guards; a
> lean discipline; a code-graph (`atlas`); cross-session memory (`recall`); and a
> token-budget cost governor. Install once (Claude plugin **or** installer **or**
> `forgekit` npm CLI). Near-zero learning curve.

Grounded in a verified multi-source research pass (Reddit/HN/dev.to, GitHub issue
trackers, official vendor docs). Evidence + config-format verdicts in the appendix.

The cognitive-substrate paper bundle is committed under
[`docs/cognitive-substrate/`](docs/cognitive-substrate/). It includes the full PDF/HTML
paper, deliverable overview, evidence map, ecosystem map, and the original prototype
packages; the production runtime remains Node-only and zero-dependency.

## Locked decisions
- **Brand = `Forge`** — CLI `forge`; layer names: skills→**tools**, agents→**crew**,
  hooks→**guards**, code-graph→**atlas**, minimalism→**lean**, memory→**recall**.
  Brand stored as **one token** (`brand.json` → `FORGE_BRAND`); rebrand = 1 edit.
- **Distributable id = `forgekit`** (npm package + marketplace id) — fixed even if
  the brand token changes, so a rename never breaks install.
- **Scope = full multi-tool day 1** (Claude Code, Codex, Cursor, Gemini, Aider,
  Copilot, Windsurf/Devin, Zed) via one canonical `AGENTS.md` source.
- **Install = all three channels** (plugin + hardened installer + npm CLI), all
  three pointing at the *same* tree ("one tree, three front doors").
- **Replace Ponytail + Graphify with our own** — as *thin layers over proven
  primitives*, not from-scratch reimplementations (reuse-first).

## The pains Forge answers (evidence-backed)

| # | Pain | Evidence | Forge's answer |
|---|------|----------|----------------|
| 1 | **Rules files acknowledged then ignored** (worse after compaction) | 10+ claude-code issues (#15443, #17530, #19635, #21112, #46724…), Cursor #2572; Cursor ignores rules ~1/3 of the time | Move enforceable invariants **out of prose into guards** (deterministic hooks the model can't drift from); keep prose rules short + single-sourced |
| 2 | **Token/cost blowups** (20–40k fixed overhead, loop/cache explosions) | claude-code #4095 (1.67B tokens/5h, est. $16k–50k, loop+recursive-hook root cause) | `cost` governor: statusline meter + budget guard with **re-entrancy locks**; every guard idempotent, single-shot |
| 3 | **Goldfish memory across sessions**; lossy compaction | claude-code #14227; "lost my 4-hour session" posts; 729-upvote demand thread | `recall`: file-based store (1 fact/file) + SessionStart load guard + Haiku consolidation crew; secrets refused |
| 4 | **Trust/verification gap** — polished code, nonexistent APIs | arXiv 2603.27249 (42% AI-authored, 96% don't fully trust, 48% review) *[secondhand]* | Shift leverage to verification: `crew` verifiers + `atlas` flags calls to symbols not in the graph. **Boundary: reduces review burden, does not certify correctness** |
| 5 | **Permission-prompt fatigue** | Cursor forum #46908/#67491; Claude permissions docs | Sane read-only allowlist out of the box (git status/diff, ls/cat/rg, test/lint/build); push/commit/merge stay on `ask`. No `--dangerously-skip` |
| 6 | **No single context file works across tools** | AGENTS.md is de-facto standard (LF AAIF, Dec 2025) but Claude reads only CLAUDE.md, Gemini only GEMINI.md | The **emitter**: author once in `AGENTS.md`, generate each tool's native target |
| 7 | **Skill/plugin loading fragile** (marketplace dup inflates skill count ~19×; hooks silently die) | claude-code #14549 (3,218 reported vs 169 real); hook fragility cluster (#10450, #16326, #46808…) | `forge doctor` health command (chezmoi-doctor pattern); Forge keeps its own footprint minimal + de-duped |
| 8 | **Onboarding is a research project** across fragmented marketplaces | best-in-class survey (awesome-claude-code, chezmoi, create-t3-app) | `forge init` one-command bootstrap + a "Start-Here" indexed catalog with one-line *why* + freshness |

## Architecture — a four-layer config compiler with ONE source

```
                       source/AGENTS.md  (canonical rules: git · testing · security · style)
                                │
                          forge sync  (emitter: content-hash + DO-NOT-EDIT headers)
        ┌───────────────┬───────┴───────┬───────────────┬─────────────┐
   Claude CLAUDE.md   Codex AGENTS.md  Cursor .mdc   Gemini settings  Aider .aider.conf.yml ...
   (@AGENTS.md import)  (native)        /AGENTS.md    (context.fileName)  (read: AGENTS.md)
```

Layers map onto the Claude Code substrate, brand-named, and are emitted cross-tool:

- **tools** (`~/.forge/tools/` → `~/.claude/skills/`) — model-invoked capabilities.
- **crew** (`~/.forge/crew/` → `~/.claude/agents/`) — sub-agents (scout/verifier/frontend-verifier).
- **guards** (`~/.forge/guards/` → `settings.json` hooks) — **the only layer that
  *enforces* rather than suggests.** This is the direct answer to pain #1: a guard
  can't be "forgotten" the way CLAUDE.md prose drifts.
- **mcp** — unchanged (it's a protocol). Forge ships `atlas` (+ optional `recall` query).

Cross-cutting: **atlas** (code-graph), **lean** (shipped as *both* a tool and a
Stop-guard, so it works whether or not the model invokes it), **recall** (memory).

**cognitive substrate** (`forge substrate`, `forge impact`, and MCP tools
`substrate_check` / `predict_impact` / `assumption_gate`) composes atlas, preflight,
route, scope, cortex, and verify into one pre-action contract before mutating work.

## Component map — the reuse ledger (30 components)

**Reuse (rename + swap brand token, logic unchanged):**
`tech-selector · reuse-first · dev-radar · code-modernization · explore-plan-code ·
cost-guard · ui-workflow · design-md · self-improve` (tools) · `scout · verifier ·
frontend-verifier` (crew) · `protect-paths · format-on-edit · recall-load ·
session-learner` (guards) · `statusline` · `tech-currency · stack-notes ·
self-correction` (rules) · project-layer template.

**Own-branded replacements (thin layer over proven primitive):**
- **`lean`** — *replaces Ponytail.* A model-invoked **tool** (YAGNI ladder,
  reuse-before-build, shortest-diff) **+** a deterministic **`lean-guard`** Stop-hook
  that nudges on oversized diffs. No plugin, no engine.
- **`atlas`** — *replaces Graphify.* Built on **serena/LSP** (already installed) +
  tree-sitter fallback; see resolution below.

**Net-new (justified by a pain):**
- **`forge sync`** (emitter, pain #6) · **`forge doctor`** (health, pain #7) ·
  **`forge init`** (bootstrap, pain #8) · **`cost-budget` guard** (pain #2) ·
  **Start-Here catalog** (pain #8) · **`recall`** unified subsystem (pain #3, from
  memory-keeper + memory-load + learn-consolidate).

## `atlas` resolution (dedicated tech-selector)
Build on **serena (LSP), already installed** — not a new graph engine. tree-sitter
only as the AST/chunking fallback for files with no language server.
- `forge atlas build [path]` → LSP symbol/ref queries → **portable artifact**
  `.forge/atlas.db` (SQLite) or `.forge/atlas.json`.
- `forge atlas query "what calls Z"` → reads the artifact directly (few hundred
  tokens vs. reading 5 files). `forge atlas update [files]` → incremental.
- **Cross-tool by design:** Codex/Cursor/Gemini/Aider read the artifact via the CLI
  or plain `jq`/SQLite — **no MCP dependency to consume**. MCP server is optional,
  lazy-started, for Claude convenience only.
- Rejected: stack-graphs (GitHub *archived* 2025-09-09), SCIP (near-zero adoption),
  embeddings (answers "similar" not "what calls Z"), ctags/ripgrep-as-index (no
  semantic resolution), cloning Graphify's tree-sitter+NetworkX internals.

## Verified cross-tool emit matrix
*(All rows confirmed against vendor docs in the research pass.)*

| Tool | Native target | How Forge emits |
|------|---------------|-----------------|
| **Claude Code** | `CLAUDE.md` (+ `.claude/rules/*.md`, `settings.json`); **no** AGENTS.md | Thin `CLAUDE.md` whose first line is `@AGENTS.md`; guards+permissions → `settings.json` |
| **Codex** | `AGENTS.md` native (32 KiB cap) | Canonical `AGENTS.md` at root **is** the source; keep < 32 KiB or it silently truncates |
| **Cursor** | `AGENTS.md` + `.cursor/rules/*.mdc` (`.cursorrules` deprecated) | `AGENTS.md` for flat rules; `.mdc` when scoping/precedence needed; never leave a legacy `.cursorrules` |
| **Gemini CLI** | `GEMINI.md` by default; **AGENTS.md only via `context.fileName` opt-in** | Write `.gemini/settings.json` `context.fileName:["AGENTS.md",…]` (avoids a 2nd copy) |
| **Aider** | `CONVENTIONS.md` via `read:` in `.aider.conf.yml` | Emit `.aider.conf.yml` with `read: AGENTS.md` |
| **Copilot** | root `AGENTS.md` (since 2025-08-28) + `.github/copilot-instructions.md` | Rely on root `AGENTS.md`; optional generated `.github` pointer |
| **Windsurf/Devin** | `AGENTS.md` auto-discovered; caps 6k/12k chars; mid-rebrand to Devin | Root `AGENTS.md` under caps; detect `.windsurf` vs `.devin` at init |
| **Zed** | first match of a precedence list incl. `AGENTS.md` | Emit `AGENTS.md` + doctor flags any earlier-precedence legacy file shadowing it |

## Repo layout — one tree, three front doors
```
forgekit/
  package.json            # npm CLI: bin `forge` → src/cli.js
  brand.json              # single FORGE_BRAND token + layer-name map
  README.md               # Start-Here index + one bootstrap command
  src/
    cli.js                # init | sync | doctor | taste | learn-consolidate | brand
    sync.js               # emitter (source → per-tool targets); hash + DO-NOT-EDIT
    doctor.js             # health checks
    emit/                 # one module per tool (claude, codex, cursor, gemini, aider, copilot, windsurf, zed)
  source/
    AGENTS.md             # THE canonical source
    rules/                # git.md, testing.md, security.md, style.md → assembled
  global/                 # installs into ~/.forge, symlinked into ~/.claude
    tools/ crew/ guards/ mcp/atlas/ recall/ lean/ statusline.sh settings.template.json
  templates/project-layer/  # per-repo template (was hostlelo-project-layer)
  plugin/                 # plugin.json + marketplace.json → point at global/ (no dup)
  install.sh              # hardened: idempotent, symlink, backup, no curl|sh
  bin/                    # back-compat shims → src/cli.js
```
plugin.json, install.sh, and the npm bin **all reference `global/` + `source/`** —
no duplication; each channel just runs `forge sync` at the end. A test asserts all
three resolve to `global/`.

## Build phases (each = a shippable slice, with a runnable exit check)

| Phase | Deliverables | Exit check |
|-------|-------------|------------|
| **0. Repo + brand spine** | git init; `brand.json` one-token; rename to `forgekit/`; `forge` bin stub | `forge --version` prints brand+version; grep proves brand defined once |
| **1. Emitter** | `source/AGENTS.md` from fragments; `sync.js` + all 8 emit modules; hash headers | `forge sync` in a fixture emits every target; idempotent re-run; golden-file tests pass |
| **2. Install + doctor** | hardened `install.sh`; `plugin.json`+`marketplace.json`; `forge doctor` | fresh-machine sim → doctor all-green; `npm pack` exposes `forge`; plugin loads w/o inflating skill count |
| **3. Guards** | rebranded protect-paths/format/recall-load; `cost-budget` w/ lock; `lean-guard`; session-learner gate | guard harness: blocks `.env` write; lock prevents re-entry; fires from subdir + worktree; settings validates |
| **4. lean + recall + crew** | `lean` tool; unified `recall`; rebranded crew | recall: write→new-session load→consolidate dedupes; secret write refused; verifier runs diff-scoped |
| **5. atlas** | serena/LSP-backed `atlas` build/query/update; portable artifact; hallucinated-symbol flag; lazy MCP | indexes a sample repo; nonexistent symbol → not-found; reuse-first consumes atlas; MCP responds |
| **6. Onboarding polish** | `forge init` wizard + active-summary; Start-Here catalog; docs | clean-env `forge init` → working in one command; catalog lists every item w/ one-line why; smoke test needs no external doc |

## Risks & honest boundaries
- **Enforcement ceiling** — guards enforce only what's expressible as a hook (paths,
  format, diff-size, budget). Semantic rules ("prefer functional") stay prose and
  *will* sometimes be ignored. Forge **reduces, doesn't eliminate** pain #1. Say so.
- **No weight-level learning** — `recall`/`self-improve` are file+prompt memory only.
  No RL, no fine-tuning. Consolidation is a Haiku summarizer that can hallucinate →
  advisory, human-reviewable, secret-free.
- **Hook fragility is upstream** — Windows/worktree/long-session hook failures affect
  Forge guards too. Mitigate with defensive path resolution + doctor; inherit the ceiling.
- **Char caps** — Codex 32 KiB, Windsurf 6k/12k, marketplace budget truncation →
  `forge sync` enforces a source size budget.
- **Own atlas+lean = new maintenance surface** previously outsourced. Scope atlas to
  the minimum graph that powers reuse + hallucination-flag, not a code-intel product.
- **Three channels triple drift surface** — mitigated by "one tree" + the resolve test.

## Open decisions → recommended resolutions
| Decision | Recommendation |
|----------|----------------|
| atlas: existing indexer vs hand-roll | **serena/LSP** (resolved by tech-selector) |
| Gemini: 2nd copy vs settings opt-in | **settings `context.fileName` opt-in** |
| Windsurf `.windsurf` vs `.devin` | **detect at init + confirm** |
| recall consolidation cadence | **opt-in Stop-hook**, optional `forge learn-consolidate` cron |
| cost-budget: block vs warn | **warn** (blocking re-creates permission fatigue) |
| atlas MCP always-on vs lazy | **lazy-start** |
| convert semantic rules → guards | **incrementally**, only where a deterministic check is clean |

---
*Appendix: config-format verdicts confirmed against vendor docs; single/secondhand
stats (Cursor "1/3 ignore", arXiv 42/96/48) flagged and not hardcoded into user copy.*
